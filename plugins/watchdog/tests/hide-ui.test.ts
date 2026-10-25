import { describe, expect, test } from 'claude-code/testing';
import { PERSON_PROMPT, nudgeTurnText, sendNote, startReview, stubDelivery, wrapped } from './fixtures/delivery';
import { REVIEW_AGENT, USAGE, turnEnd, HIDE_UI } from './fixtures/session';
import type { DeliverySeen, DeliveryStubs } from './fixtures/delivery';
import type { Engine } from 'claude-code/testing';

const CONCERN = 'parseDate drops the timezone';
const BLOCKER = 'The migration deletes the users table';
const NIT = 'formatDate has an unused parameter';
const UNSAFE_ROW = 'watchdog: dropped a note with a destructive command';

const personTurn = async ($: Engine, turnId: string): Promise<void> => {
  await $.prompt.submit(PERSON_PROMPT);
  await $.turn.start({ text: PERSON_PROMPT.text, turnId });
};

const reviewEnd = async ($: Engine): Promise<void> => {
  await $.turn.complete({ ...turnEnd('r1'), agentId: REVIEW_AGENT, usage: USAGE });
};

const nudges = (seen: DeliverySeen): string[] =>
  seen.prompts.filter((prompt) => prompt.text.startsWith('<watchdog-notes>')).map((prompt) => prompt.text);

// The rows the mod wrote with a `watchdog:` note row's `[severity]` lead.
const noteRows = (seen: DeliverySeen): string[] => seen.logs.filter((row) => /^\[(?:nit|concern|blocker)/u.test(row));

describe('hideUi', () => {
  test(
    'a steered note writes no row and still goes to Claude by the nudge after the turn',
    HIDE_UI,
    async ($, on: DeliveryStubs) => {
      const seen = stubDelivery(on);
      await startReview($);
      await personTurn($, 't1');
      await sendNote($, 'concern', CONCERN);
      await $.turn.complete(turnEnd('t1'));
      await sendNote($, 'blocker', BLOCKER);
      await seen.clock.advance(2000);
      expect(nudges(seen)).toEqual([
        wrapped(`<note severity="concern">${CONCERN}</note>`, `<note severity="blocker">${BLOCKER}</note>`),
      ]);
      expect(noteRows(seen)).toEqual([]);
    }
  );

  test(
    'an aside and a held note write no row and still go with the next person prompt',
    HIDE_UI,
    async ($, on: DeliveryStubs) => {
      const seen = stubDelivery(on);
      await startReview($);
      await personTurn($, 't1');
      await sendNote($, 'concern', CONCERN);
      await $.turn.complete({ ...turnEnd('t1'), reason: 'aborted', isAborted: true });
      await sendNote($, 'nit', NIT);
      await sendNote($, 'blocker', BLOCKER);
      await reviewEnd($);
      await seen.clock.advance(2000);
      expect(nudges(seen)).toEqual([]);

      await $.prompt.submit(PERSON_PROMPT);
      expect(seen.prompts.at(-1)?.context).toEqual([
        wrapped(
          `<note severity="concern">${CONCERN}</note>`,
          `<note severity="nit">${NIT}</note>`,
          `<note severity="blocker">${BLOCKER}</note>`
        ),
      ]);
      expect(noteRows(seen)).toEqual([]);
    }
  );

  test('a nudged note writes no row, and the nudge turn text is unchanged', HIDE_UI, async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on);
    await startReview($);
    await personTurn($, 't1');
    await $.turn.complete(turnEnd('t1'));
    await sendNote($, 'concern', CONCERN);
    await reviewEnd($);
    await seen.clock.advance(2000);
    const nudge = nudges(seen).at(-1) ?? '';
    expect(nudge).toBe(wrapped(`<note severity="concern">${CONCERN}</note>`));
    await $.turn.start({ text: nudgeTurnText(nudge), turnId: 'n1' });
    await $.turn.complete(turnEnd('n1'));
    expect(noteRows(seen)).toEqual([]);
  });

  test('the row of a note dropped for a destructive command still shows', HIDE_UI, async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on);
    await startReview($);
    const logsBefore = seen.logs.length;
    await sendNote($, 'concern', 'Run rm -rf build/ before the next try.');
    await sendNote($, 'nit', NIT);
    expect(seen.logs.slice(logsBefore)).toEqual([UNSAFE_ROW]);
  });

  test('the row of a refused store write still shows', HIDE_UI, async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on, { storeSetDeny: 'store is over 4 MiB' });
    await startReview($);
    await sendNote($, 'nit', NIT);
    expect(seen.logs.filter((row) => row.includes(' not saved: '))).toHaveLength(1);
    expect(noteRows(seen)).toEqual([]);
  });
});
