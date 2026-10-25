# Changelog

## 0.7.0 - 2026-10-25

- The new watchdog key `skipWhenNoNudge` (default `false`) saves the review of an `agent-end` watchdog that could
  not reach Claude before your next prompt. While a concern cannot nudge at the end of a turn (after Esc, once the
  nudge of concerns since your last prompt went out, or in the cooldown after a nudge turn), the watchdog skips that
  review and keeps it due. It runs at the first tool round of the next turn, so its notes reach Claude in that turn,
  or at a later turn end where a nudge can go. Reviews of watched subagents and `-p` runs work as before.

## 0.6.0 - 2026-10-25

- The new setting `hideUi` (default `false`) hides the watchdog while the session runs: no band above the prompt box,
  in any state, and no `watchdog:` line for a note or its retraction. Notes still reach Claude as before; a note that
  does not go by a nudge reaches Claude with your next prompt without showing to you, so use it with
  `nudgeNits: true`. Error and failure lines, the line of a note dropped for a destructive command, command output and
  `/watchdog status` still show.

## 0.5.1 - 2026-10-25

- A watchdog with `reviewMode: "agent-end"` now waits while you have a prompt queued for Claude. Before, it
  reviewed as soon as Claude replied, though the queued prompt started the next turn right away. It now reviews
  once, at the end of the last turn of the queue, with every turn in that review. A prompt that Claude takes in
  during its work, while it still uses tools, does not make it wait. When a queued prompt never starts a turn, the
  review runs at your next prompt.

## 0.5.0 - 2026-10-25

- The new setting `nudgeNits` (default `false`) sends a nit the way a concern goes: after Claude's next tool result
  while it works, or by a nudge after its reply. A nudge of nits takes the concern budget and waits out the same
  cooldown. Off, a nit still waits for your next prompt.

## 0.4.0 - 2026-10-25

- The new setting `hideEmptyBand` (default `false`) hides the band above the prompt box while it has no open note:
  no dotted line and no `watchdog · no open notes` line. A note that `hideNudgedNotes` hides counts as no note. The
  band still shows the failure line of a watchdog with a problem, and the `watchdog · off · /watchdog on` line.

## 0.3.0 - 2026-10-24

- A note that the plugin sends to Claude by a nudge now shows only in the nudge prompt. It writes no
  `watchdog: [...] … (nudge pending)` line and draws no card above the prompt box. When a later review retracts it, no
  `(dropped:superseded)` line shows either. Before, the same text showed in the line, in the nudge prompt and in the
  retraction line. A note that reaches Claude another way instead (a turn that starts before the nudge, or a refused
  nudge) writes its line in its new state; after a refused nudge, at the next turn, tool call or prompt. The new setting `hideNudgedNotes` (default `true`) turns this off.

## 0.2.5 - 2026-10-24

- `/watchdog status` and `/watchdog dump` show the cost of a review on Claude Haiku 5.5. Before, it showed `$?`.
  Haiku 5.5 charges each request by its prompt length, so the plugin now prices each request of a review on its
  own and adds them up. A review whose prompts add up to over 100,000 tokens shows `$?` when the plugin did not see
  each of its requests, for example after a reload while it ran.
- The cost of a review on Claude Sonnet 5.5 now prices cache reads at $0.10 per million tokens, as the pricing page
  says. Before, it used $0.20 and showed the cache reads at twice their cost.

## 0.2.4 - 2026-10-24

- `"model": "inherit"` in `WATCHDOG.json` now runs the watchdog on the session's model, as the configuration docs say.
  Before, the plugin dropped it with a warning and used `opus`. A watchdog on `inherit` makes no preflight call at
  `/watchdog on`, and a review takes whatever model the session gave as its own model, never as `no_model`.

## 0.2.3 - 2026-10-24

- A review now sees a tool argument that spans lines, such as a Bash heredoc or the content of a Write, as lines in
  a code block under the call, named by the argument. Before, it sat in the call's one-line JSON with each line break
  shown as `\n`.

## 0.2.2 - 2026-10-24

- Needs Claude Code 2.1.299 or later; below it the plugin shows `unsupported`. The band and the `/watchdog status`
  table draw bold text with the `weight` that 2.1.299 added, in place of `bold`, which it deprecated. Claude Code
  2.1.290 to 2.1.298 refuses `weight` and would draw neither.

## 0.2.1 - 2026-10-24

- Nudges work again on Claude Code 2.1.299 and later. These versions also report a review's own turn start, and the
  plugin took it for a turn of the agent you work with: a note that came after the reply waited for your next prompt,
  and `turns_ago` and the cooldown counted the reviews too.
- The plugin moved to the `matteoantoci-plugins` marketplace (`matteoantoci/claude-plugins`). The `matteoantoci`
  marketplace in this repo is gone. To move: `/plugin marketplace remove matteoantoci`, then
  `/plugin marketplace add matteoantoci/claude-plugins` and `/plugin install watchdog@matteoantoci-plugins`. Plugin
  options are stored per plugin id, so set `onByDefault` and `immuneTurns` again in `/plugin` (or pass
  `--config onByDefault=true` to `claude plugin install`).

## 0.2.0 - 2026-10-08

- Compact band: each card is one row with the note's first sentence and a dim status that shows only what waits. Click
  a card's `▸`, or press ctrl+x tab and its letter, to open the whole note. Esc gives the focus back to the prompt.
- Outdated mark: when Claude edited files after a review, the card says `outdated? N edits` and Claude reads the same
  mark with the note.
- Retraction: the next review of the same watchdog retracts a note that no longer holds. The card goes, and a note that
  waits never reaches Claude.
- Blocker nudges: blockers get 2 nudges of their own after each of your prompts, beside the 1 for concerns.
  `/watchdog status` shows both counts. A late blocker that may be outdated waits as `held` for the next review.
- Auto mode: the plugin allows its own review spawn when Claude Code would ask, so the Auto-mode classifier never sees
  it. If the classifier still refuses a spawn, the state is `blocked · auto mode`, with a hint and no failure count.
- CI runs on pull requests, plus a weekly check on the latest Claude Code.

## 0.1.0

- First release: watchdog agents review each update of the agent you work with and push `nit`, `concern` and
  `blocker` notes to it. Commands `/watchdog on`, `off`, `status` and `dump`, and a `WATCHDOG.json` to set the
  watchdogs.
