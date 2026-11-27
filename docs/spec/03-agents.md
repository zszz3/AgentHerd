# 03. Agents: ACP runtime and rule export

Applied ADRs: [0015](../adr/0015-acp-is-the-only-runtime-protocol.md),
[0016](../adr/0016-one-rule-source-exported-to-agents.md), [0014](../adr/0014-acp-first-real-agent.md),
[0108](../adr/0108-zcode-the-owners-own-account-behind-zcode-acp.md).

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
  "id": "qwen",
  "name": "Qwen Code",
  "command": ["qwen", "--acp"],
  "env": { "NO_BROWSER": "1" },
  "exporter": null
}
```

A profile may add `"mcp": false` to start the agent without AgentHerd's `agentherd` MCP
server ([09-agent-tools.md](09-agent-tools.md)). An agent that signs in and picks models itself
adds `"ownModels": true` (Antigravity, ADR 0104); an agent whose session must run in a verified
permission mode adds `"mode": "<mode id>"` — before the first prompt of a new, loaded or replaced
session, AgentHerd sends `session/set_mode` and starts work only when the running session itself
reports that mode back (ZCode, [ADR 0108](../adr/0108-zcode-the-owners-own-account-behind-zcode-acp.md)).

| Agent | Command | Status |
| --- | --- | --- |
| Pi | `node packages/pi-acp/bin/pi-acp.ts --pi <pi>` (bridge to `pi --mode rpc`) | Tested 2026-11-04 with Pi 1.5.0 and DeepSeek: allow writes the file, deny blocks it. Steering tested 2026-11-14 with Pi 1.5.0 and `deepseek-flash`: a message sent during a `sleep 8` command was read after it and answered in the same turn; one sent during the final reply was read too; a cancelled turn answered `false` and Pi did not act on the message. Built-in profile `pi` (found via `AGENTHERD_PI`, the copy inside the app, or `PATH`); see [Pi](#pi) and ADR 0022 |
| Codex | `node …/codex-acp/dist/index.js` (npm `@agentclientprotocol/codex-acp`), env `INITIAL_AGENT_MODE=read-only`, `NO_BROWSER=1`, the model in `CODEX_CONFIG` (ADR 0031) | Ships inside the app (2.5.0, with the Codex CLI for the build's platform); 验证 reports "Codex process was killed by SIGKILL" on this Mac (endpoint security); prompt run not tried **(verify, Q01)** |
| Claude Code | `node …/claude-agent-acp/dist/index.js` (npm `@agentclientprotocol/claude-agent-acp` 0.107.2), env `NO_BROWSER=1`, the model and key in `ANTHROPIC_*`, `CLAUDE_CONFIG_DIR=<home>/run/claude` (ask before edits and commands), `CLAUDE_CODE_EXECUTABLE` = the owner's own `claude` when found ([ADR 0069](../adr/0069-claude-code-the-owners-own-or-downloaded.md)) | Not in the app; `claude` is killed by endpoint security on this Mac (exit 137), so not run end to end **(verify, Q01)** |
| Antigravity | The owner's own `agy acp --cli_dir_name agentherd`, with `~/.gemini/antigravity-cli/agentherd/settings.json` `toolPermission: request-review` (ask before edits, commands, web and MCP); own Google sign-in and models, a named model set with `session/set_config_option` ([ADR 0104](../adr/0104-antigravity-the-owners-own-agy.md)) | Tested 2026-11-23 with `agy` 1.5.15: commands and writes ask over ACP; model switch works; used only when the owner names it |
| DeepSeek Harness | The owner's own DSH desktop app: `dsh acp` from the installed app (before `PATH`), env `DSH_PERMISSION_MODE=read-only` (writes ask); own models, a named model matched to the session's model ids and set with `session/set_config_option` ([ADR 0106](../adr/0106-dsh-the-owners-own-desktop-app.md)) | Tested 2026-11-24 on Windows with DSH 0.2.1-rc.2: a write asked and a denial blocked it; model switch works; used only when the owner names it |
| ZCode | The owner's own `zcode-acp server` (npm `zcode-acp-server`, community bridge over ZCode's backend); the bridge finds the backend (`ZCODE_BIN`, `zcode` on its `PATH`, or ZCode Desktop's bundle); own ZCode sign-in and models, a named model set with `session/set_config_option`; the session runs in mode `build`, set with `session/set_mode` and confirmed by the session itself before the first prompt ([ADR 0108](../adr/0108-zcode-the-owners-own-account-behind-zcode-acp.md)) | Tested 2026-11-27 on Windows with bridge 0.95.1 (and 2026-11-24/25 with 0.88.0) and the desktop backend: `0.95.1` (`#425`, `#432`) omits `current_mode_update` when materialized mode cannot be confirmed and broadcasts reload transitions; `build` confirmed on new and loaded sessions and asked for `rm -rf ./*`, outside-workspace `Write`, `cmd //c del`, `powershell Remove-Item`, `sudo`, `git push`, and `WebFetch` (deny blocked each; separately approved `rm -rf ./*` and `WebFetch` ran); `ls`, `echo`, in-workspace `Read .env`, and outside-workspace `Read` ran without asking **(verify, Q03)** |
| Qwen Code, others | Their ACP mode, as a config.json profile | **(verify, Q02)** |

The desktop app has built-in profiles for Pi, Codex, Claude Code, Antigravity, DeepSeek Harness and ZCode and lets the user
add any ACP command. Claude Code's CLI may not be redistributed, so it is not in the app
([ADR 0069](../adr/0069-claude-code-the-owners-own-or-downloaded.md)): see
[Claude Code](#claude-code).

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
| `session/set_mode`, confirmed by a `session/update` `current_mode_update` naming the requested mode | Before the first prompt of a new, loaded or replaced session of a profile with `mode`: establish the permission mode, or fail the task without sending work (ADR 0108). A mode the agent reports on its own, a pending session or a fallback default is not confirmation |
| `_agentherd/steer` (extension; offered with `agentCapabilities._meta.agentherd.steer: true`) | The owner's or the Herder's message for a running turn; `{ delivered: true }` once the agent's model saw it, `false` when the turn ended first (then it is the next prompt). Pi supports it through pi-acp ([ADR 0063](../adr/0063-messages-reach-a-working-pi-task.md)) |

Permission requests may carry a partial tool call: ACP sends a tool call once and later only
changed fields, and some agents' `request_permission` carries only the `toolCallId`. The ACP client
merges updates per `toolCallId` (`ToolCallTracker`), so an item always shows the command and
input the agent announced earlier.

All Host-managed task agents use AgentHerd's configured models. The Herder chooses an
available model in the owner's tier order when none is specified. Direct starts choose an
available model compatible with the requested profile. Continued legacy tasks without a model
also select from this list; tasks with a saved model keep it only while it remains configured
and compatible. Automatic switches cannot leave the list. An empty or unusable list stops the
task before an agent starts, rather than using the agent's native defaults. An agent with its
own sign-in and models (`ownModels`: Antigravity, ZCode) is outside this list: it runs with the
model its account gives, a model the owner names is set in the session by its own name, and the
Herder only ever starts it on request — never as an automatic pick, not even when it is the only
installed agent.

### Pi

Pi has no native ACP or MCP client and never asks before a tool call. AgentHerd's bridge
(`packages/pi-acp`, ADR 0022, [ADR 0060](../adr/0060-pi-tools-through-the-mcp-gateway.md)) starts
`pi --mode rpc --no-session -e extension/gate.ts` (plus `-e extension/mcp.ts` when stdio
`mcpServers` offer tools) for each ACP session:

- The gate asks before every tool except `read`, `grep`, `find`, `ls` inside the session
  folder and trusted tools from the `agentherd` MCP server (`McpGateway` runs its own approval
  pipeline for app/platform calls). Other MCP servers' tools still ask through the gate. The
  question goes out as `session/request_permission` (`allow-once` / `reject-once`); anything but
  allow blocks the call. Other extension dialogs are cancelled.
- MCP tools: `bridge.ts` queries `tools/list` on stdio `mcpServers` during `session/new` and
  `session/load`, writes the discovered definitions into a mode-`0600` per-session file referenced
  by `AGENTHERD_PI_MCP` (deleted on exit), and `extension/mcp.ts` registers them in Pi (`inputSchema`,
  one-line `promptSnippet`, and `tools/call` over `AGENTHERD_MCP_SOCKET` or stdio). Built-in Pi
  tools cannot be shadowed.
- `text_delta` becomes `agent_message_chunk`; text from a later model call in the same turn
  starts a new paragraph (a blank line), so the reply does not run together. `tool_execution_start/end` become `tool_call`
  and `tool_call_update` (`bash` → `execute`, `edit`/`write` → `edit`, `read`/`ls` → `read`,
  `grep`/`find` → `search`). `agent_settled` ends the turn; `session/cancel` sends `abort`.
- `_agentherd/steer` becomes Pi's `steer` (with `set_steering_mode all`, ADR 0063). A message
  counts as read when it leaves Pi's steering queue (`queue_update`); at `agent_settled` the rest
  are answered `false` and the queue is cleared; `session/cancel` clears the queue before `abort`.
- A model error (`stopReason: "error"`) fails the turn with Pi's message.
- Model: Pi's own login and settings, unless the owner chose a model for the `pi` role; then
  the host passes `AGENTHERD_PI_MODEL` (pi-ai model JSON) and `AGENTHERD_PI_KEY`, and
  `extension/model.ts` registers it as provider `agentherd`.
- On macOS and Linux, the host searches the login shell's `PATH` plus `~/.local/bin`,
  `~/.npm-global/bin`, `~/.bun/bin`, `/opt/homebrew/bin` and `/usr/local/bin` so an app opened
  from Finder finds `pi`, `node` and the ACP adapters. On Windows, it appends `%APPDATA%\npm`,
  `%LOCALAPPDATA%\pnpm`, `%LOCALAPPDATA%\Yarn\bin`, `%USERPROFILE%\.bun\bin`,
  `%USERPROFILE%\.local\bin`, `%USERPROFILE%\scoop\shims`, `%USERPROFILE%\.cargo\bin` and
  `%ProgramFiles%\nodejs`, resolves `.cmd`/`.exe` binaries via `PATHEXT`, unwraps npm/pnpm
  `.cmd` shims to run Node directly, and falls back to `cmd.exe /d /s /c` with hidden consoles.

### Agents inside the app

The owner does not choose an agent ([ADR 0031](../adr/0031-pick-the-agent-from-the-model.md)):
GPT models run in Codex; a hard coding task (`session_start` `hard`) runs in Claude Code when it
is installed and the model has an Anthropic-style API with a key
([ADR 0069](../adr/0069-claude-code-the-owners-own-or-downloaded.md)); every other task runs in Pi.

Pi and Codex ship inside the app ([ADR 0067](../adr/0067-agents-ship-inside-the-app.md)), each at
the one version AgentHerd was adapted to (`packages/host/src/catalog.ts`: Pi `1.5.0` from GitHub
release tag `v1.5.0`, `@agentclientprotocol/codex-acp` `2.5.0` with the Codex CLI npm installs for
the platform). `apps/desktop/scripts/fetch-agents.ts` fetches them at build time (publisher's
digest checked; an npm install that skipped the platform CLI fails) into
`AgentHerd.app/Contents/Resources/agents/<id>/<version>/` with `current.json`, and
`apps/desktop/scripts/package-mac.ts` builds the `.app` and `.dmg` (macOS, this Mac's
architecture, signed ad hoc until M5). The desktop main process passes that folder to the host as
`AGENTHERD_AGENTS`; in development `pnpm --filter @agentherd/desktop fetch-agents` fills
`apps/desktop/agents/`, which the dev app reads.

The app downloads nothing on its own and updates nothing: no download at start, no 更新 button. A
new Pi or Codex version comes with a new app; Claude Code is the one exception below. Lookup: `AGENTHERD_<ID>`, the copy inside the app, a copy an older
app downloaded into `<home>/runtimes` (read only; 移除 deletes it), then `PATH`. A missing agent
shows on the **Agent** page as 没有.
On Windows, when OpenAI's Codex (ChatGPT) desktop app is installed (package folder from
`HKCU\...\AppModel\Repository\Packages\OpenAI.Codex_*`, `app\resources\codex.exe`, newest first),
Codex runs with `CODEX_PATH` naming that CLI. An owner's own `CODEX_PATH` wins.

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

### Claude Code

Claude Code runs through `@agentclientprotocol/claude-agent-acp` (pinned 0.107.2), the way
OpenBot does it but without a Claude account sign-in: it uses the owner's own model services, not
a claude.ai login ([ADR 0069](../adr/0069-claude-code-the-owners-own-or-downloaded.md)).

- **Which `claude`.** `AGENTHERD_CLAUDE_CLI`, `claude` on `PATH`, `~/.local/bin/claude`,
  `~/.claude/local/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude` (or on Windows,
  `%USERPROFILE%\.local\bin\claude.exe`, `%USERPROFILE%\.claude\local\claude.exe`,
  `%LOCALAPPDATA%\Programs\claude\claude.exe`)
  (`localClaude` in `packages/host/src/profiles.ts`); it reaches the adapter as
  `CLAUDE_CODE_EXECUTABLE`. Without one, the adapter's own build is used. On Windows npm puts a
  `claude.cmd` on `PATH`, which `spawn` refuses without a shell, so the `claude.exe` beside it is
  what is used when it is there (`nativeClaude`, the same shape as `nativeLarkCli`).
- **Download only when asked.** On the **Agent** page Claude Code shows 没有 with 下载 until the
  adapter is in `<home>/runtimes/claude/<version>/`. With the owner's `claude`, 下载 fetches only
  the adapter (`npm --omit=optional`, a few MB); without it, also Anthropic's platform build
  (`@anthropic-ai/claude-agent-sdk-<os>-<arch>`, about 90 MB), and the install fails when npm
  skipped it. 取消 stops it, 移除 deletes it. No updates: a new version is a code change.
- **Model and key.** Only models with the Anthropic Messages API and a key (`claudeCanRun`): the
  env sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` and every alias to the
  chosen model. A subscription sign-in (ADR 0068) keeps its token in the host, so those models stay
  with Pi.
- **Asking.** `CLAUDE_CONFIG_DIR=<home>/run/claude` holds a `settings.json` with
  `permissions.defaultMode: "default"` and auto mode off, so every edit and command asks the owner
  through AgentHerd; the owner's own `~/.claude` is not used.
- When it does not start or its first turn breaks before acting, the task moves to Pi with the same
  model.

### ZCode

ZCode runs through the community bridge `zcode-acp`
([source](https://github.com/william0wang/zcode-acp)) with the explicit `server` argument, which
speaks ACP over stdio and starts ZCode's own backend (`zcode app-server --stdio`) itself
([ADR 0108](../adr/0108-zcode-the-owners-own-account-behind-zcode-acp.md)). AgentHerd ships
neither the bridge nor the backend; both update on the owner's machine.

- **Which bridge.** `AGENTHERD_ZCODE`, then `zcode-acp` on `PATH` (on Windows the npm `.cmd` shim
  runs under AgentHerd's Node). Missing shows on the **Agent** page with how to install it.
- **Backend discovery is the bridge's own**: an explicit `ZCODE_BIN` (and `ZCODE_NODE`) in the
  environment passes through to the bridge process; an unset one stays unset, so the bridge looks
  for `zcode` on its own `PATH` and then for the backend bundled with ZCode Desktop (Windows
  registry included). AgentHerd keeps no second locator. Live check (2026-11-24, Windows): with
  both unset and no CLI on `PATH`, the bridge launched the desktop backend.
- **Sign-in and models.** The bridge reuses the ZCode Desktop credential store (`~/.zcode`) or a
  saved `zcode-acp` account; no editor-side credentials. The profile has `ownModels`: the task
  runs on the account's model, and a model the owner names is set in the session with
  `session/set_config_option` — a name the backend refuses fails the task's start with the
  backend's own reason.
- **Permission mode.** A `session/new` is lazy and the bridge's default mode is `yolo`
  (unrestricted), taken from the user's `session.mode` setting before `ZCODE_ACP_MODE`. The
  profile carries `mode: "build"`, and before the first prompt of a new, loaded or replaced
  session — replayed history included — AgentHerd sends `session/set_mode` and starts work only
  when the running session confirms it (`current_mode_update` naming `build`, plus matching `settings` mode fields when returned on the RPC response). Otherwise the
  connection closes and the owner gets the reason; a session that refuses, stays silent, times out during the RPC or notification wait, reports
  another mode, or exits dispatches nothing, and an active task ends immediately if `current_mode_update` drifts away from `build` — except a drift to `plan`, the one mode live-probed to run no mutation at all (a write and a delete attempt neither executed nor asked; `plan-probe-run.json`, 2026-11-27), so the approval property survives it. Bridge `0.95.1` (`#425`, `#432`) withholds `current_mode_update` instead of falling back to `initialSessionMode()` when materialized `session/read` fails, and broadcasts confirmed transitions on backend reload. In `build` (ZCode 4.0.0), outside-workspace writes, `WebFetch` (both deny and `allow_once` tested), and gated commands (`rm -rf ./*`, `cmd //c del`, `powershell Remove-Item`, `sudo`, `git push`) ask over ACP with
  `rawInput` carrying the full command (`allow` picks `allow_once` only, and `cancelled` is a
  denial for the backend), while `ls`, `echo`, and ZCode's built-in `Read` tool (both inside and outside `cwd`) run without issuing `session/request_permission` (accepted boundary for ZCode; AgentHerd's `secret-read` guard still applies to forwarded `Bash` calls).
- **Asking.** Permission requests follow the bridge's `tool_call` update for the same
  `toolCallId`, so the card shows the command and paths; unclear requests follow the ordinary
  escalation policy. Only the owner answers a card.
- **Account choice.** ZCode is never an automatic pick — see
  [04-herder.md](04-herder.md#what-the-herder-does-with-a-direct-message) and ADR 0108 for the
  recovery rule.

验证 starts the agent in an empty temporary folder, runs `initialize`, `session/new` and — for a
profile with `mode` — the same session preparation a task uses, then reports its name and
version, a needed sign-in, a failing backend, or the error (credentials redacted). What passing
it proves is bounded: the bridge and a backend session started and the mode was confirmed; it
does not check which plan serves the task or that a particular model is billed. Local API:
`agents()`, `installAgent(id)`, `cancelInstall(id)`, `removeAgent(id)`, `verifyAgent(id)`, event
topic `agents`.

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

A script with `steer: true` offers `_agentherd/steer`; a `read_steers: <ms>` step waits up to
`ms` for messages sent into the running turn, reads them all and writes `Read: <text>` for each.
Messages it never read are answered `false` when the turn ends.

A script with `set_mode: confirm` answers `session/set_mode` and reports the requested mode back
(`current_mode_update`), like ZCode (ADR 0108); `silent` answers without a report, `wrong`
reports another mode, `error` refuses, and without the key the agent does not take the method.
`mode_report: <id>` makes it report a mode on its own at `session/new` (never a confirmation),
`reject_model: true` refuses every `session/set_config_option`, and `fail_load: true` refuses
every `session/load` (a replacement session is then prepared instead).

Because it speaks real ACP, E2E tests run the same client code as real agents. It is the main
tool for development, because Claude Code and Codex cannot run on the development machine
([07-delivery.md](07-delivery.md#3-testing)).

## 4. Later directions (not in v1)

- **Hook plugin for terminal sessions:** observe and approve Claude Code sessions started in a
  terminal through its hooks, for users who need channel escalation there.
- **ACP proxy:** AgentHerd also acts as an ACP agent, so an ACP editor (for example Zed)
  connects to AgentHerd, which forwards to the real agent and supervises in between.
