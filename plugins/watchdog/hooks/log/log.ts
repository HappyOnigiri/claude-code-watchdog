import { LOG_RECORD_CAP, RAW_PROMPT_CAP } from '../constants';
import { requestCost, turnCost } from '../prices';
import type { Watchdog } from '../agents/roster';
import type { DeliveryState, HeldNote } from '../note/notes';
import type { ModelUsage, PluginState, TurnCompleteInput, TurnUsage } from 'claude-code';

// §13.4: one record of the review log (its shape is the `log` key of the state contract).
export type LogRecord = PluginState['watchdog']['log'][number];

export type ReviewRecord = Extract<LogRecord, { kind: 'review' }>;

type LogNote = ReviewRecord['notes'][number];

// §15: the requests a review agent's `turn.step` results reported: their token counts and prices summed; `cost`
// is null once one ran a model with no price.
type StepRequests = { readonly usage: ModelUsage; readonly cost: number | null };

// What the mod saw of one review agent while it ran: its `turn.step` count (§12.1), its admitted notes, the
// error of its outcome (§12.4), and its requests (§15), absent while no step reported usage. A hot reload loses
// the requests of before it; `reviewCost` then finds that they do not add up to the turn.
export type ReviewTrace = {
  readonly steps: number;
  readonly notes: readonly LogNote[];
  readonly error: string | null;
  readonly requests?: StepRequests;
};

// §13.4: the full prompt of one review, for `/watchdog dump raw`.
export type ReviewPrompt = { readonly watchdog: string; readonly prompt: string };

// §13.4: the newest records stay.
export const appendLog = (log: readonly LogRecord[], record: LogRecord): readonly LogRecord[] =>
  [...log, record].slice(-LOG_RECORD_CAP);

export const errorRecord = (input: { watchdog: string; time: number; error: string }): LogRecord => ({
  kind: 'error',
  ...input,
});

// §7.5: the updates of one watchdog's backlog that a `-p` run left unreviewed.
export const unreviewedRecord = (input: { watchdog: string; time: number; updates: number }): LogRecord => ({
  kind: 'unreviewed',
  ...input,
});

// §7.8 action 6: a review that timed out.
export const timeoutRecord = (input: { watchdog: string; agentId: string | null; time: number }): LogRecord => ({
  kind: 'timeout',
  ...input,
});

const isSameTokens = (a: ModelUsage, b: ModelUsage): boolean =>
  a.input_tokens === b.input_tokens &&
  a.output_tokens === b.output_tokens &&
  a.cache_read_input_tokens === b.cache_read_input_tokens &&
  a.cache_creation_input_tokens === b.cache_creation_input_tokens;

// §15: a review costs what its turn's summed usage tells. Where the sum tells no tier, it costs its requests'
// prices, only when the steps reported every request: their token counts add up to the turn's.
const reviewCost = (usage: TurnUsage, trace: ReviewTrace): number | null => {
  const cost = turnCost(usage);
  if (cost !== null || trace.requests === undefined || !isSameTokens(trace.requests.usage, usage)) {
    return cost;
  }
  return trace.requests.cost;
};

// §13.4: one finished review. §12.2: the model that ran is `usage.model`, else the roster's. §12.3 item 10: a
// refusal keeps its category.
export const reviewRecord = (input: {
  watchdog: Watchdog;
  agentId: string;
  time: number;
  end: TurnCompleteInput;
  trace: ReviewTrace;
  subagent?: ReviewRecord['subagent'];
}): ReviewRecord => {
  const { watchdog, end, trace } = input;
  const usage = end.usage;
  return {
    kind: 'review',
    watchdog: watchdog.name,
    agentId: input.agentId,
    time: input.time,
    model: usage?.model ?? watchdog.model,
    effort: watchdog.effort,
    reason: end.reason,
    steps: trace.steps,
    answerLength: end.answer.length,
    answer: end.answer,
    usage:
      usage === undefined
        ? null
        : {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_input_tokens: usage.cache_read_input_tokens,
            cache_creation_input_tokens: usage.cache_creation_input_tokens,
            model: usage.model,
          },
    cost: usage === undefined ? null : reviewCost(usage, trace),
    notes: trace.notes,
    error: trace.error,
    refusal: end.reason === 'refusal' ? end.refusal.category : null,
    ...(input.subagent === undefined ? {} : { subagent: input.subagent }),
  };
};

const EMPTY_TRACE: ReviewTrace = { steps: 0, notes: [], error: null };

const NO_TOKENS: ModelUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

// The live log and the last prompts are module memory; `$.state` key `log` keeps a copy of the log
// (§14.1). A reload loses the prompts (§13.4).
const memory: { log: readonly LogRecord[]; prompts: readonly ReviewPrompt[] } = { log: [], prompts: [] };
const traces = new Map<string, ReviewTrace>();

export const currentLog = (): readonly LogRecord[] => memory.log;

export const addLogRecord = (record: LogRecord): void => {
  memory.log = appendLog(memory.log, record);
};

// §14.6: at load the records of before the reload come back from `$.state`, before any of this instance.
export const restoreLog = (records: readonly LogRecord[]): void => {
  memory.log = [...records, ...memory.log].slice(-LOG_RECORD_CAP);
};

// §10.8, §13.4: a retracted note shows its new state and the retraction's reason in the record of the review that
// sent it, while the log keeps that record, or in its trace while that review runs.
export const markLoggedNote = (
  agentId: string,
  text: string,
  change: { readonly delivery: DeliveryState; readonly reason: string }
): void => {
  const mark = (notes: readonly LogNote[]): LogNote[] =>
    notes.map((note) => (note.text === text ? { ...note, ...change } : note));
  memory.log = memory.log.map((record) =>
    record.kind === 'review' && record.agentId === agentId ? { ...record, notes: mark(record.notes) } : record
  );
  const trace = traces.get(agentId);
  if (trace !== undefined) {
    traces.set(agentId, { ...trace, notes: mark(trace.notes) });
  }
};

export const recentPrompts = (): readonly ReviewPrompt[] => memory.prompts;

export const rememberPrompt = (prompt: ReviewPrompt): void => {
  memory.prompts = [...memory.prompts, prompt].slice(-RAW_PROMPT_CAP);
};

export const traceOf = (agentId: string): ReviewTrace => traces.get(agentId) ?? EMPTY_TRACE;

export const countStep = (agentId: string): void => {
  const trace = traceOf(agentId);
  traces.set(agentId, { ...trace, steps: trace.steps + 1 });
};

// §15: one request of a review agent, as its `turn.step` result reported its usage.
export const traceStepUsage = (agentId: string, usage: TurnUsage): void => {
  const trace = traceOf(agentId);
  const before = trace.requests ?? { usage: NO_TOKENS, cost: 0 };
  const cost = requestCost(usage);
  const requests: StepRequests = {
    usage: {
      input_tokens: before.usage.input_tokens + usage.input_tokens,
      output_tokens: before.usage.output_tokens + usage.output_tokens,
      cache_read_input_tokens: before.usage.cache_read_input_tokens + usage.cache_read_input_tokens,
      cache_creation_input_tokens: before.usage.cache_creation_input_tokens + usage.cache_creation_input_tokens,
    },
    cost: before.cost === null || cost === null ? null : before.cost + cost,
  };
  traces.set(agentId, { ...trace, requests });
};

export const traceNote = (note: HeldNote): void => {
  const trace = traceOf(note.agentId);
  const logged = { severity: note.severity, text: note.text, delivery: note.delivery };
  traces.set(note.agentId, { ...trace, notes: [...trace.notes, logged] });
};

// §12.4: the error of a review's outcome goes to its record.
export const traceError = (agentId: string, error: string): void => {
  traces.set(agentId, { ...traceOf(agentId), error });
};

// A review's end takes its trace; the agent never runs again.
export const takeTrace = (agentId: string): ReviewTrace => {
  const trace = traceOf(agentId);
  traces.delete(agentId);
  return trace;
};
