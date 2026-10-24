import { currentRoster } from '../agents/roster';
import { currentTurn } from '../delivery/turns';
import { currentMode } from '../lifecycle/mode';
import { isInteractiveSession } from '../lifecycle/on-order';
import { watchHeldNotes } from '../note/notes';
import { isQuiet, pruneSkipped, setHideNudged, takeDueRows } from '../note/quiet';
import { isPersonPrompt } from '../person';
import { EMPTY_BAND, bandState, changeCard, clearCards, restoreBand, toggleCard } from './cards';
import { troubleLine } from './problems';
import { bandTree } from './tree';
import type { OnEvents } from '../on';
import type { Band } from './cards';
import type { Trouble } from './problems';
import type { EngineInterface, Hook, MatchedHook, PluginOptions, PluginState, RenderElement } from 'claude-code';

type BandHook = MatchedHook<'ui.render', { component: 'AbovePrompt' }>;

type Health = PluginState['watchdog']['health'];

// The band value this module instance last wrote to `$.state`, as JSON; whether it read the band back (§14.6).
const memory: { written: string | undefined; isLoaded: boolean } = { written: undefined, isLoaded: false };

// `hideEmptyBand`: whether an empty band draws nothing. The option is off unless it is `true`, so an absent or bad
// value keeps the default. A change to it reloads the mod and sets it again.
const settings: { isEmptyHidden: boolean } = { isEmptyHidden: false };

// §13.1: a `$.state` write draws the band again; only a band that changed is written.
const writeBand = async ($: EngineInterface): Promise<void> => {
  const band = bandState(currentTurn());
  const json = JSON.stringify(band);
  if (json === memory.written) {
    return;
  }
  memory.written = json;
  await $.state.set({ plugin: 'watchdog', key: 'band' }, band).catch(() => {
    memory.written = undefined;
  });
};

// `hideNudgedNotes`: the row of a hidden note that left the nudge route undelivered (a steer, `held`, an aside) is
// written with the band. A route that a timer changed (a refused nudge) writes at the next of these hooks.
const writeBandAndRows = async ($: EngineInterface): Promise<void> => {
  takeDueRows().forEach((row) => {
    $.ui.log(row);
  });
  await writeBand($);
};

// The note hook and the delivery hooks beneath change the cards and the routes; each of these hooks writes the band
// and the rows that came due after them.
const afterTool: Hook<'tool.call'> = async ($, e, next) => {
  const result = await next(e);
  await writeBandAndRows($);
  return result;
};

const afterTurnStart: Hook<'turn.start'> = async ($, e, next) => {
  const result = await next(e);
  await writeBandAndRows($);
  return result;
};

const afterTurnComplete: Hook<'turn.complete'> = async ($, e, next) => {
  const result = await next(e);
  await writeBandAndRows($);
  return result;
};

// §13.1: a person prompt clears the cards; the count line then shows no open note.
const onPrompt: Hook<'prompt.submit'> = async ($, e, next) => {
  if (isPersonPrompt(e.origin)) {
    clearCards();
    pruneSkipped();
  }
  const result = await next(e);
  await writeBandAndRows($);
  return result;
};

// §5.2 step 2: `/watchdog off` clears the cards.
const afterCommand: Hook<'command.run'> = async ($, e, next) => {
  const result = await next(e);
  if (currentMode() === 'off') {
    clearCards();
    pruneSkipped();
  }
  // §13.2: a row from a `command.run` hook would land above the command echo; the rows that came due wait.
  await writeBand($);
  return result;
};

// §13.1: a press on a card's Button expands or collapses it beneath, in its `onPress`; the band is written after.
const afterPress: Hook<'ui.press'> = async ($, e, next) => {
  const result = await next(e);
  await writeBand($);
  return result;
};

// §14.6: at module load the cards come back from `$.state`, so a reload keeps the band.
const onSessionStart: Hook<'session.start'> = async ($, e, next) => {
  const result = await next(e);
  if (!memory.isLoaded) {
    memory.isLoaded = true;
    const stored = await $.state.get({ plugin: 'watchdog', key: 'band' }).catch(() => undefined);
    restoreBand(stored?.value ?? EMPTY_BAND);
    memory.written = JSON.stringify(stored?.value ?? EMPTY_BAND);
  }
  return result;
};

// §12.5: the watchdogs of the roster in a problem state, as `$.state` key `health` keeps them.
const troubles = (health: Health | undefined): Trouble[] =>
  currentRoster().flatMap(({ name, slug }) => {
    const problem = health?.watchdogs[slug]?.problem ?? null;
    return problem === null ? [] : [{ name, problem }];
  });

// §12.5: the failure line while on; the clock is read only for a halt's next try.
const troubleText = async ($: EngineInterface, health: Health | undefined, columns: number) => {
  const found = troubles(health);
  const isHalted = found.some(({ problem }) => problem.state === 'halted');
  const now = isHalted ? await $.clock.now() : 0;
  return troubleLine(found, { now, columns, isAlone: currentRoster().length === 1 });
};

// `hideNudgedNotes`: a card whose note goes by a nudge stays in the band (its note stays open for a retraction, §10.8)
// but is not drawn; an expanded one draws collapsed.
const shownBand = (band: Band): Band => {
  const cards = band.cards.filter((card) => !isQuiet(card.delivery));
  return { ...band, cards, expanded: cards.some((card) => card.key === band.expanded) ? band.expanded : null };
};

// §13.1: the `$.state` keys the band draws. Reading them subscribes the band, so each write draws it again.
const readKeys = async ($: EngineInterface) => {
  const on = await $.state.get({ plugin: 'watchdog', key: 'on' }).catch(() => undefined);
  const band = await $.state.get({ plugin: 'watchdog', key: 'band' }).catch(() => undefined);
  const health = await $.state.get({ plugin: 'watchdog', key: 'health' }).catch(() => undefined);
  const isOn = on?.value?.isOn;
  return { isOn, band: shownBand(band?.value ?? EMPTY_BAND), health: isOn === true ? health?.value : undefined };
};

// §13.1: the band reads its keys first, also in a session it does not draw, so that a write that comes before
// the session start of a reload draws it. It yields to a survey, and draws nothing in a headless session (§10.6).
const onBand: BandHook = async ($, e, next) => {
  if (e.props.hasSurvey) {
    return next(e);
  }
  const base: RenderElement = await next(e);
  const { isOn, band, health } = await readKeys($);
  if (!isInteractiveSession() || currentMode() === 'unsupported') {
    return base;
  }
  const columns = e.props.bodyColumns;
  const trouble = await troubleText($, health, columns);
  const el = $.ui.resolve(e);
  // §13.1: a collapsed card names its watchdog only when 2 or more watchdogs are enabled.
  const watchdogs = currentRoster().filter((watchdog) => watchdog.isEnabled).length;
  const tree = bandTree(el, {
    isOn,
    band,
    trouble,
    isEmptyHidden: settings.isEmptyHidden,
    columns,
    watchdogs,
    onToggle: toggleCard,
  });
  if (tree === undefined) {
    return base;
  }
  // §13.1: no row above the divider. The engine draws its `[-]` on the band's first row, so the divider holds it in
  // each state.
  return el.Box({ key: 'watchdog-band', flexDirection: 'column', children: [base, tree] });
};

// Install first, so that these hooks sit above the note, delivery and command hooks that change the cards.
// The matchers only tell these `on()` from the other areas'.
export const installBand = (
  on: OnEvents<
    | 'tool.call'
    | 'turn.start'
    | 'turn.complete'
    | 'prompt.submit'
    | 'command.run'
    | 'session.start'
    | 'ui.render'
    | 'ui.press'
  >,
  options: PluginOptions
): void => {
  setHideNudged(options.hideNudgedNotes);
  settings.isEmptyHidden = options.hideEmptyBand === true;
  watchHeldNotes(changeCard);
  on('tool.call', { tool: /./u }, afterTool);
  on('turn.start', { turnId: /^/u }, afterTurnStart);
  on('turn.complete', { answer: /^/u }, afterTurnComplete);
  on('prompt.submit', { origin: { kind: /./u } }, onPrompt);
  on('command.run', { command: /^watchdog$/u }, afterCommand);
  on('session.start', { cwd: /./u }, onSessionStart);
  on('ui.render', { component: 'AbovePrompt' }, onBand);
  on('ui.press', { plugin: 'watchdog', element: /^watchdog-expand-/u }, afterPress);
};
