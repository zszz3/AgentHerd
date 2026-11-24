# Plans

A plan is a step-by-step task that a coding agent can execute without guessing. Plans are
written after the spec they implement is stable. They are never deleted: their state changes
in the table below.

Format: copy [TEMPLATE.md](TEMPLATE.md). File name: `NNN-<outcome-in-kebab-case>.md`, where
the name says what is true when the plan is done (for example
`001-mock-approval-reaches-feishu-card.md`).

States: `TODO`, `IN PROGRESS`, `DONE`, `BLOCKED: <reason>`, `REJECTED: <reason>`,
`SUPERSEDED BY NNN`.

| Plan | Title | Milestone | Size | Depends on | State |
| --- | --- | --- | --- | --- | --- |
| [001](001-workspace-protocol-and-rules.md) | The workspace builds, and protocol types and rules are tested | M1 | M | — | DONE |
| [002](002-acp-client-drives-mock-agent.md) | The ACP client runs a scripted mock agent and answers its permission requests | M1 | M | 001 | DONE |
| [003](003-core-approval-loop-with-fake-channel.md) | A mock agent's permission request reaches the owner and the answer goes back | M1 | L | 001, 002 | DONE |
| [004](004-feishu-channel-and-cli.md) | The owner approves a mock agent's request from a real Feishu card, started from a CLI | M1 | M | 003 | DONE |
| [005](005-herder-loop-fork-and-sync.md) | Pi's agent loop lives in packages/herder-loop and one upstream sync has been done with the sync script | M2 | M | ADR 0020 | DONE |
| [006](006-dsh-session-through-acp.md) | A DSH session runs through ACP and its permission requests reach the owner (Q07) | M2 | M | 004 | DONE |
| [007](007-stages-watchdog-board-reports.md) | Tasks have stages, a watchdog, a pinned board and completion reports | M2 | L | 006 | DONE |
| [008](008-long-lived-tasks-relay-and-commands.md) | Tasks stay open, the owner starts and relays to them from chat with fixed commands | M2 | L | 007 | DONE |
| [009](009-herder-answers-and-starts-tasks.md) | The Herder answers the owner, starts tasks from chat, and never approves | M2 | L | 005, 008 | DONE (manual run pending) |
| [010](010-model-list-and-roles.md) | The owner keeps a list of model services and chooses the model of each role (ADR 0021) | M2 | M | 009 | DONE (manual run pending) |
| [011](011-desktop-app-onboarding-models-tasks.md) | The desktop app binds Feishu, configures models, and shows tasks and open items | M2 | L | 010 | WITHDRAWN |
| [012](012-pi-and-dsh-agents.md) | Pi joins next to DSH through a bundled ACP bridge with an approval gate (ADR 0022) | M2 | M | 011 | DONE (manual run pending) |
| [013](013-app-downloads-agents.md) | The desktop app downloads Pi on the Agent page; no terminal install (ADR 0023) | M2 | M | 012 | DONE (manual run pending) |
| [014](014-six-agents-latest-and-check.md) | Six agents downloaded at their latest release, and a 验证 button (ADR 0024) | M2 | L | 013 | DONE (manual run pending) |
| [015](015-herder-picks-model.md) | The Herder picks the model of each task (ADR 0025) | M2 | M | 014 | DONE (manual run pending) |
| [016](016-model-guide.md) | A model guide for the Herder, editable on the 主管 page (ADR 0026) | M2 | S | 015 | DONE (manual run pending) |
| [017](017-import-pi-desktop.md) | Import model services from PI-Desktop (ADR 0027) | M2 | S | 010 | DONE (manual run pending) |
| [018](018-model-tiers.md) | Model tiers arranged by dragging (ADR 0028) | M2 | S | 016 | DONE (manual run pending) |
| [019](019-switch-the-data-directory-safely.md) | The owner can choose a data directory and safely copy existing data on Windows and macOS | M2 | L | [Data directory design](../docs/specs/2026-11-22-data-directory-design.md) | IN PROGRESS (desktop implementation; platform verification pending) |
