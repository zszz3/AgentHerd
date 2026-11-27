# Proposal

## Why

An owner who already pays for a ZCode plan should be able to say “Use ZCode for this task” in AgentHerd and receive the usual approvals and report. AgentHerd already runs an explicitly requested agent with its own sign-in and models, as described in [ADR 0104](../../../docs/adr/0104-antigravity-the-owners-own-agy.md).

## What Changes

- On the Agent page, show whether AgentHerd found the ACP bridge. If the bridge reports a missing backend or a sign-in failure, show the owner how to resolve it. The bridge can use the backend bundled with ZCode Desktop.
- Let the owner select ZCode with `/run zcode <dir> <task>` or ask the Herder to use it by name. The fixed command can start a task with an empty AgentHerd model-service list. Natural-language dispatch uses the Herder's configured model. ZCode uses its own sign-in and default model to do the work.
- Before the first prompt in each new or restored ZCode session, confirm that its effective permission mode sends actions requiring approval to AgentHerd. If the mode cannot be established or verified, stop and tell the owner. Route permission requests through the existing approval pipeline and send the usual task report.
- Keep ZCode out of automatic fallback for other tasks. When a ZCode task cannot resume or restart on ZCode, ask the owner before switching to another agent or account.

## Capabilities

### New Capabilities

- `zcode-tasks` covers starting a task with the owner's ZCode account, presenting its permission requests, and delivering its report.

### Modified Capabilities

## Impact

**Worker launch.** AgentHerd starts an external ACP bridge for both Claude Code and Codex. Claude Code's bridge can use the owner's CLI and is available for download on request. Codex ships with its bridge and platform CLI. For ZCode, register the owner-installed bridge in the agent catalog. AgentHerd speaks ACP over stdio to `zcode-acp server`, which drives `zcode app-server`. Reuse the existing task workspace and ACP client. [Claude Code integration](../../../docs/adr/0069-claude-code-the-owners-own-or-downloaded.md) · [Codex packaging](../../../docs/adr/0067-agents-ship-inside-the-app.md) · [Agent catalog](../../../packages/host/src/catalog.ts)

**Backend selection.** AgentHerd launches the bridge and leaves backend discovery to it. By default, leave `ZCODE_BIN` unset. The bridge looks for `zcode` on its process `PATH`, then for the backend bundled with ZCode Desktop. Pass through an explicit `ZCODE_BIN` so the owner can select the desktop app's `resources/glm/zcode.cjs` even when a standalone CLI is on `PATH`. The bridge builds the `app-server --stdio` command and accepts `ZCODE_NODE` when an explicit Node executable is needed.

**Herder dispatch and account selection.** Teach the Herder to pass `profile=zcode` to `session_start` when the owner names ZCode. The tool already recognizes profiles with `ownModels`, as used for Antigravity. This lets ZCode handle its own credentials and model while the Herder uses its configured model service to interpret the request. The task runner currently tries the original agent, Pi, then other installed profiles when reopening a task. That fallback also needs to respect the owner's choice of account. [Dispatch tool](../../../packages/herder/src/tools.ts) · [Herder model selection](../../../packages/herder/src/models.ts) · [Task runner](../../../packages/core/src/task-runner.ts)

### Evidence and first acceptance check

On Windows, the bridge resolver selected the standalone community CLI `0.17.1` when it was on `PATH`. With that CLI off the bridge process's `PATH` and `ZCODE_BIN` unset, it found ZCode Desktop `4.0.0.10870` in a custom install directory. With both installed and `ZCODE_BIN` pointing to the desktop entry, it selected the desktop backend. These checks inspected the launch command without starting an ACP session.

The installed bridge is `zcode-acp-server@0.88.0`. Its new-session mode defaults to `yolo`, and the bridge reads the user's `session.mode` before `ZCODE_ACP_MODE`. A launch environment setting alone cannot establish the effective mode. [Bridge source](https://github.com/william0wang/zcode-acp) · [AgentHerd permission handler](../../../packages/acp-client/src/connection.ts)

Verify backend selection through AgentHerd at startup:

- **Automatic discovery.** Leave `ZCODE_BIN` unset. With both installations present, expect the CLI on `PATH`. Remove it from the bridge process's `PATH` and expect the desktop backend. Also verify startup on a standalone-only install.
- **Explicit override.** Keep the CLI on `PATH` and set `ZCODE_BIN` to the desktop entry. Verify that the bridge launches that entry.

For session checks, use a disposable project and record the bridge version, backend source and version. Keep account details and protocol evidence redacted.

1. Start with the fixed command and an empty AgentHerd model-service list. Verify that ACP initialization and session creation succeed. Check which plan served the task using a non-secret usage indicator if available. Record quota attribution as unverified if the account exposes no such evidence. [Fixed command entry point](../../../packages/core/src/owner-commands.ts)
2. Exercise an action requiring approval in both a new session and a restored session. The owner sees the proposed action before execution. Denial leaves the target file untouched. A separately approved action completes and the owner receives the report. A missing backend, unusable login, or unverifiable permission mode gives the owner a useful failure.
3. Configure a Herder model and repeat the task by asking “Use ZCode for this task.” Confirm that the Herder selects the ZCode profile. Exercise both recovery cases: an ordinary task that loses its agent never starts ZCode, and a ZCode task that cannot restart waits for the owner's choice before switching agents.

The account, quota attribution, permission round trip and task report still need a live check. The implementation PR should update the agent spec and add a delivery scenario alongside [E2E-AGENT-OWN-MODELS](../../../docs/spec/07-delivery.md#4-e2e-scenarios).

### Other contribution ideas

These are candidates for separate changes:

- **Mailbox recovery.** Interrupt delivery of an issue offer and verify that the owner can still act on the card after restart. Start with the order of writes in [mailbox.ts](../../../packages/core/src/mailbox.ts).
- **Observe agreement (M3).** Pair recorded rule suggestions with explicit owner answers. Define how skipped and timed-out items count in [E2E-OBSERVE-AGREEMENT](../../../docs/spec/07-delivery.md#4-e2e-scenarios).
- **Task publication.** Coordinate with [issue #179](https://github.com/zszz3/AgentHerd/issues/179) on keeping the owner's unpublished work out of task branches while preserving the task's local view.
- **Agent questions over ACP.** Capture a redacted clarification and reply from one pinned agent version. Use it to answer part of [Q03](../../../docs/spec/open-questions.md) and test continuation of the same task.
