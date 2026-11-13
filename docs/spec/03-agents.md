# 03. Agents: ACP runtime and rule export

Applied ADRs: [0015](../adr/0015-acp-is-the-only-runtime-protocol.md),
[0016](../adr/0016-one-rule-source-exported-to-agents.md), [0014](../adr/0014-acp-first-real-agent.md).

AgentHerd reaches agents in two ways, from one rule set:

| Path | Sessions | Who decides | When no rule matches |
| --- | --- | --- | --- |
| **ACP runtime** | Sessions AgentHerd starts | The Herder, at run time | The item goes to the owner in the channel |
| **Rule export** | Sessions the user starts in a terminal or IDE | The agent, from its own config written by AgentHerd | The agent asks in its own UI |

Statements marked **(verify)** are not yet checked against the current agent version. Each
one has a row in [open-questions.md](open-questions.md).

## 1. ACP runtime

AgentHerd is an [Agent Client Protocol](https://agentclientprotocol.com) client
(`@agentclientprotocol/sdk`). It starts the agent as a child process and talks JSON-RPC over
stdio. There is no agent-specific runtime code in the core.

### Agent profiles

An agent is a profile in configuration, not a package:

```json
{
  "id": "dsh",
  "name": "DeepSeek Harness",
  "command": ["dsh", "acp"],
  "env": { "DSH_PERMISSION_MODE": "read-only" },
  "exporter": null
}
```

A profile may add `"mcp": false` to start the agent without AgentHerd's `agentherd` MCP
server ([09-agent-tools.md](09-agent-tools.md)).

| Agent | Command | Status |
| --- | --- | --- |
| DeepSeek Harness | `dsh acp` | Tested 2026-11-04: `initialize` returns `deepseek-harness-acp`, session `close`/`list`/`resume`. Asks over `session/request_permission` only when a command needs more than its sandbox mode allows; see [DSH approvals](#dsh-approvals). Built-in profile `dsh` (found via `AGENTHERD_DSH`, `PATH`, or the app bundle); end-to-end run with Feishu passed 2026-11-04 |
| Pi | `node packages/pi-acp/bin/pi-acp.ts --pi <pi>` (bridge to `pi --mode rpc`) | Tested 2026-11-04 with Pi 1.5.0 and DeepSeek: allow writes the file, deny blocks it. Built-in profile `pi` (found via `AGENTHERD_PI`, the copy the app downloaded, or `PATH`); see [Pi](#pi) and ADR 0022 |
| Codex | `node …/codex-acp/dist/index.js` (npm `@agentclientprotocol/codex-acp`), env `INITIAL_AGENT_MODE=read-only`, `NO_BROWSER=1`, the model in `CODEX_CONFIG` (ADR 0031) | Installs with npm 2026-11-05 (2.5.0); 验证 reports "Codex process was killed by SIGKILL" on this Mac (endpoint security); prompt run not tried **(verify, Q01)** |
| Qwen Code, others | Their ACP mode, as a config.json profile | **(verify, Q02)** |

The desktop app ships built-in profiles for these and lets the user add any ACP command.

### Mapping ACP to AgentHerd

| ACP | AgentHerd |
| --- | --- |
| `initialize` → `agentCapabilities` | Stored per profile; the UI hides actions the agent does not support |
| `session/new` (with `cwd`, `mcpServers`), `session/prompt` | Start a task (the Herder's `session_start`). `mcpServers` carries the stdio server `agentherd` with `herd_report` ([09-agent-tools.md](09-agent-tools.md)); `session/load` carries it too |
| `session/update` notifications (message chunks, tool calls, plan) | Session state, progress messages, loop detection |
| `session/request_permission` (tool call + options) | An item that needs a decision ([04-herder.md](04-herder.md)) |
| Answer with the selected `optionId`, or `cancelled` | Apply the decision. `allow` / `deny` map to the agent's `allow_once` / `reject_once` options; "Always do this" creates an AgentHerd rule, never the agent's `allow_always` |
| End of `session/prompt` with a stop reason | `turn.stopped`; without a `herd_report`, the last message is the fallback report |
| `session/cancel` | Interrupt |
| Follow-up `session/prompt` | A relayed owner message, or a Herder prompt |
| `session/load` (if supported) | Continue an ended task, also after a restart (ADR 0039); Pi supports it through pi-acp |

Permission requests may carry a partial tool call: ACP sends a tool call once and later only
changed fields, and DSH's `request_permission` carries only the `toolCallId`. The ACP client
merges updates per `toolCallId` (`ToolCallTracker`), so an item always shows the command and
input the agent announced earlier.

### DSH approvals

Tested 2026-11-04 with DSH 0.0.1 ACP (`/Applications/DeepSeek Harness.app/.../runtime/cli/bin/dsh acp`):

- DSH runs commands in its sandbox and asks only for escalations. With the default mode, a
  write inside `cwd` (`echo hello > out.txt`) ran without a permission request.
- With `DSH_PERMISSION_MODE=read-only` in the profile `env`, the write was denied by the
  sandbox, the model retried with `sandbox_permissions: workspace-write` and a
  `justification`, and DSH sent `session/request_permission` with options `allow-once`
  (`allow_once`) and `reject-once` (`reject_once`). After `allow-once`, the file was written.
- Other modes: `workspace-write`, `danger-full-access`. The built-in DSH profile uses
  `read-only` so every write and network command reaches the AgentHerd pipeline; the rules and
  the owner decide, not DSH's own default.
- `rawInput` of the escalated call has `command`, `description` and `justification`; the card
  shows the justification.
- DSH writes two harmless stderr lines: `Node.js environment variables are disabled because
  this process is invoked by other apps.` and `Got response to unknown request null`.
- Model ([ADR 0042](../adr/0042-dsh-runs-the-owners-models.md)): tasks use a model from the
  owner's AgentHerd list, never DSH's native default. Without an explicit choice, AgentHerd
  selects an available configured model; without one, it refuses to start. The host writes `<home>/run/dsh-model-<hash>.json`, a patch overlay with one provider
  `agentherd` (`llm-pi-ai`) and the `acp` route pointed at it, appends `--patch <file>` to the
  command, and passes the key in `AGENTHERD_DSH_KEY`. Only `openai-completions`,
  `openai-responses` and `anthropic-messages` models run in DSH.

All Host-managed task agents use AgentHerd's configured models. The Herder chooses an
available model in the owner's tier order when none is specified. Direct starts choose an
available model compatible with the requested profile. Continued legacy tasks without a model
also select from this list; tasks with a saved model keep it only while it remains configured
and compatible. Automatic switches cannot leave the list. An empty or unusable list stops the
task before an agent starts, rather than using the agent's native defaults.

### Pi

Pi has no ACP server and never asks before a tool call. AgentHerd's bridge
(`packages/pi-acp`, ADR 0022) starts `pi --mode rpc --no-session -e extension/gate.ts` for each
ACP session:

- The gate asks before every tool except `read`, `grep`, `find`, `ls` inside the session
  folder. The question goes out as `session/request_permission` (`allow-once` /
  `reject-once`); anything but allow blocks the call. Other extension dialogs are cancelled.
- `text_delta` becomes `agent_message_chunk`; `tool_execution_start/end` become `tool_call`
  and `tool_call_update` (`bash` → `execute`, `edit`/`write` → `edit`, `read`/`ls` → `read`,
  `grep`/`find` → `search`). `agent_settled` ends the turn; `session/cancel` sends `abort`.
- A model error (`stopReason: "error"`) fails the turn with Pi's message.
- Model: Pi's own login and settings, unless the owner chose a model for the `pi` role; then
  the host passes `AGENTHERD_PI_MODEL` (pi-ai model JSON) and `AGENTHERD_PI_KEY`, and
  `extension/model.ts` registers it as provider `agentherd`.
- The host searches the login shell's `PATH` plus `~/.local/bin`, `/opt/homebrew/bin`,
  `/usr/local/bin` so an app opened from Finder finds `dsh`, `pi` and `node`.

### Managed downloads

The owner does not choose an agent ([ADR 0031](../adr/0031-pick-the-agent-from-the-model.md)):
GPT models run in Codex, every other model in Pi, and DSH only when the owner names it. The host
downloads Pi, and Codex when a GPT model is listed; the desktop **Agent** page shows the three and
can download each one's latest release: DSH (DeepSeek's update feed), Pi (GitHub releases) and
Codex (the ACP adapter on npm, installed with a downloaded npm). `packages/host/src/catalog.ts` has
the sources and the env of each; `packages/host/src/runtimes.ts` checks the publisher's digest
(and `--version`), installs into `<home>/runtimes/<id>/<version>/` and records it in
`current.json`. Lookup: `AGENTHERD_<ID>`, the download, `PATH`, then the DSH app. On Windows the DSH
app (install folder from its uninstall entry, `resources\runtime\cli\bin\dsh.cmd`) comes
before `PATH`: the npm `dsh` launcher there serves ACP only with its own `acp` profile bundle.
On Windows, when OpenAI's Codex (ChatGPT) desktop app is installed (package folder from
`HKCU\...\AppModel\Repository\Packages\OpenAI.Codex_*`, `app\resources\codex.exe`, newest first),
Codex runs with `CODEX_PATH` naming that CLI, and its download leaves out npm's optional
dependencies (the platform CLI build, over 100 MB). An owner's own `CODEX_PATH` wins.
移除 deletes the download.

A task runs with a model from the owner's list: the Herder picks it and the agent gets it through
env (Pi, Codex; see [ADR 0025](../adr/0025-herder-picks-model-per-task.md)). When Codex does not
start or its first turn breaks before acting, the task moves to Pi with the same model.
Codex can run GPT models on any OpenAI-style service and every model of the owner's own
OpenAI-compatible services (relays usually offer the Responses API for all their models); other
built-in providers without Responses stay with Pi ([ADR 0044](../adr/0044-codex-runs-relay-models.md),
`codexCanRun` in `packages/herder/src/agent-models.ts`). Without a model named by the owner the
default stays GPT → Codex. These runs get `CODEX_HOME=<home>/run/codex-<hash>` whose
`config.toml` names the `agentherd` provider (no key): Codex 0.166 refuses a turn whose provider
differs from its global config's (`packages/host/src/codex-home.ts`).

验证 starts the agent in an empty temporary folder, runs `initialize` and `session/new`, and
reports its name and version, a needed sign-in, or the error. Local API: `agents()`,
`installAgent(id)`, `cancelInstall(id)`, `removeAgent(id)`, `verifyAgent(id)`, event topic `agents`.

How each agent asks the user a question over ACP (permission request, or a message that ends
the turn) is open **(verify, Q03)**.

### Task folders

The `cwd` a task's agent gets ([ADR 0043](../adr/0043-tasks-work-on-hidden-copies.md),
`packages/core/src/workspace.ts`):

| Project | `cwd` |
| --- | --- |
| A git project | A hidden copy `~/.agentherd/worktrees/<project>-<hash>/<task id8>` (`git worktree add --detach` of a snapshot of the owner's working tree; `node_modules`/`.venv`/`venv` linked, `.env*` copied) |
| A folder that is not a git project | That folder |
| None | An empty folder `~/.agentherd/tasks/<task id8>` |

- At each turn start the owner's changes since the last sync go into the copy; at each turn end
  the task's changes go into the owner's folder as uncommitted edits. A file both changed
  differently keeps the owner's version; the owner gets one message with 「用任务的版本」.
- The copy is removed when the task ends and made again (from `refs/agentherd/tasks/<id>`) when
  it is continued. No branch is created and the owner's git index is never touched.
- `agentherd run` runs in the given folder.

### Session states

`starting`, `working`, `waiting-approval`, `idle` (turn ended), `looping`, `error`, `ended`.
`looping` is set by the watchdog ([04-herder.md](04-herder.md#watchdog)).

### Restarts

Agent processes are children of the core. If the core stops, its agent sessions stop.

- **Stopping** (quit, restart, `SIGINT`/`SIGTERM`; the desktop app asks its host to stop
  instead of killing it): before the agents are closed the owner gets one message listing the
  unfinished tasks; they end with "AgentHerd 已停止".
- **Next start**: every task and session still open in `herd.db` (left by a crash or a hard
  kill) is marked ended, and a relay that pointed at one is shown as ended. The Herder asks
  whether to continue the tasks the stop or crash cut off
  ([ADR 0040](../adr/0040-ask-before-continuing-cut-off-tasks.md)); without a Herder the owner
  gets one message listing them instead. Task copies left behind are removed.
- The tasks stay on the board and `session_prompt` continues them
  ([ADR 0039](../adr/0039-tasks-kept-and-continued.md)).
- `agentherd run` beside a running host neither ends nor asks about anything: the open tasks
  may be that host's.

## 2. Rule export

The rule set in AgentHerd is the only source ([ADR 0016](../adr/0016-one-rule-source-exported-to-agents.md)).
An **exporter** per agent translates it into that agent's own permission config, so that
sessions the user starts outside AgentHerd follow the same rules, even when AgentHerd is not
running.

### What is exported

- Rules with action `allow` or `deny`.
- The guard list, as `deny` (or `ask`, if the agent cannot deny that case).
- Nothing else. Model decisions, precedents and channel escalation exist only on the ACP path.

### Export rules

1. **Never widen.** If the agent cannot express a rule exactly (for example "only inside the
   project directory"), export a narrower form or do not export it. The desktop app marks
   each rule per agent: `exact`, `narrowed` or `not exported`, with the reason.
2. **Own only what you wrote.** AgentHerd writes its entries in a separate file or a marked
   block, keeps a backup of every file it changes, and `remove` deletes only its own entries.
3. **One direction.** AgentHerd does not import changes made by hand in the agent's config.
   It detects them (hash of its own block) and shows a warning.
4. **Explicit action.** Export runs when the user turns it on for an agent, and after rule
   changes while it is on.

### Targets

| Agent | Target config | Notes |
| --- | --- | --- |
| Claude Code | `permissions.allow` / `deny` / `ask` in `~/.claude/settings.json` or project `.claude/settings.json`, entries like `Bash(pnpm test:*)` | **(verify format, Q04)** |
| Codex | Approval policy, sandbox mode, command rules (execpolicy) | Coarser than AgentHerd rules; expect `narrowed` **(verify, Q05)** |

### Exporter interface

```ts
interface RuleExporter {
  agent: string;                                    // profile id
  detect(): Promise<{ installed: boolean; configPaths: string[] }>;
  plan(rules: Rule[]): ExportPlan;                  // pure: per rule exact | narrowed | skipped + reason
  apply(plan: ExportPlan): Promise<ExportReport>;   // backup, then write own block
  remove(): Promise<void>;                          // delete own block only
  drift(): Promise<DriftReport>;                    // own block changed by hand?
}
```

`plan()` is pure and has unit tests with a case for every rule shape.

## 3. Mock agent

`packages/mock-agent` is a scripted fake **ACP agent** (a real ACP server over stdio). A script
is a list of steps:

```yaml
- request_permission:
    toolCall: { kind: execute, title: "pnpm test" }
    options: [allow_once, reject_once]
  expect: allow_once        # the test fails if the decision differs
- end_turn: { message: "Done. All tests pass." }
```

Because it speaks real ACP, E2E tests run the same client code as real agents. It is the main
tool for development, because Claude Code and Codex cannot run on the development machine
([07-delivery.md](07-delivery.md#3-testing)).

## 4. Later directions (not in v1)

- **Hook plugin for terminal sessions:** observe and approve Claude Code sessions started in a
  terminal through its hooks, for users who need channel escalation there.
- **ACP proxy:** AgentHerd also acts as an ACP agent, so an ACP editor (for example Zed)
  connects to AgentHerd, which forwards to the real agent and supervises in between.
