import { describe, expect, test } from 'claude-code/testing';
import { PERSON_PROMPT, stubDelivery } from './fixtures/delivery';
import { ABSORBED_ROW, QUEUED_SUBMIT } from './fixtures/engine/queued-prompt';
import { START, mainRow, turnEnd, typed } from './fixtures/session';
import type { DeliveryStubs } from './fixtures/delivery';
import type { WorkspaceFile } from './fixtures/session';
import type { SessionAppendInput } from 'claude-code';
import type { Engine } from 'claude-code/testing';

const PROJECT_FILE = '/repo/WATCHDOG.json';

const roster = (reviewMode: 'turn' | 'agent-end', reviewInterval = 1): Record<string, WorkspaceFile> => ({
  [PROJECT_FILE]: { text: JSON.stringify({ watchdogs: [{ name: 'a', reviewMode, reviewInterval }] }), mtimeMs: 1 },
});

// The kit's `session.append` rejects on 2.1.290 and accepts on 2.1.293: catch it, after the hooks saw the row.
const append = async ($: Engine, row: SessionAppendInput): Promise<void> => {
  await $.session.append(row).catch(() => undefined);
};

const startOn = async ($: Engine): Promise<void> => {
  await $.session.start(START);
  await $.command.run(typed('on'));
};

const SECOND_SUBMIT = { ...QUEUED_SUBMIT, text: 'Reply with exactly Q2=BRAVO. Do not use tools.' };

// Turn t1 with one row, and the given person prompts typed over it.
const queuedTurn = async ($: Engine, submits = [QUEUED_SUBMIT]): Promise<void> => {
  await $.turn.start({ text: 'Fix the date parser.', turnId: 't1' });
  await append($, mainRow('u1', 'user', 'Fix the date parser.'));
  await submits.reduce(async (done, submit) => {
    await done;
    await $.prompt.submit(submit);
  }, Promise.resolve());
  await append($, mainRow('a1', 'assistant', 'Fixed the parser.'));
};

// The engine runs queued prompts: each one's `prompt` row enters, then the turn starts (live probe on 2.1.310).
const runQueued = async ($: Engine, turnId: string, texts: string[]): Promise<void> => {
  await texts.reduce(async (done, text, i) => {
    await done;
    await append($, mainRow(`${turnId}-u${i}`, 'user', text));
  }, Promise.resolve());
  await $.turn.start({ text: texts.at(-1) ?? '', turnId });
};

describe('agent-end and queued prompts (§7.4)', () => {
  test('a turn end with a queued prompt behind it waits; the queued turn end reviews both', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on, { files: roster('agent-end') });
    await startOn($);
    await queuedTurn($);
    await $.turn.complete(turnEnd('t1'));
    expect(seen.spawns.length).toBe(0);

    await runQueued($, 't2', [QUEUED_SUBMIT.text]);
    await append($, mainRow('a2', 'assistant', 'Q1=ALPHA'));
    await $.turn.complete(turnEnd('t2'));
    expect(seen.spawns.length).toBe(1);
    expect(seen.spawns[0]?.prompt).toContain('Fixed the parser.');
    expect(seen.spawns[0]?.prompt).toContain('Q1=ALPHA');
  });

  test('two queued prompts that run one turn each: only the last turn end reviews', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on, { files: roster('agent-end') });
    await startOn($);
    await queuedTurn($, [QUEUED_SUBMIT, SECOND_SUBMIT]);
    await $.turn.complete(turnEnd('t1'));
    await runQueued($, 't2', [QUEUED_SUBMIT.text]);
    await $.turn.complete(turnEnd('t2'));
    expect(seen.spawns.length).toBe(0);

    await runQueued($, 't3', [SECOND_SUBMIT.text]);
    await $.turn.complete(turnEnd('t3'));
    expect(seen.spawns.length).toBe(1);
  });

  test('two queued prompts that run in one turn: that turn end reviews', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on, { files: roster('agent-end') });
    await startOn($);
    await queuedTurn($, [QUEUED_SUBMIT, SECOND_SUBMIT]);
    await $.turn.complete(turnEnd('t1'));
    await runQueued($, 't2', [QUEUED_SUBMIT.text, SECOND_SUBMIT.text]);
    await $.turn.complete(turnEnd('t2'));
    expect(seen.spawns.length).toBe(1);
  });

  test('a queued prompt that the turn took in leaves the queue: the turn end reviews', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on, { files: roster('agent-end') });
    await startOn($);
    await queuedTurn($);
    await append($, ABSORBED_ROW);
    await $.turn.complete(turnEnd('t1'));
    expect(seen.spawns.length).toBe(1);
  });

  test('an Esc with a queued prompt: the queued turn starts first, and its end reviews', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on, { files: roster('agent-end') });
    await startOn($);
    await queuedTurn($);
    await runQueued($, 't2', [QUEUED_SUBMIT.text]);
    await $.turn.complete({ ...turnEnd('t1'), reason: 'aborted', isAborted: true });
    expect(seen.spawns.length).toBe(0);

    await $.turn.complete(turnEnd('t2'));
    expect(seen.spawns.length).toBe(1);
  });

  test('a person prompt into the idle session pays the turn end that no queued turn paid', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on, { files: roster('agent-end') });
    await startOn($);
    await queuedTurn($);
    await $.turn.complete(turnEnd('t1'));
    expect(seen.spawns.length).toBe(0);

    await $.prompt.submit(PERSON_PROMPT);
    expect(seen.spawns.length).toBe(1);
    expect(seen.spawns[0]?.prompt).toContain('Fixed the parser.');
  });

  test('reviewInterval 2: the turns of one queue count as one update', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on, { files: roster('agent-end', 2) });
    await startOn($);
    await queuedTurn($);
    await $.turn.complete(turnEnd('t1'));
    await runQueued($, 't2', [QUEUED_SUBMIT.text]);
    await $.turn.complete(turnEnd('t2'));
    expect(seen.spawns.length).toBe(0);

    await $.turn.start({ text: 'Next task.', turnId: 't3' });
    await append($, mainRow('u3', 'user', 'Next task.'));
    await $.turn.complete(turnEnd('t3'));
    expect(seen.spawns.length).toBe(1);
  });

  test('turn mode reviews at a turn end with a queued prompt behind it', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on, { files: roster('turn') });
    await startOn($);
    await queuedTurn($);
    await $.turn.complete(turnEnd('t1'));
    expect(seen.spawns.length).toBe(1);
  });
});
