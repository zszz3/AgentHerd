# DingTalk office tools in AgentHerd

## Decision

Add DingTalk under **应用连接 → 账号**. The owner authorizes one DingTalk identity and organization on DingTalk's official page. A task uses the resulting connection through its existing `agentherd` MCP gateway. AgentHerd's owner and decision channel remain on Feishu. The Herder does not gain direct access to DingTalk content.

Use the official [DingTalk Workspace CLI](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/tree/v1.0.69) as a host adapter. Its user authorization covers group history as well as calendars, documents, and AI Minutes. The official remote MCP option requires separate credential-bearing URLs for different tool sets, and the public group MCP does not expose message history. Giving tasks direct CLI access would bypass the tool catalog and approval route. Do neither in this release.

## First release

| Area | Tools | Limits |
| --- | --- | --- |
| Calendar | List scheduled events; create an event | Require an explicit time zone or offset when creating an event. Display the title and exact time in the confirmation. Include any supported participants in the confirmation. |
| Documents | Search by title; read body; create a document | Create with inline text only. Include the title and known destination in the confirmation. Do not import or export local files, edit existing documents, or change sharing. |
| Group chat | Find a group; search messages; read its history; send a text message | Resolve a unique group before a write. Confirm and send against the same group ID, not a name resolved again at execution. No direct messages, attachments, or incoming chat events. |
| AI Minutes | Search visible meeting notes; read summary and transcript | Respect bounds on pages and output. This is not a list of every video meeting the owner has attended. |

The account row shows connection status, available tool categories, authorization failures and a disconnect action. Authorization does not imply every listed operation is allowed: DingTalk still applies the organization's CLI, agent-channel and business-domain permissions. If the organization blocks a request, the result explains that restriction without leaking CLI output or credentials. Do not switch organizations or credentials automatically.

## Implementation seams

- **DWS adapter in `packages/host`.** Pin and verify the official native CLI against the supported desktop targets before choosing the packaging details. Launch it without a shell, with deadlines and bounded output. Use its [official login and status commands](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/v1.0.69/internal/app/auth_command.go) and a [dedicated `DWS_CONFIG_DIR`](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/v1.0.69/internal/app/config.go). Test that the pinned build also isolates any OS-backed credential storage; a config directory alone does not prove that. Keep the authorization exchange and credentials out of agent context, settings, logs, approval cards and the database. Reuse only the account lifecycle behavior that fits both providers; do not copy WeCom's QR-file contract into DWS. Disconnect cancels the login or active calls, invalidates pending calls, and clears only this local connection. Server-side grant revocation is separate.
- **Curated task tools behind `AppTools`.** Each slug has a fixed input schema and routes to one reviewed operation. Preflight validates fields and constructs immutable execution arguments. Never pass through raw flags, paths or arbitrary command names. Use stdin for document text if the pinned CLI supports it without file interpolation. Where an input can name a remote resource, accept a validated identifier rather than accepting a local path. Do not parse prose from a command's stdout as a successful data result. Keep provider data in the tool result, not in approval records or automatic context. If a result is partial, expose that explicitly.
- **Shared task approvals.** Reuse the WeCom preflight and owner-only approval flow. Where it names `builtin:wecom` directly, add only the shared policy needed by both providers. Verified read tools follow the existing policy and respect explicit denies. All three writes require a fresh Feishu owner confirmation even in auto mode or when a rule would allow the write. The card shows a redacted target and key parameters, plus a bounded content preview for messages and documents. Reject stale approvals after account switch, disconnect, or a newly applicable deny. Never retry a write automatically after a network error or timeout leaves its outcome unknown. Within the AgentHerd gateway, reject attempts to route these tools through Composio meta-tools. The connector does not sandbox a separately installed CLI or an agent's shell.

Keep provider commands inside the adapter and approval enforcement inside the gateway and core. Removing either seam would spread CLI rules or policy checks across tool handlers. Tests cross the `AppTools` and account interfaces with real and fake CLI adapters; test approval behavior through the gateway instead of testing only the rule helper.

## Acceptance

- From the desktop, an owner can authorize one organization, see or cancel a pending authorization, disconnect, and reconnect. A disconnected or failed account does not advertise tools. Verify isolation from the owner's standalone DWS login and from WeCom.
- Through a task, exercise each read and representative pagination, no-access, and timeout cases. Malformed or oversized responses fail as tool errors. Unknown tools and local file inputs are rejected.
- Confirm each supported write arrives at the fake CLI once with the exact approved target and inputs. Rejection, a deny rule, stale connection, or a Composio meta-tool invocation results in no write. Confirm WeCom and other app policies retain their prior behavior.
- Verify the pinned executable in the Windows and macOS packaging paths. A real-tenant smoke test needs an authorized user and a test group, calendar, and document destination; keep its result separate from automated tests and do not make real writes without confirmation.

## Integration

Develop on `feat/dingtalk-dws` in its own worktree, based on the reviewed WeCom implementation. Do not change the WeCom working directory or branch. After WeCom merges, align the DingTalk changes with the merged main before opening a standalone pull request. Update [Agent tools](../spec/09-agent-tools.md), the [delivery scenarios](../spec/07-delivery.md), and the ADR index alongside the implementation.
