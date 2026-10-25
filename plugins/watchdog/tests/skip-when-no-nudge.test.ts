import { describe, expect, test } from 'claude-code/testing';
import { isSkippedForNoNudge } from '../hooks/review/backlogs';
import { PERSON_PROMPT, REVIEW_SPAWN, nudgeTurnText, stubDelivery } from './fixtures/delivery';
import { HEADLESS_SUBMIT } from './fixtures/engine/headless-prompt';
import {
  HEADLESS_START,
  HOME,
  START,
  USAGE,
  mainRow,
  reviewAgentId,
  subagentId,
  turnEnd,
  typed,
} from './fixtures/session';
import type { Routing } from '../hooks/delivery/nudge';
import type { DeliverySeen, DeliveryStubs } from './fixtures/delivery';
import type { WorkspaceFile } from './fixtures/session';
import type { AgentSpawnInput, SessionAppendInput, TurnStepInput } from 'claude-code';
import type { Engine } from 'claude-code/testing';

const PROJECT_FILE = '/repo/WATCHDOG.json';

type Entry = { reviewMode?: 'turn' | 'agent-end'; skipWhenNoNudge?: boolean };

const roster = (entry: Entry, subagents: Record<string, true> = {}): Record<string, WorkspaceFile> => ({
  [PROJECT_FILE]: { text: JSON.stringify({ watchdogs: [{ name: 'a', ...entry }], subagents }), mtimeMs: 1 },
});

const SKIP = roster({ reviewMode: 'agent-end', skipWhenNoNudge: true });

const CART = '/repo/cart.py';
const CONCERN = 'parseDate drops the timezone';
const BLOCKER = 'apply_discount subtracts the percent as an amount.';

// The engine's `agent.spawn` of a subagent that the primary agent's `Agent` call starts.
const EXPLORE: AgentSpawnInput = {
  tool_use_id: 'toolu_01HxWq8tYbGk2Lm4Np6Rs0001',
  prompt: 'Find where the auth token is parsed.',
  description: 'explore auth',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-4-5',
  background: true,
  fork: false,
};

const SUB = subagentId(EXPLORE.tool_use_id);

const append = async ($: Engine, row: SessionAppendInput): Promise<void> => {
  await $.session.append(row).catch(() => undefined);
};

const step = async ($: Engine, e: TurnStepInput): Promise<void> => {
  const stream = $.turn.step(e);
  for await (const chunk of stream) {
    expect(chunk).toBeDefined();
  }
  await stream.result;
};

const startOn = async ($: Engine): Promise<void> => {
  await $.session.start(START);
  await $.command.run(typed('on'));
};

// One person turn with one row; the test ends it.
const personTurn = async ($: Engine, turnId: string, row = mainRow(`u-${turnId}`, 'user', `Prompt of ${turnId}.`)) => {
  await $.prompt.submit(PERSON_PROMPT);
  await $.turn.start({ text: PERSON_PROMPT.text, turnId });
  await append($, row);
};

const escEnd = (turnId: string) => ({ ...turnEnd(turnId), reason: 'aborted', isAborted: true }) as const;

// The prompts of the mod's review spawns, oldest first (not the engine's `agent.spawn` the test fires).
const reviews = (seen: DeliverySeen): string[] =>
  seen.spawns
    .filter((spawn) => spawn.subagentType.startsWith('watchdog:') && spawn.prompt !== REVIEW_SPAWN.prompt)
    .map((spawn) => spawn.prompt);

const nudges = (seen: DeliverySeen): string[] =>
  seen.prompts.filter((prompt) => prompt.text.startsWith('<watchdog-notes>')).map((prompt) => prompt.text);

// The engine's `agent.spawn` of review `n` of the watchdog `a`: each review gets its own agent.
const learnReview = async ($: Engine, n: number): Promise<string> => {
  const toolUse = `toolu_plugin_0000000000000000000000000000000${n}`;
  await $.agent.spawn({
    ...REVIEW_SPAWN,
    tool_use_id: toolUse,
    description: 'watchdog a review',
    subagentType: 'watchdog:a',
  });
  return reviewAgentId(toolUse);
};

const note = async ($: Engine, agentId: string, sent: { severity: string; text: string }): Promise<void> => {
  await $.tool.call({ tool: 'mcp__watchdog__note', agentId, note: sent.text, severity: sent.severity });
};

const reviewEnd = async ($: Engine, agentId: string): Promise<void> => {
  await $.turn.complete({ ...turnEnd(`end-${agentId}`), agentId, usage: USAGE });
};

// The engine starts and ends the turn of the newest nudge.
const nudgeTurn = async ($: Engine, seen: DeliverySeen, turnId: string): Promise<void> => {
  await $.turn.start({ text: nudgeTurnText(nudges(seen).at(-1) ?? ''), turnId });
  await append($, mainRow(`a-${turnId}`, 'assistant', `Answer of ${turnId}.`));
  await $.turn.complete(turnEnd(turnId));
};

// Turn t1 ends and review 1 sends a late concern; its nudge turn n1 runs and ends. At the end of n1 the concern
// budget is spent and the cooldown runs.
const spendConcernNudge = async ($: Engine, seen: DeliverySeen): Promise<void> => {
  await startOn($);
  await personTurn($, 't1');
  await $.turn.complete(turnEnd('t1'));
  const first = await learnReview($, 1);
  await note($, first, { severity: 'concern', text: CONCERN });
  await reviewEnd($, first);
  await seen.clock.advance(2000);
  expect(nudges(seen)).toHaveLength(1);
  await nudgeTurn($, seen, 'n1');
};

// The primary agent's `Edit` call on `path`, as one response row.
const editRow = (uuid: string, path: string): SessionAppendInput => ({
  ...mainRow(uuid, 'assistant', ''),
  message: {
    type: 'assistant',
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: `toolu_${uuid}`,
        name: 'Edit',
        input: { file_path: path, old_string: 'a', new_string: 'b' },
      },
    ],
  },
});

// The main loop is idle after turn 4, no nudge went out since the person prompt, and the cooldown is 3 turns.
const IDLE: Routing = {
  turn: 4,
  isTurnRunning: false,
  isAfterEsc: false,
  nudges: 0,
  blockerNudges: 0,
  nudgeTurn: null,
  immuneTurns: 3,
  isHeadless: false,
  isNitNudged: false,
};

const ON = { reviewMode: 'agent-end', isSkippedWhenNoNudge: true } as const;

describe('isSkippedForNoNudge (§7.4, §10.3, §10.4)', () => {
  test('a turn end of the primary agent waits after Esc, with the concern budget spent, and in the cooldown', () => {
    expect(isSkippedForNoNudge(ON, undefined, { ...IDLE, isAfterEsc: true })).toBe(true);
    expect(isSkippedForNoNudge(ON, undefined, { ...IDLE, nudges: 1 })).toBe(true);
    expect(isSkippedForNoNudge(ON, undefined, { ...IDLE, nudgeTurn: 2 })).toBe(true);
  });

  test('it reviews while a concern can nudge, the blocker budget spent or the cooldown over', () => {
    expect(isSkippedForNoNudge(ON, undefined, IDLE)).toBe(false);
    expect(isSkippedForNoNudge(ON, undefined, { ...IDLE, blockerNudges: 2 })).toBe(false);
    expect(isSkippedForNoNudge(ON, undefined, { ...IDLE, nudgeTurn: 0 })).toBe(false);
  });

  test('a blocker that could still nudge does not make it review', () => {
    expect(isSkippedForNoNudge(ON, undefined, { ...IDLE, nudges: 1, blockerNudges: 0 })).toBe(true);
  });

  test('it never waits without the key, under turn, on a subagent, while a turn runs, or in a headless session', () => {
    const spent = { ...IDLE, nudges: 1 };
    expect(isSkippedForNoNudge({ ...ON, isSkippedWhenNoNudge: false }, undefined, spent)).toBe(false);
    expect(isSkippedForNoNudge({ ...ON, reviewMode: 'turn' }, undefined, spent)).toBe(false);
    expect(isSkippedForNoNudge(ON, 'asub0001', spent)).toBe(false);
    expect(isSkippedForNoNudge(ON, undefined, { ...spent, isTurnRunning: true })).toBe(false);
    expect(isSkippedForNoNudge(ON, undefined, { ...spent, isHeadless: true })).toBe(false);
  });
});

describe('skipWhenNoNudge: an agent-end review at a turn end waits while a concern could not nudge (§7.4, §10.3)', () => {
  test('with the concern budget left, the turn end reviews', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on, { files: SKIP });
    await startOn($);
    await personTurn($, 't1');
    await $.turn.complete(turnEnd('t1'));
    expect(reviews(seen)).toHaveLength(1);
    expect(reviews(seen)[0]).toContain('Prompt of t1.');
  });

  test('after Esc the turn end starts no review; the next step boundary starts it', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on, { files: SKIP });
    await startOn($);
    await personTurn($, 't1');
    await $.turn.complete(escEnd('t1'));
    expect(reviews(seen)).toEqual([]);

    await personTurn($, 't2');
    await step($, { turnId: 't2', index: 1, model: 'claude-opus-4-5', messageCount: 2 });
    expect(reviews(seen)).toHaveLength(1);
    expect(reviews(seen)[0]).toContain('Prompt of t1.');
  });

  test('after Esc, a person turn that calls no tool reviews at its end, both turns in one review', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on, { files: SKIP });
    await startOn($);
    await personTurn($, 't1');
    await $.turn.complete(escEnd('t1'));
    await personTurn($, 't2');
    await $.turn.complete(turnEnd('t2'));
    expect(reviews(seen)).toHaveLength(1);
    expect(reviews(seen)[0]).toContain('Prompt of t1.');
    expect(reviews(seen)[0]).toContain('Prompt of t2.');
  });

  test('without the key, the turn end after Esc reviews', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on, { files: roster({ reviewMode: 'agent-end' }) });
    await startOn($);
    await personTurn($, 't1');
    await $.turn.complete(escEnd('t1'));
    expect(reviews(seen)).toHaveLength(1);
  });

  test('with the concern budget spent, the end of the nudge turn starts no review', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on, { files: SKIP, isReviewIdPerSpawn: true });
    await spendConcernNudge($, seen);
    expect(reviews(seen)).toHaveLength(1);
  });

  test('in the cooldown a person turn end starts no review; the next step boundary reviews', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on, { files: SKIP, isReviewIdPerSpawn: true });
    await spendConcernNudge($, seen);
    // The person prompt gave the budget back; the cooldown of the nudge turn still runs.
    await personTurn($, 't2');
    await $.turn.complete(turnEnd('t2'));
    expect(reviews(seen)).toHaveLength(1);

    await personTurn($, 't3');
    await step($, { turnId: 't3', index: 1, model: 'claude-opus-4-5', messageCount: 2 });
    expect(reviews(seen)).toHaveLength(2);
    expect(reviews(seen)[1]).toContain('Answer of n1.');
    expect(reviews(seen)[1]).toContain('Prompt of t2.');
  });

  test('a watched subagent backlog still reviews at its end while the primary agent one waits', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on, {
      files: roster({ reviewMode: 'agent-end', skipWhenNoNudge: true }, { Explore: true }),
    });
    await startOn($);
    await $.turn.start({ text: 'Fix the login bug.', turnId: 't1' });
    await append($, mainRow('u1', 'user', 'Fix the login bug.'));
    await $.agent.spawn(EXPLORE);
    await append($, { ...mainRow('s1', 'assistant', 'Searching for the token parser.'), agentId: SUB });
    await $.turn.complete(escEnd('t1'));
    expect(reviews(seen)).toEqual([]);

    await $.turn.complete({ ...turnEnd('s1'), agentId: SUB });
    expect(reviews(seen)).toHaveLength(1);
    expect(reviews(seen)[0]).toContain('Searching for the token parser.');
    expect(reviews(seen)[0]).not.toContain('Fix the login bug.');
  });

  test('a headless session has no nudge, and the key does nothing there', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on, { files: SKIP, env: { HOME, CLAUDE_WATCHDOG: 'on' } });
    await $.session.start(HEADLESS_START);
    await $.prompt.submit({ ...HEADLESS_SUBMIT, text: 'Fix the parser.' });
    await $.turn.start({ text: 'Fix the parser.', turnId: 't1' });
    await append($, mainRow('u1', 'user', 'Fix the parser.'));
    await $.turn.complete(turnEnd('t1'));
    expect(reviews(seen)).toHaveLength(1);
  });

  test('an outdated late blocker does not wait for the review that waits: it nudges on the blocker budget', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on, { files: SKIP, isReviewIdPerSpawn: true });
    await startOn($);
    await personTurn($, 't1');
    await $.turn.complete(turnEnd('t1'));
    const first = await learnReview($, 1);
    await personTurn($, 't2', editRow('e1', CART));
    await note($, first, { severity: 'blocker', text: BLOCKER });
    await note($, first, { severity: 'concern', text: CONCERN });
    await $.turn.complete(turnEnd('t2'));
    // Review 1 still runs: the blocker waits for a review; the concern nudges alone.
    await seen.clock.advance(2000);
    expect(nudges(seen)).toHaveLength(1);
    expect(nudges(seen)[0]).not.toContain(BLOCKER);
    await nudgeTurn($, seen, 'n1');

    // Review 1 sent it, and the review of t2 waits for a nudge: the blocker goes.
    await reviewEnd($, first);
    await seen.clock.advance(2000);
    expect(reviews(seen)).toHaveLength(1);
    expect(nudges(seen)).toHaveLength(2);
    expect(nudges(seen)[1]).toContain(BLOCKER);
  });
});
