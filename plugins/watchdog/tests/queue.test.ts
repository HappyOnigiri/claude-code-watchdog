import { describe, expect, test } from 'claude-code/testing';
import {
  dequeuePrompts,
  emptyQueue,
  endMainTurn,
  isTurnFollowed,
  queuePrompt,
  startMainTurn,
} from '../hooks/feed/queue';
import { ABSORBED_ROW, QUEUED_TEXT } from './fixtures/engine/queued-prompt';
import { mainRow } from './fixtures/session';

// The queue is module memory: each test starts from an empty one.
const reset = (...running: string[]): void => {
  emptyQueue();
  running.forEach(endMainTurn);
};

describe('the prompt queue of agent-end (§7.4)', () => {
  test('a queued prompt follows the turn until its prompt row enters', () => {
    reset('t1', 't2');
    queuePrompt(QUEUED_TEXT);
    expect(isTurnFollowed('t1')).toBe(true);
    dequeuePrompts(mainRow('u2', 'user', 'Another prompt.'));
    expect(isTurnFollowed('t1')).toBe(true);
    dequeuePrompts(mainRow('u2', 'user', QUEUED_TEXT));
    expect(isTurnFollowed('t1')).toBe(false);
  });

  test('a queued_command row that quotes the prompt takes it out', () => {
    reset('t1', 't2');
    queuePrompt(QUEUED_TEXT);
    dequeuePrompts(ABSORBED_ROW);
    expect(isTurnFollowed('t1')).toBe(false);
  });

  test("a subagent's row takes no prompt out", () => {
    reset('t1', 't2');
    queuePrompt(QUEUED_TEXT);
    dequeuePrompts({ ...mainRow('u2', 'user', QUEUED_TEXT), agentId: 'asub0001' });
    expect(isTurnFollowed('t1')).toBe(true);
  });

  test('a person prompt into an idle session empties the queue', () => {
    reset('t1', 't2');
    queuePrompt(QUEUED_TEXT);
    emptyQueue();
    expect(isTurnFollowed('t1')).toBe(false);
  });

  test('another main turn that runs follows the turn, until its own end', () => {
    reset('t1', 't2');
    startMainTurn('t1');
    startMainTurn('t2');
    expect(isTurnFollowed('t1')).toBe(true);
    endMainTurn('t1');
    expect(isTurnFollowed('t2')).toBe(false);
  });
});
