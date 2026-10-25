// A person prompt typed over a running main turn, and the row of a queued prompt that the turn took in (spec §7.4).
// Recorded by the live probe on 2.1.310: run release-queue, scenario rd-queued. Source: the rd-queued mod's
// logs/rd-queued.jsonl (it logs `prompt.submit`'s `turnId` and `wait` and a row's `name`, which the observer leaves
// out) and the observer record of the row. The submit is step 1, the row step 2, after the next tool result. A
// queued prompt that runs after the turn enters as a `prompt` row of the shape `mainRow` makes. Scrubbed: the turn
// id and the row uuid; the row quotes the submit's text in place of the step 2 prompt.
import type { PromptSubmitInput, SessionAppendInput } from 'claude-code';

export const QUEUED_TEXT = 'Reply with exactly Q1=ALPHA. Do not use tools.';

// The submit at Enter, with the id of the turn that runs. Its prompt waits for the turn's end, then runs in a next
// turn, with the other prompts that wait or on its own.
export const QUEUED_SUBMIT = {
  text: QUEUED_TEXT,
  turnId: 't1',
  wait: false,
  origin: { kind: 'composer' },
} satisfies PromptSubmitInput;

// The row of a queued prompt that the running turn took in at its next tool result; no turn of its own follows.
export const ABSORBED_ROW = {
  uuid: 'c0000000-0000-4000-8000-000000000002',
  door: 'delivery',
  origin: { kind: 'composer' },
  message: {
    type: 'attachment',
    name: 'queued_command',
    content: [
      {
        type: 'text',
        text: `<system-reminder>\nThe user sent a new message while you were working:\n${QUEUED_TEXT}\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.\n</system-reminder>`,
      },
    ],
  },
} satisfies SessionAppendInput;
