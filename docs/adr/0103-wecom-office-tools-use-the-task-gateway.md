# ADR 0103: WeCom office tools use the task gateway

- Status: Proposed
- Date: 2026-11-23
- Related: [ADR 0041](0041-agent-tools-through-a-local-mcp-gateway.md), [Agent tools](../spec/09-agent-tools.md)

## Context

The owner wants one WeCom account connection for several office services without adding a
second way to control AgentHerd. WeCom's remote MCP setup requires a separate credential-bearing
URL per capability. Its [official CLI](https://github.com/WecomTeam/wecom-cli) supports one QR login.

## Decision

Use the pinned official CLI in the host with a dedicated local config directory. Show the short-lived
login QR only in desktop settings. Let the CLI store its own credentials; keep them out of AgentHerd
settings, the database and agent context. Register office methods as typed task tools from the CLI
catalog. Do not offer an arbitrary CLI command, local file transfer, incoming chat events or chat history.

Verified read operations follow the existing read policy. Every write or uncertain operation requires the
existing Feishu owner decision, even if an allow rule or auto mode would otherwise permit it. A task
cannot use a tool confirmed for a previous login after the owner disconnects or switches accounts.

## Alternatives

- A WeCom channel: adds a second control surface the owner does not want.
- Manually imported MCP URLs: avoids a local process but makes the owner copy configuration per capability.
- A shell tool or CLI skill: makes it harder to constrain methods, file access and approvals.

## Consequences

The CLI catalog describes supported methods, not the permissions of the logged-in owner. WeCom
still decides whether to accept each request. Disconnect clears the local login; revoking grants in WeCom
is separate. The official npm binary includes [upstream call-chain reporting](https://github.com/WecomTeam/wecom-cli/blob/main/docs/data-collection.md).
