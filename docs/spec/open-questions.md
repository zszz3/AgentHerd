# Open questions

Each question names the spec or plan that depends on it. Close a question by writing the
answer and the evidence (link, command output, date) and, if it changes a decision, an ADR.

| ID | Question | Blocks | Status |
| --- | --- | --- | --- |
| Q01 | Do `claude-agent-acp` and `codex-acp` work with `@agentclientprotocol/sdk` 2.x: permission options offered, `session/load`, cancel? | M4 Claude Code / Codex profiles | Open |
| Q02 | Which other agent CLIs have a working ACP mode today (Gemini CLI, OpenCode, Qwen Code, Goose, Kimi), and the exact command for each | M4 built-in profiles | Open |
| Q03 | How does each agent ask the user a question over ACP: a permission request, a message that ends the turn, or something else? | M2 (`answer`) | Open |
| Q04 | Claude Code permission rule syntax and precedence in `settings.json` (`allow` / `deny` / `ask`, `Bash(prefix:*)`, path rules); can a separate file hold AgentHerd's entries? | M3 exporter-claude-code | Open |
| Q05 | Codex: approval policy, sandbox modes and command rule files (execpolicy) in the current version; what can be expressed per command and per directory? | M3 exporter-codex | Open |
| Q06 | Gemini CLI and OpenCode permission config formats and where they are read from | M3 exporters | Open |
| Q07 | Does `dsh acp` send `session/request_permission` for tool calls under its default approval settings, and which profile/settings make it ask? | M2 | Closed 2026-11-04: only for sandbox escalations; with `DSH_PERMISSION_MODE=read-only` every write asks. See [03-agents.md](03-agents.md#dsh-approvals) |
| Q08 | SQLite driver inside an Electron `utilityProcess`: `node:sqlite` or `better-sqlite3`? | M1 | Partly answered 2026-11-04: the CLI and tests use `node:sqlite` (`DatabaseSync`, Node 22.13+, no flag). Check inside Electron `utilityProcess` in M2 |
| Q09 | Pi packages to depend on (`@earendil-works/pi-agent-core`, the AI provider package) and their stability policy | M3 | Closed 2026-11-04: [ADR 0020](../adr/0020-fork-pi-agent-loop-track-upstream.md) — loop forked into `packages/herder-loop` and synced with upstream; `pi-ai` pinned behind `ModelClient` |
| Q10 | Idle detection for presence | — | Closed 2026-11-04: presence removed (ADR 0012) |
| Q11 | Windows support: named pipe for the local API, agent config paths | after v1 | Deferred: macOS only (ADR 0013) |
| Q12 | `pmset -a disablesleep 1` on current macOS / Apple Silicon: does it keep the system awake with the lid closed on battery and on power? Best way to ask for admin rights from Electron (`osascript ... with administrator privileges` or a helper)? | M2 keep-awake | Open |
| Q13 | Feishu: does an in-place card update (`im.v1.message.patch`) make a sound or badge on the phone? How does a pinned bot message show in a direct chat, and does pinning add a system message? Can a bot open topics in a direct chat? | M2 board, relay | Open (prototype sent, pinned and updated a board on 2026-11-04) |
| Q14 | Which agents accept `mcpServers` (stdio or http) in ACP `session/new`, so `herd_report` can be offered? DSH reports `mcp http` | M2 reports | Closed 2026-11-07: ACP makes stdio MCP mandatory, so every agent gets the stdio `agentherd` server; Pi ignores it (ADR 0041) |
| Q15 | Several Herders: how are they split (by project, by Feishu chat, by persona), and what does each keep apart (history, projects, model, rules)? Discussed 2026-11-04; one option was one Herder per Feishu group bound to projects, plus a default Herder in the direct chat | after M2 | Deferred: the owner finds it too complex for now. One Herder in the host; the desktop app lists Herders as a list so more can be added later |
