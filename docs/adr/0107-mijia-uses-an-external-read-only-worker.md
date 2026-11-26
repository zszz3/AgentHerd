# 0107. Mi Home uses an external read-only worker

Status: Proposed (local experiment only).

## Context

Do1e's `mijiaAPI` can scan a Mi Home QR code and query devices through its local MCP
server. Its catalog can also operate physical devices, and its login file carries
account credentials. We want to test reads without making the whole catalog or
account credentials available to agents.

## Decision

Start the owner-installed Python runtime only when the owner clicks Connect.
Require `mijia-api` 5.0.0 and use stdio without a shell. The Host keeps one worker
for the scan and the subsequent reads. Its temporary login directory is not reused
and normal shutdown, cancellation or disconnect removes it after the worker exits.
An abrupt process or machine stop can leave temporary files; this is not a durable
credential store. Use a trusted local runtime and a private OS user account and
temporary directory.

Expose a fixed, read-only catalog through the existing task gateway. Project device
metadata and supported status values instead of returning raw cloud responses.
Do not expose authentication, arbitrary upstream calls, device writes, scenes or
automation through the gateway. [ADR 0108](0108-mijia-writes-require-exact-owner-confirmation.md)
adds a separately gated confirmation design at the write boundary; the production catalog
here remains read-only. The desktop displays a bounded PNG fetched by the
Host from the Mi Home account origin; no open URL or redirect is allowed.

## Consequences

No runtime is installed, updated or distributed by AgentHerd. The account must
be reconnected after a Host restart. Real QR issuance and device behavior must be
verified separately; the mandatory offline tests use a simulated upstream. Resolve
upstream distribution and service terms before shipping an installer or release.
