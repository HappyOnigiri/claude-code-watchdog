import { ownContext } from '../agents/ids';
import { isOwnRow } from '../agents/self-review';
import { currentMode } from '../lifecycle/mode';
import { isPersonPrompt } from '../person';
import { currentFeed, recordRow, setFeed } from './feed';
import { dequeuePrompts, emptyQueue, endMainTurn, queuePrompt, startMainTurn } from './queue';
import type { OnEvents } from '../on';
import type { EngineInterface, Hook, PromptOrigin } from 'claude-code';

// §10: a person prompt is known by its `prompt.submit` origin. The engine appends the prompt's row while the
// submit runs, and in `-p` it stamps that row `unclassified` though the submit says `sdk` (live probe
// l3-headless-prompt). So a `prompt` row that enters during a person submit takes the submit's origin.
const memory: { submitting: PromptOrigin | undefined } = { submitting: undefined };

// §7.1: `$.state` keeps the feed. The live copy is module memory, so a refused write (a value over
// 4,194,304 characters of JSON) loses only what a reload would carry over.
const saveFeed = async ($: EngineInterface): Promise<void> => {
  await $.state.set({ plugin: 'watchdog', key: 'feed' }, currentFeed()).catch(() => undefined);
};

// §7.1: while on, each main-loop row enters the feed rendered (§7.6), except the watchdog's own rows (§7.3).
// A row with an `agentId` never enters the primary agent's feed. The row is kept before `next(e)`, which
// the hook relays. §7.4: a main `prompt` or `queued_command` row takes its prompts out of the queue, on or off.
const onAppend: Hook<'session.append'> = async ($, e, next) => {
  dequeuePrompts(e);
  const isRecorded = currentMode() === 'on' && e.agentId === undefined && !isOwnRow(e, ownContext());
  if (isRecorded) {
    const { submitting } = memory;
    setFeed(
      recordRow(currentFeed(), e.door === 'prompt' && submitting !== undefined ? { ...e, origin: submitting } : e)
    );
  }
  const result = await next(e);
  if (isRecorded) {
    await saveFeed($);
  }
  return result;
};

// §7.4: a person prompt typed over a running main turn carries that turn's id and waits in the queue, on or off;
// one into an idle session finds the queue empty. A slash command and a dropped prompt start no turn of the model.
const onPersonPrompt: Hook<'prompt.submit'> = async (_$, e, next) => {
  if (!isPersonPrompt(e.origin)) {
    return next(e);
  }
  memory.submitting = e.origin;
  const result = await next(e).finally(() => {
    memory.submitting = undefined;
  });
  if (e.turnId === undefined) {
    emptyQueue();
  } else if (e.command === undefined && result.drop === undefined) {
    queuePrompt(e.text);
  }
  return result;
};

// §7.4: the main turns that run, for the queue: a turn leaves at its end. The review area beneath reads the others.
const onTurnStart: Hook<'turn.start'> = async (_$, e, next) => {
  if (e.agentId === undefined) {
    startMainTurn(e.turnId);
  }
  return next(e);
};

const onTurnEnd: Hook<'turn.complete'> = async (_$, e, next) => {
  if (e.agentId === undefined) {
    endMainTurn(e.turnId);
  }
  return next(e);
};

export const installFeed = (
  on: OnEvents<'session.append' | 'prompt.submit' | 'turn.start' | 'turn.complete'>
): void => {
  on('session.append', onAppend);
  on('prompt.submit', { origin: { kind: /./u } }, onPersonPrompt);
  on('turn.start', { turnId: /^/u }, onTurnStart);
  on('turn.complete', { turnId: /^/u }, onTurnEnd);
};
