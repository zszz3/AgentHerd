# 0105. DingTalk office tools use the pinned Workspace CLI

Status: Accepted

## Context

DingTalk's public MCP services cover calendar, documents and AI minutes, but the public group service does not provide group history. The official Workspace CLI (DWS) can use the owner's user authorization across all four domains. Passing through an arbitrary CLI command would bypass the task gateway's tool and approval boundary.

## Decision

Ship the official CLI at a verified version. Use the same account placement and task gateway as [WeCom](0103-wecom-office-tools-use-the-task-gateway.md), but use DingTalk's browser authorization. Keep its configuration and credential storage separate from other DWS installations. Pass only a selected user and organization, never the authorization URL or tokens, over the account lifecycle inside the host; the desktop sees only display labels, state and tool categories.

Use an explicit catalog and fixed command arguments. Validate reads, page bounds and target groups before dispatch. Do not expose a generic CLI, direct messages, local file input, inbound events or a direct Herder tool. AI minutes are not a complete video meeting history.

A group text, new calendar event or new document needs one fresh confirmation from the bound owner on a dedicated Feishu card. Text and batch approvals cannot authorize it. An explicit deny prevents provider preflight and is checked again after confirmation and account verification. Disconnect or account change invalidates the prepared command. Never automatically retry an uncertain write. Disconnect clears only the local AgentHerd login; if cleanup is interrupted, the next launch will not restore the old account. The owner can revoke the organization grant separately.

## Consequences

The organization must enable CLI access and grant the user the corresponding business permissions. Tool badges do not prove that authorization. Updates to DWS must renew the pin and verify the response contracts. Automated tests use fake accounts and do not make DingTalk writes; platform packaging and organization access are verified separately.
