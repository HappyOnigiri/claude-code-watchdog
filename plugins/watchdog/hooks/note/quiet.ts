// `hideNudgedNotes`: a note that goes to Claude by a nudge shows only in the nudge prompt. It writes no `$.ui.log`
// row and no band card while it is `nudge pending` or `nudged`, and its retraction writes no row. Pure: the note area
// skips the rows, and the band area draws only the cards that show and writes the rows that come due. `hideUi`: no
// note writes a row, and none comes due.
import { cardKey } from '../band/cards';
import { heldNotes, logRow } from './notes';
import type { DeliveryState, HeldNote } from './notes';

const QUIET_DELIVERIES: readonly DeliveryState[] = ['nudge pending', 'nudged'];

// Whether nudged notes are hidden; the card key and watchdog name of each note whose row was skipped; the rows of
// those that left the nudge route undelivered, to write. Module memory alone: a hot reload resets it, so a note
// skipped before the reload writes no row if it leaves the nudge route after it. Each person prompt and
// `/watchdog off` keep only the skipped notes still held (`pruneSkipped`); `/clear`, `/resume`, `/branch` and a rewind
// leave the rest until the next person prompt.
const memory: { isOn: boolean; isUiHidden: boolean; skipped: Map<string, string>; due: string[] } = {
  isOn: true,
  isUiHidden: false,
  skipped: new Map(),
  due: [],
};

// The option is on unless it is `false`, so an absent or bad value keeps the default.
export const setHideNudged = (value: unknown): void => {
  memory.isOn = value !== false;
};

// `hideUi`: the option is off unless it is `true`, so an absent or bad value keeps the default.
export const setHideUi = (value: unknown): void => {
  memory.isUiHidden = value === true;
};

export const isUiHidden = (): boolean => memory.isUiHidden;

// A card keeps its delivery state as a plain string (the `band` key of the state contract).
export const isQuiet = (delivery: string): boolean =>
  memory.isOn && QUIET_DELIVERIES.some((quiet) => quiet === delivery);

// Whether a note in this delivery state writes no row.
export const isRowHidden = (delivery: string): boolean => memory.isUiHidden || isQuiet(delivery);

// A note whose row the note area skipped; under `hideUi` its row never comes due.
export const skipRow = (note: HeldNote, name: string): void => {
  if (memory.isUiHidden) {
    return;
  }
  memory.skipped.set(cardKey(note), name);
};

// A note that leaves the held list undelivered (displaced, retracted) never writes its row.
export const forgetSkipped = (key: string): void => {
  memory.skipped.delete(key);
};

// A held-note watcher: a skipped note that leaves the nudge route by another route (a steer, `held`, an aside)
// writes its row in its new state. A nudged one stays skipped: a refused nudge holds it again (§10.3).
export const watchSkipped = (before: HeldNote | undefined, after: HeldNote): void => {
  const key = cardKey(before ?? after);
  const name = memory.skipped.get(key);
  if (name === undefined || isQuiet(after.delivery)) {
    return;
  }
  memory.skipped.delete(key);
  memory.due.push(logRow(after, name));
};

// A skipped note that is no longer held (nudged, or gone with the held list) never writes its row.
export const pruneSkipped = (): void => {
  const held = new Set(heldNotes().map(cardKey));
  [...memory.skipped.keys()]
    .filter((key) => !held.has(key))
    .forEach((key) => {
      memory.skipped.delete(key);
    });
};

// The rows that came due, oldest first; they leave the list.
export const takeDueRows = (): string[] => memory.due.splice(0);
