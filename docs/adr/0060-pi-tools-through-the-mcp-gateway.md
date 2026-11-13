# ADR 0060: Bridge `agentherd` and stdio MCP tools into Pi

- Status: Accepted
- Date: 2026-11-13
- Builds on: [ADR 0022](0022-pi-through-a-bundled-acp-bridge.md) (`pi-acp`), [ADR 0041](0041-agent-tools-through-a-local-mcp-gateway.md) (MCP gateway), [ADR 0056](0056-leaving-the-mac-asks-and-questions-close.md) (leaving the Mac), [ADR 0058](0058-xiaohongshu-zhihu-and-watches.md) (小红书/知乎), [ADR 0059](0059-feishu-news-and-notes.md) (news sources)
- Changes: [03-agents §1](../spec/03-agents.md), [04-herder](../spec/04-herder.md), [07-delivery](../spec/07-delivery.md), [09-agent-tools §1, §3](../spec/09-agent-tools.md), [open-questions](../spec/open-questions.md)

## Context

Under [ADR 0031](0031-pick-the-agent-from-the-model.md), AgentHerd runs every non-GPT model (DeepSeek, Claude, Gemini, MiniMax, etc.) in Pi via `packages/pi-acp`. However, Pi has no native MCP client, and `pi-acp` ignored `params.mcpServers` on `session/new` and `session/load`.

As a result, Pi tasks were cut off from every tool hosted by `McpGateway`:
- `herd_report` and `herd_ack` (live progress reporting, immediate owner notices, and background work checks);
- connected Composio apps (`GMAIL_*`, `GITHUB_*`, etc.);
- 小红书 and 知乎 platform tools (`XIAOHONGSHU_*`, `ZHIHU_*`);
- read-only news tools (`GITHUB_TRENDING`, `HACKER_NEWS`, `ARXIV_SEARCH`).

That forced the Herder prompt and `session_list` to instruct the Herder to route any app or social task away from Pi (`profile` set to an agent other than Pi).

## Decision

1. **Pre-discover stdio MCP tools in `pi-acp` and load a self-contained Pi extension.**
   On `session/new` and `session/load`, `packages/pi-acp/src/bridge.ts` inspects `params.mcpServers` (stdio entries) and calls `tools/list` before spawning Pi. When tools are found, it writes them to a mode-`0600` JSON file inside a per-session mode-`0700` temp folder, passes the file path in `AGENTHERD_PI_MCP`, adds `-e extension/mcp.ts` to Pi's arguments, and deletes the temp folder when Pi exits or fails to start. Like `gate.ts` and `model.ts`, `extension/mcp.ts` uses only Node built-ins (`node:fs`, `node:net`, `node:child_process`).

2. **Socket fast path with generic stdio MCP fallback.**
   When an MCP server's env provides `AGENTHERD_MCP_SOCKET` and `AGENTHERD_MCP_TOKEN`, `extension/mcp.ts` speaks AgentHerd's length-unlimited line-framed socket protocol directly (without spawning a per-call relay process). Otherwise it spawns the stdio command (`initialize` → `notifications/initialized` → `tools/list` / `tools/call`). Discovery uses a 15s timeout and logs redacted errors without failing the session if a server is unreachable; `tools/call` imposes no short timeout because app approvals may wait on the owner. Tool errors (`isError: true`) throw an `Error` so Pi records `isError: true`. Built-in Pi tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) can never be shadowed by an MCP tool name.

3. **Avoid duplicate permission cards for `agentherd` gateway tools.**
   Every registered `agentherd` tool is marked `trusted: true` in `AGENTHERD_PI_MCP`. `extension/gate.ts` skips `session/request_permission` for trusted `agentherd` tools (unless shadowed by a built-in name), because `McpGateway` already enforces `approveAppCalls` and `outboundCheck`. Third-party stdio MCP servers keep `trusted: false` and still ask through `gate.ts`. Token values are redacted from logs and never included in temp filenames or command arguments.

4. **Remove the Pi exclusion from the Herder and UI.**
   The Herder no longer steers app or platform tasks away from Pi: AgentHerd picks the agent from the model as usual, and Pi sessions call `agentherd` tools just like Codex and DSH. `TaskRunner` also keeps `herd_report` timestamps aligned when an ACP `tool_call` update for `herd_report` arrives slightly after its socket call.

## Alternatives

- **Start long-lived stdio MCP processes inside `extension/mcp.ts` during Pi startup.** Harder lifecycle management across Pi reloads/aborts and adds async startup complexity inside Pi's extension loader; pre-fetching in `bridge.ts` keeps tool registration synchronous at extension load time while still passing `inputSchema` and `promptSnippet` cleanly to Pi.
- **Let `gate.ts` prompt on every MCP call.** Would pop two permission cards for one action (`gate.ts` `"other"` card plus `McpGateway` `"app"` card) and prompt for read-only calls like `herd_report`, `GMAIL_FETCH_EMAILS`, and `GITHUB_TRENDING`.

## Consequences

- Pi has parity with Codex and DSH for `herd_report`, `herd_ack`, Composio apps, 小红书, 知乎, and news feeds.
- Every task using `session/load` picks up the refreshed MCP task token from the new `session/load` request.
- `pi-acp` now touches the local MCP socket (or stdio server) once before spawning Pi; when a server fails `tools/list`, it falls back gracefully with a redacted stderr log and starts Pi without that server's tools.
