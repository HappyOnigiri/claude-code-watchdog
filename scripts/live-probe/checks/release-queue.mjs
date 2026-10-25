// §7.4 release probes of the prompt queue that `reviewMode: "agent-end"` reads (plugins/watchdog/hooks/feed/queue.ts):
// a prompt queued over a reply enters as a prompt row before its turn, a prompt typed during the tool calls is taken
// into the running turn as a `queued_command` row, and an Esc starts the queued turn before the aborted turn ends.
// The plugin does not break when a fact changes (a prompt that never starts a turn is reviewed at the next person
// prompt), so each check is advisory. The mod rd-queued logs the fields the observer leaves out.
import path from 'node:path';
import { sleep } from '../lib/env.mjs';
import { pluginDirs } from '../lib/headless.mjs';
import { createRun, readJsonLines } from '../lib/run.mjs';
import { BUSY, startTui } from '../lib/tui.mjs';
import { clip, fail, inconclusive, pass } from '../lib/verdict.mjs';

// A reply long enough to type two prompts into, a tool run long enough to type into, and the prompts typed over them.
const LONG_REPLY = 'Do not use tools. Write the integers from 1 to 3000, one number per line, and nothing else.';
const READS =
  'Use the Read tool on part1.txt, then part2.txt, then part3.txt, then part4.txt, then part5.txt, then ' +
  'part6.txt, one call per message, never in parallel. Then reply with exactly READS=DONE.';
const FIRST = 'Reply with exactly Q1=ALPHA. Do not use tools.';
const SECOND = 'Reply with exactly Q2=BRAVO. Do not use tools.';
const ABSORB = 'Also add the line ABSORB=CHARLIE at the very end of your final reply.';
const ESCQ = 'Reply with exactly ESCQ=ECHO. Do not use tools.';
const TUI_DENY = 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Agent';

// Polls `test` twice a second until it holds or `timeoutMs` passes; resolves its last value.
const until = async (test, timeoutMs) => {
  const begin = Date.now();
  while (!test() && Date.now() - begin < timeoutMs) {
    await sleep(500);
  }
  return test();
};

const rowsOf = (rows, kind, test = () => true) => rows.filter((row) => row.kind === kind && test(row));
const has = (mark) => (row) => String(row.text ?? row.answer ?? '').includes(mark);

// One TUI session, three steps in order; each waits for its turns to end, so no step's model work overlaps the next.
const rdQueued = {
  id: 'rd-queued',
  title: 'TUI: two prompts queued over a reply, a prompt typed during tool calls, an Esc with a queued prompt',
  needs: ['tui'],
  run: async (ctx) => {
    const run = createRun(ctx, 'rd-queued');
    const file = path.join(run.logs, 'rd-queued.jsonl');
    const rows = () => readJsonLines(file);
    const ends = () => rowsOf(rows(), 'complete').length;
    const tui = await startTui(run, {
      label: 'tui',
      plugins: pluginDirs(run, { watchdog: false, mods: ['rd-queued'] }),
      args: ['--disallowedTools', TUI_DENY],
    });
    const steps = {};
    try {
      await tui.type(LONG_REPLY);
      steps.mergeBusy = (await tui.waitFor(BUSY, { timeoutMs: 30_000, intervalMs: 250 })).ok;
      await tui.type(FIRST);
      await tui.type(SECOND);
      await until(() => ends() >= 2, 120_000);
      await tui.waitIdle({ timeoutMs: 60_000 });
      const beforeReads = ends();
      await tui.type(READS);
      steps.toolResult = await until(
        () => rowsOf(rows(), 'append', (row) => row.door === 'tool-result').length > 0,
        60_000
      );
      await tui.type(ABSORB);
      await until(() => ends() > beforeReads, 180_000);
      await tui.waitIdle({ timeoutMs: 120_000 });
      await sleep(2000);
      const beforeEsc = ends();
      await tui.type(LONG_REPLY);
      steps.escBusy = (await tui.waitFor(BUSY, { timeoutMs: 30_000, intervalMs: 250 })).ok;
      await tui.type(ESCQ);
      await sleep(300);
      await tui.keys('Escape');
      await until(() => ends() >= beforeEsc + 2, 60_000);
      await tui.waitIdle({ timeoutMs: 60_000 });
      tui.capture('after-esc');
      return { run, steps, rows: rows() };
    } finally {
      await tui.stop();
    }
  },
};

// Two prompts typed over one reply carry its turn id. After the reply each one enters as a main `prompt` row, and a
// turn that runs it starts after that row: the plugin takes a prompt out of the queue at its row. The engine runs
// them in one turn or one by one; the evidence names which.
const verifyDequeue = (obs) => {
  const rows = obs.rows ?? [];
  const submits = [FIRST, SECOND].map((mark) => rowsOf(rows, 'submit', has(mark))[0]);
  const replyEnd = rowsOf(rows, 'complete', (row) => row.turnId === submits[0]?.turnId)[0];
  const after = (row) => replyEnd && row.t >= replyEnd.t;
  const prompts = [FIRST, SECOND].map(
    (mark) => rowsOf(rows, 'append', (row) => row.door === 'prompt' && has(mark)(row) && after(row))[0]
  );
  const starts = rowsOf(rows, 'start', (row) => after(row) && (has('Q1=ALPHA')(row) || has('Q2=BRAVO')(row)));
  const isStartedAfter = (prompt) => prompt && starts.some((start) => start.t >= prompt.t);
  const evidence = [
    `submits with a turn id ${submits.map((row) => row?.turnId ?? 'none').join(', ')}`,
    `prompt rows after the reply ${prompts.map((row) => (row ? row.t - replyEnd.t : 'none')).join(', ')} ms`,
    `queued turns ${starts.length}: ${clip(starts.map((row) => row.text).join(' | '), 200)}`,
  ];
  if (!obs.steps?.mergeBusy || submits.some((row) => !row?.turnId) || submits[0].turnId !== submits[1].turnId) {
    return inconclusive([...evidence, 'the two prompts were not both sent while the first reply ran']);
  }
  return prompts.every(isStartedAfter)
    ? pass([...evidence, 'each queued prompt entered as a prompt row before the turn that ran it'])
    : fail([...evidence, 'a queued prompt ran without its prompt row first']);
};

// A prompt typed during the tool calls goes into the running turn as a main `queued_command` row that quotes it.
const verifyAbsorb = (obs) => {
  const rows = obs.rows ?? [];
  const submit = rowsOf(rows, 'submit', has(ABSORB))[0];
  const row = rowsOf(rows, 'append', (item) => item.name === 'queued_command' && has(ABSORB)(item))[0];
  const ownTurn = rowsOf(rows, 'start', has(ABSORB))[0];
  const evidence = [
    `submit turn id ${submit?.turnId ?? 'none'}, wait ${submit?.wait ?? '?'}`,
    `queued_command row ${row ? `door ${row.door}, origin ${row.origin}` : 'none'}`,
    `own turn ${Boolean(ownTurn)}`,
  ];
  if (!obs.steps?.toolResult || !submit) {
    return inconclusive([...evidence, 'the prompt was not typed during the tool calls']);
  }
  return submit.turnId && row && !ownTurn
    ? pass([...evidence, 'the running turn took the prompt in as a queued_command row'])
    : fail([...evidence, 'the prompt was not taken in as a queued_command row']);
};

// An Esc with a prompt queued: the queued turn starts, and the aborted turn's end comes after that start.
const verifyEsc = (obs) => {
  const rows = obs.rows ?? [];
  const start = rowsOf(rows, 'start', has(ESCQ))[0];
  const aborted = rowsOf(rows, 'complete', (row) => row.isAborted)[0];
  const evidence = [
    `queued turn start ${start ? start.t : 'none'}, aborted end ${aborted ? aborted.t : 'none'}`,
    `aborted turn ${aborted?.turnId ?? 'none'}`,
  ];
  if (!obs.steps?.escBusy || !aborted) {
    return inconclusive([...evidence, 'the Esc did not abort a running reply']);
  }
  return start && start.t <= aborted.t
    ? pass([...evidence, 'the queued turn started before the aborted turn ended'])
    : fail([...evidence, start ? 'the aborted turn ended before the queued turn started' : 'no queued turn ran']);
};

export const scenarios = [rdQueued];

export const checks = [
  {
    id: 'rd-queued-dequeue',
    title: 'Each prompt queued over a reply enters as a prompt row before the turn that runs it',
    source: '§7.4: agent-end and queued prompts',
    kind: 'advisory',
    scenario: 'rd-queued',
    verify: verifyDequeue,
  },
  {
    id: 'rd-queued-absorb',
    title: 'A prompt typed during tool calls goes into the running turn as a queued_command row',
    source: '§7.4: agent-end and queued prompts',
    kind: 'advisory',
    scenario: 'rd-queued',
    verify: verifyAbsorb,
  },
  {
    id: 'rd-queued-esc',
    title: 'An Esc with a queued prompt starts the queued turn before the aborted turn ends',
    source: '§7.4: agent-end and queued prompts',
    kind: 'advisory',
    scenario: 'rd-queued',
    verify: verifyEsc,
  },
];
