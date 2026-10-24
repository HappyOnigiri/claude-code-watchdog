import { QUEUED_PROMPT_CAP, RUNNING_TURN_CAP } from '../constants';
import { contentText } from './text';
import type { SessionAppendInput } from 'claude-code';

// §7.4: the person prompts queued behind a running main turn, by their text as typed, and the main turns that run.
// The engine takes a queued prompt into the running turn at its next tool result (an attachment `queued_command`
// that quotes the text), or runs it after the turn's end: its `prompt` row enters, then a turn starts, with the
// other queued prompts or one by one; after an Esc the queued turn starts before the aborted turn ends (live probe
// on 2.1.310, release-queue.mjs). Module memory only: a hot reload empties it, and the turn ends after it review as
// before; `/clear`, `/resume`, `/branch` and `/watchdog off` keep it, since a prompt into an idle session empties
// the queue and each turn leaves at its end.
const memory: { queued: readonly string[]; running: readonly string[] } = { queued: [], running: [] };

export const queuePrompt = (text: string): void => {
  memory.queued = [...memory.queued, text].slice(-QUEUED_PROMPT_CAP);
};

// A person prompt into an idle session: no prompt waits in the queue any more.
export const emptyQueue = (): void => {
  memory.queued = [];
};

// A main-loop `prompt` row, or a `queued_command` row: each queued prompt whose text it holds left the queue. The
// origin is not checked, since `-p` may stamp a prompt's row `unclassified`; a row of another prompt only ends a
// wait early.
export const dequeuePrompts = (e: SessionAppendInput): void => {
  if (e.agentId !== undefined || (e.door !== 'prompt' && e.message.name !== 'queued_command')) {
    return;
  }
  const row = contentText(e.message.content);
  memory.queued = memory.queued.filter((text) => !row.includes(text));
};

export const startMainTurn = (turnId: string): void => {
  memory.running = [...memory.running, turnId].slice(-RUNNING_TURN_CAP);
};

export const endMainTurn = (turnId: string): void => {
  memory.running = memory.running.filter((running) => running !== turnId);
};

// Whether another main turn follows the main turn `turnId` at its end: a person prompt still waits in the queue,
// or a queued turn started already (an Esc).
export const isTurnFollowed = (turnId: string): boolean =>
  memory.queued.length > 0 || memory.running.some((running) => running !== turnId);
