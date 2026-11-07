# Architecture decision records

Format and rules: [ADR 0001](0001-record-architecture-decisions.md).

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-english-docs-chinese-readme.md) | English docs with a Chinese README mirror | Accepted |
| [0003](0003-herder-on-pi-agent-core.md) | Build the Herder on Pi agent core | Accepted |
| [0004](0004-electron-app-with-headless-core.md) | Electron desktop app with a headless core | Accepted |
| [0005](0005-channel-abstraction-feishu-first.md) | Channel abstraction, Feishu first | Accepted |
| [0006](0006-agent-adapters-attach-and-launch.md) | Agent adapters with attach and launch modes | Superseded by 0015 |
| [0007](0007-tiered-decisions-fail-open-to-human.md) | Tiered decisions that fail toward the human | Accepted |
| [0008](0008-observe-first-rollout.md) | Observe-first rollout | Accepted |
| [0009](0009-mit-license-reference-only.md) | MIT license, reference other projects without copying code | Accepted |
| [0010](0010-typescript-pnpm-monorepo.md) | TypeScript pnpm monorepo | Accepted |
| [0011](0011-keep-running-with-lid-closed.md) | Keep running with the lid closed (macOS) | Accepted |
| [0012](0012-channel-is-the-only-decision-surface.md) | The channel is the only place where the owner decides | Accepted |
| [0013](0013-macos-only-for-v1.md) | macOS only for v1 | Accepted |
| [0014](0014-acp-first-real-agent.md) | ACP is the first real agent integration | Accepted |
| [0015](0015-acp-is-the-only-runtime-protocol.md) | ACP is the only runtime protocol to agents | Accepted |
| [0016](0016-one-rule-source-exported-to-agents.md) | One rule source, exported to each agent's own config | Accepted |
| [0017](0017-resident-herder-per-project.md) | A resident Herder per project, on the strongest model, that manages agents | Superseded by 0018 |
| [0018](0018-one-herder-as-secretary-separate-approvals.md) | One Herder for all projects as a light-model secretary; approvals in a separate pipeline | Accepted |
| [0019](0019-relay-verbatim-board-and-reports.md) | Relay, verbatim messages, pinned board and completion reports | Accepted |
| [0020](0020-fork-pi-agent-loop-track-upstream.md) | Fork Pi's agent loop into the repo and follow its upstream; pi-ai pinned behind ModelClient | Accepted |
| [0021](0021-model-list-then-choose-per-role.md) | The owner keeps a list of model services, then chooses a model for each role | Accepted |
| [0022](0022-pi-through-a-bundled-acp-bridge.md) | Pi joins through a bundled ACP bridge with an approval gate | Accepted |
| [0023](0023-app-downloads-pinned-agent-clis.md) | The app downloads pinned agent CLIs; the owner does not install them | Superseded by 0024 |
| [0024](0024-follow-latest-releases-six-agents.md) | Agent downloads follow upstream's latest release; six agents and a check button | Accepted |
| [0025](0025-herder-picks-model-per-task.md) | The Herder picks the model of each task from the owner's list | Accepted |
| [0026](0026-model-guide-for-the-herder.md) | A model guide tells the Herder which models are strong; the owner can edit it | Superseded by 0028 |
| [0027](0027-import-model-services-from-pi-desktop.md) | Import model services and keys from PI-Desktop | Withdrawn |
| [0028](0028-model-tiers-by-drag.md) | Model tiers the owner arranges by dragging, filled in by name | Accepted |
| [0029](0029-only-mass-deletes-ask-the-owner.md) | Only a mass delete asks the owner; AgentHerd approves everything else | Accepted |
| [0030](0030-switch-model-when-a-turn-breaks-before-acting.md) | Switch the model and run again when a task's first turn breaks before it acts | Accepted |
| [0031](0031-pick-the-agent-from-the-model.md) | No agent choice: GPT models run in Codex, the rest in Pi; DSH only when named; OpenCode, Gemini CLI, Claude Code removed | Accepted |
| [0032](0032-task-conversation-in-the-app.md) | Each task's conversation (prompts, replies, tool calls) opens from the 任务 page | Accepted |
| [0033](0033-herder-does-not-repeat-reports.md) | Task reports and alarms start no Herder turn; they go with the owner's next message | Accepted |
| [0034](0034-herder-names-tasks.md) | The Herder gives each task a short name instead of using the owner's first line | Accepted |
| [0035](0035-herder-finds-projects-owner-picks.md) | The Herder finds project folders by name; the owner always picks with buttons | Accepted |
| [0036](0036-message-cards-by-kind.md) | Herder questions, task reports and approvals are cards with their own colour; reports ≤400 chars | Accepted |
| [0037](0037-herder-retries-and-never-drops.md) | The Herder retries, switches model, and never drops an owner message | Accepted |
| [0038](0038-herder-memory.md) | The Herder has a long-term memory (six kinds) in herd.db with code-checked writes | Accepted |
| [0039](0039-tasks-kept-and-continued.md) | Tasks are kept in herd.db across restarts; an ended task can be continued (Pi reopens its own session) | Accepted |
| [0040](0040-ask-before-continuing-cut-off-tasks.md) | After a restart the Herder asks whether to continue tasks the stop cut off | Accepted |
| [0041](0041-agent-tools-through-a-local-mcp-gateway.md) | Agents get herd_report and the owner's Composio apps through a local stdio MCP gateway; app calls go through approvals | Accepted |
| [0042](0042-dsh-runs-the-owners-models.md) | DSH runs the owner's models through a `--patch` overlay; `envFor` becomes `launchFor` | Accepted |
| [0043](0043-tasks-work-on-hidden-copies.md) | Tasks in a git project work on a hidden copy synced each turn; a project named once starts without asking; replies reach their task | Accepted |
| [0044](0044-tell-the-owner-at-the-right-time.md) | Background work holds the report; waiting/blocked/failed reach the owner at once; `herd_ack`; messages kept in an outbox until sent | Accepted |
