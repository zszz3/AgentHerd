# 07. Delivery

## 1. Milestones

| ID | Name | Result | Exit criteria |
| --- | --- | --- | --- |
| M0 | Spec freeze | Specs 00–07 and ADRs 0001–0019 accepted | Done 2026-11-04: baseline 0.2.0 Frozen |
| M1 | Headless loop | `core`, `rules` (guard list + matcher), `acp-client`, `mock-agent`, `channel-feishu`, run from a CLI | E2E-APPROVE and E2E-OWNER-ONLY pass with `mock-agent` and a fake channel; one manual run with real Feishu. Done 2026-11-04: plans 001–004, manual run recorded in plan 004 |
| M2 | DSH + Herder + desktop shell | DSH profile (`dsh acp`), the Herder (light model: start tasks from Feishu, relay, verbatim rule), board and completion reports, `herd_report`, watchdog, desktop app with onboarding (QR, two models), sessions list, read-only inbox, mode switch, keep-awake switch | A DSH task started from a Feishu message asks for approval, is approved from Feishu, and ends with a report; the board shows each stage |
| M3 | Reviewer + rule export | "Always do this", Reviewer (strongest model, project snapshot), observe metrics, decision memory, Herder compaction and restore; exporters for Claude Code and Codex, with export status per rule | Observe mode reports agreement on a replayed item set; exported Claude Code config passes `plan()` tests for every rule shape |
| M4 | More agents | Built-in profiles for Claude Code (`claude-agent-acp`), Codex (`codex-acp`), Gemini CLI, OpenCode; exporters for Gemini CLI and OpenCode | Verified on a machine where these agents can run |
| M5 | Release | Signed and notarized macOS build (an unsigned `.dmg` with Pi and Codex inside is built by `apps/desktop/scripts/package-mac.ts` since ADR 0067), auto-update, README with GIF | Fresh-machine install to first card in < 5 minutes |

Each milestone is split into plans under [`plans/`](../../plans/README.md).

## 2. Definition of done for a plan

- The code passes `pnpm check` (lint, typecheck) and the tests listed in the plan.
- Specs and ADRs changed in the same commit when behavior changed (see AGENTS.md).
- New user-visible or protocol-visible behavior has an E2E scenario below.
- The plan state in `plans/README.md` is updated.

## 3. Testing

- **E2E first.** Scenarios run the real core with `mock-agent` (a real ACP server) and `channel-fake` (an
  in-memory channel that records what it sent and lets the test click buttons).
- **Channel contract tests** run against every channel. Feishu runs them against recorded
  payloads; a manual checklist covers the real service.
- **Unit tests** only where E2E cannot reach: rule matching, guard list, redaction, command
  normalization, schema parsing.
- **Real agents.** On some development machines, endpoint-security software blocks Claude
  Code and Codex from starting (seen on 2026-11-04: the process is killed by SIGKILL at
  exec). Work for those agents is therefore developed against recorded ACP transcripts and
  config files stored under `fixtures/`, and verified on a machine where the agent can run.

## 4. E2E scenarios

| ID | Scenario | Milestone | Test |
| --- | --- | --- | --- |
| E2E-APPROVE | Mock agent requests approval; card is sent; owner taps Allow; the agent receives allow; card shows final state | M1 | `packages/core/test/e2e/approval.e2e.test.ts` |
| E2E-REMIND | An open item gets one reminder after `remindMinutes` and closes as not done (deny) after `timeoutMinutes`; 「先不管」 closes it at once (ADR 0056) | M1 | `packages/core/test/e2e/approval.e2e.test.ts` |
| E2E-BATCH | Approvals of two tasks share one card; 「allow 2」 in the chat and 「全部批准」 answer them | M2 | `packages/core/test/e2e/approval.e2e.test.ts` |
| E2E-LEAVES-MAC | git push and sending mail ask the owner; a step the owner allowed for the task runs without a card | M2 | `packages/core/test/e2e/approval.e2e.test.ts`, `packages/core/test/e2e/mcp.e2e.test.ts` |
| E2E-ASK-LIFECYCLE | A Herder question closes when the owner writes instead (the Herder hears why) or after an hour; a pick cancels the timeout | M2 | `packages/core/test/e2e/ask-lifecycle.e2e.test.ts` |
| E2E-APPROVAL-TOLD | The Herder hears how an approval card was answered (allowed, refused, 「先不管」, timed out) ([ADR 0057](../adr/0057-decisions-the-owner-made.md)) | M2 | `packages/core/test/e2e/approval.e2e.test.ts` |
| E2E-CHANNEL-DOWN | Channel disconnected; a new item waits in the inbox and is sent after reconnect | M2 | |
| E2E-CONFIGURED-MODEL | New and continued tasks select a configured model when none was specified; an empty list or unlisted choice cannot start an agent; automatic switches stay in the list | M2 | `packages/core/test/e2e/model.e2e.test.ts`, `packages/herder/test/tools.test.ts` |
| E2E-OWNER-ONLY | A non-owner taps a button; nothing changes; event is logged | M1 | `packages/core/test/e2e/approval.e2e.test.ts` |
| E2E-DUPLICATE-ACTION | Owner taps Allow twice; the decision is applied once | M1 | `packages/core/test/e2e/approval.e2e.test.ts` |
| E2E-APP-SEARCH | In app connections, typing filters names/slugs immediately; unrelated Composio matches, late replies and connection events do not bring back nonmatching apps; clearing restores the default list before the remote refresh answers | M2 | `apps/desktop/test/apps-search.test.ts`, `packages/host/test/apps.test.ts` |
| E2E-APP-BATCHES | App lists show five rows, connected first; show-more reveals five without fetching, disappears at the end; changing or clearing search resets to five | M2 | `apps/desktop/test/apps-search.test.ts` |
| E2E-EXPORT-NARROW | A rule the target cannot express exactly is exported narrower or skipped, never wider, and shows its export status | M3 | |
| E2E-EXPORT-REMOVE | `remove` restores the agent config byte-for-byte except for content the user added | M3 | |
| E2E-ALWAYS-RULE | Owner taps "Always do this"; the next equal request is allowed by rule in `assist` mode | M3 | |
| E2E-GUARD | A guarded command is never auto-allowed in any mode | M3 | |
| E2E-OBSERVE-AGREEMENT | Observe mode stores suggestions and computes agreement | M3 | |
| E2E-LOOP | Three identical stops raise a watchdog alarm; the board shows `stuck` | M2 | |
| E2E-WATCHDOG | The same tool call three times in one turn tells the owner; an agent crash ends the task as `failed` with a report | M2 | `packages/core/test/e2e/follow.e2e.test.ts` |
| E2E-STATUS | The owner sends `status`; the board is sent again and pinned; a non-owner gets nothing | M2 | `packages/core/test/e2e/follow.e2e.test.ts` |
| E2E-RUN-FROM-CHAT | A direct message starts a session; the agent receives the owner's text verbatim plus a labeled context block; a completion report is sent | M2 | `packages/herder/test/e2e/herder.e2e.test.ts` |
| E2E-RELAY | Owner starts a relay; messages reach the session without the Herder; `/end` and `relayIdleMinutes` end it | M2 | `packages/core/test/e2e/relay.e2e.test.ts` |
| E2E-BOARD | A stage change updates the pinned board in place; no new message is sent | M2 | `packages/core/test/e2e/follow.e2e.test.ts` |
| E2E-REPORT-RELAY | Feishu done reports have no relay button; blocked, failed and stopped reports keep it. Replying to a report still reaches the task. | M2 | `packages/channel-feishu/test/card-report.test.ts`, `packages/core/test/e2e/notify.e2e.test.ts` |
| E2E-REPORT-SHORT | A task ends with a reply ≤ `reportMaxWords`; the report body is the reply verbatim | M2 | `packages/core/test/e2e/follow.e2e.test.ts` |
| E2E-REPORT-LONG | A task ends with a longer reply; one summary prompt is sent to the same session; its answer is the body and the full reply is attached; no second summary prompt | M2 | `packages/core/test/e2e/follow.e2e.test.ts` |
| E2E-FOLD | A relayed agent message over `foldChars` is sent folded and complete | M2 | |
| E2E-HERDER-NO-APPROVE | The Herder has no way to allow an item; a Herder tool call that matches the guard list goes to the owner | M2 | `packages/herder/test/e2e/herder.e2e.test.ts`, `packages/herder/test/herder.test.ts` |
| E2E-HERDER-CONTEXT | The Herder folds earlier messages with `compress`; after a restart on the same `herd.db` the next request shows the summary instead of them, and the log still has them | M2 | `packages/herder/test/e2e/herder.e2e.test.ts` |
| E2E-HERDER-VOICE | A task's report is the Herder's words with the agent's reply as the full reply; `[quiet]` sends nothing; a failing or slow Herder (3 minutes) still lets the report out; a `waiting` herd_report is told in the Herder's words | M2 | `packages/core/test/e2e/voice.e2e.test.ts` |
| E2E-SCHEDULES | A schedule the owner asked for holds at once and its words reach the Herder at the time; a time missed while AgentHerd was off runs once; a paused one waits; a once one is removed after it ran; past times and more than 20 are refused | M2 | `packages/core/test/e2e/schedules.e2e.test.ts`, `packages/herder/test/tools.test.ts` |
| E2E-SOCIAL | A platform watch learns what is there on its first look, then tells new comments and @ once (likes and follows never); lists open only when something is unread; looks come every 20 ± 5 minutes and stop while the platform is off | M2 | `packages/core/test/e2e/social.e2e.test.ts`, `packages/host/test/socials.test.ts` |
| E2E-FEEDS-LARK | News sources become items, a digest's items are marked told and agents' reads are not, turned-off sources are not offered; lark-cli is set up with AgentHerd's app, signed in by QR and described to new tasks; lark-cli reads and new docs pass, other writes ask | M2 | `packages/host/test/feeds.test.ts`, `packages/rules/test/outbound.test.ts`, `packages/herder/test/tools.test.ts` |
| E2E-PI-MCP | Pi sessions through `pi-acp` register `agentherd` and stdio MCP tools, run `herd_ack` / read-only app tools / `herd_report` without duplicate gate cards, ask once for outbound app calls, keep third-party MCP tools gated, and use the refreshed token across `session/load` | M2 | `packages/pi-acp/test/bridge.test.ts`, `packages/host/test/pi-mcp.e2e.test.ts` |
| E2E-NOTICE-TIERS | A pull request's comments wake its task, and what the task handled itself, bare approvals, merges and closes only update the board (one push for the result the owner asked for); a Herder-started task's `herd_ack` goes on the board; `notice_level` moves a kind to push or off; the Herder sees what was not pushed | M2 | `packages/core/test/e2e/github.e2e.test.ts`, `packages/core/test/e2e/tiers.e2e.test.ts`, `packages/core/test/notices.test.ts`, `packages/herder/test/tools.test.ts` |
| E2E-UNREAD | A message queued for a task that ends before reading it comes back: the owner's to the Herder as the owner's message, the Herder's (or any without a Herder, or when AgentHerd stops) to the owner, whose reply opens the task again | M2 | `packages/core/test/e2e/tiers.e2e.test.ts` |
| E2E-CUT-OFF | After a crash, the first prompt to a task that was working tells it to look at the files, git and pull requests before going on; its next prompt and a task that had finished do not get it; the Herder takes up the owner's messages a restart cut off, says nothing for what it already did and drops what waited a day | M2 | `packages/core/test/e2e/restart.e2e.test.ts`, `packages/herder/test/herder.test.ts` |
| E2E-PR-WAKE-CAP | A pull request wakes its task three times in a row; the fourth time the owner is asked once, more news only updates the board, and the owner's reply gives the task everything held and starts the count over | M2 | `packages/core/test/e2e/github.e2e.test.ts` |
| E2E-STEER | The owner's reply to a working task goes into the running turn (「已插话」), which reads it at its next step and answers both with one report; a Herder-started turn becomes the owner's; a message the turn ended before reading is the next prompt; an agent without the extension queues it (「已排队」); a message still waiting when the task ends goes back to the Herder; pi-acp maps it to Pi's `steer` and clears the queue at the end and before `abort` | M2 | `packages/core/test/e2e/steer.e2e.test.ts`, `packages/pi-acp/test/bridge.test.ts`, `packages/acp-client/test/connection.test.ts` |
| E2E-PR-TURN | A task allowed to push, open pull requests and comment is woken by a comment on its pull request: the push to the pull request's branch runs, the comment asks the owner with the pull request turn reason; a turn the owner asked for comments without asking; pushes to other branches, `--all`, `--tags` and deletions ask; `session_start` drops allowed steps the owner's words or decisions do not name | M2 | `packages/core/test/e2e/github.e2e.test.ts`, `packages/core/test/pipeline.test.ts`, `packages/herder/test/tools.test.ts` |
| E2E-INTAKE-TRIAL | An automatic intake watch starts on a trial run: each new item is offered with a trial line and gives the Herder a trial turn whose `session_start` starts nothing and audits what it would have started; after the owner releases the trial new items start by themselves; turning `auto` off and on starts a new trial | M2 | `packages/core/test/e2e/intake.e2e.test.ts`, `packages/herder/test/herder.test.ts`, `packages/herder/test/tools.test.ts` |
| E2E-HERDER-ACTIVITY | The host's `herderActivity` reads the Herder's saved conversation into turns (what started each, every tool call with its arguments, result and failure, the reply or 「决定不说话」), newest first, with its `herder.*` error, retry and model-switch rows since the oldest turn shown; the 主管 page shows only this trail (ADR 0065) | M2 | `packages/host/test/host.test.ts`, `packages/herder/test/activity.test.ts` |
| E2E-MODEL-SUBSCRIPTION | A service signed in with a plan counts as ready only with its saved sign-in; Pi gets a socket token that fetches only that service's short token (never the refresh token); the sign-in dialog shows the link, device code or question and saves the service when done; removing the service removes the sign-in (ADR 0068) | M2 | `packages/host/test/model-logins.test.ts`, `packages/herder/test/logins.test.ts`, `packages/pi-acp/test/login.test.ts` |
| E2E-PET-APPROVE | The desktop pet sees what goes to Feishu (Feishu still gets it): the latest line and the cards that wait for the owner; pressing 同意 in the pet answers the approval as the owner, the agent's step runs and the Feishu card closes; a press on a closed card, an empty message or a stopped channel is refused (ADR 0070) | M2 | `packages/host/test/pet.test.ts`, `packages/host/test/host.test.ts`, `apps/desktop/test/pet-state.test.ts` |
| E2E-PET-DRAG | A drag can cross zero on either axis and reach negative screen coordinates. An invalid move is ignored, and the next valid move still works. | M2 | `apps/desktop/test/pet-window.test.ts` |
| E2E-PET-CARDS | A task's report card is kept in herd.db with its task and shown by the pet as Feishu shows it; the owner stops a working task from the pet and its report says it was stopped, not failed; an unknown task is refused (ADR 0072) | M2 | `packages/host/test/pet.test.ts`, `packages/core/test/store.test.ts`, `apps/desktop/test/pet-state.test.ts` |
| E2E-PET-CHAT | The pet draws the Herder's replies as Markdown, folds long ones, offers 打开 only for files the Herder puts in a herd-ui `file` item, not for paths in its words (documents open, anything else is only shown in Finder), shows task events as quiet rows; a reply never shows a context ref tag (ADR 0073) | M2 | `apps/desktop/test/pet-state.test.ts`, `apps/desktop/test/open-file.test.ts`, `packages/herder/test/context.test.ts`, `packages/host/test/pet.test.ts` |
| E2E-HERD-UI-CHOICES | The Herder's reply with a herd-ui block is drawn as components in the pet and in Feishu; a pressed choice reaches the Herder as the owner's answer and the card shows it; an unreadable block is rewritten once, then sent as words only (ADR 0074) | M2 | `packages/core/test/e2e/herd-ui-choices.e2e.test.ts`, `packages/host/test/pet.test.ts`, `packages/herder/test/herd-ui.test.ts`, `packages/channel-feishu/test/herd-ui-card.test.ts`, `packages/channel-feishu/test/herd-ui-fallback.test.ts` |
