# 0108. Mi Home writes require exact owner confirmation

Status: Proposed (local experiment only; production writes disabled).

## Context

[ADR 0107](0107-mijia-uses-an-external-read-only-worker.md) keeps the optional worker,
login lifecycle and fixed read catalog separate from the upstream MCP catalog. A MIoT
descriptor validates identifiers, types and arguments, not the actual effects on a device.
A manual scene gives us an identifier and a name, not the steps it will run.

## Decision

Keep the production desktop and task gateway read-only until a separate review vets
operational eligibility. The desktop has no eligible write policy and the Host composes
only the two existing task reads. All Mi Home tool names stay reserved, including when
no account is connected. Do not add an environment override. Fictional eligibility
belongs only to inert fixtures.

Test two distinct confirmation paths behind that boundary:

- **Desktop:** only an Electron-owned Host utility has the private control port. A plain
  CLI Host or generic desktop Host socket cannot grant confirmation. An explicit Confirm
  is tied to the preview, account session and trusted Main document. Main checks the
  document again after the Host refresh and before granting dispatch. Document retirement
  before the final grant denies dispatch and invalidates the proposal. After the grant,
  losing the receipt is an unknown outcome, not proof that nothing ran.
- **Herder task:** the first actual ACP prompt delegated from a live native text message
  of the bound owner may ask. A retry after that prompt, mailbox or scheduled work, or
  socket-originated input cannot authorize it. The bound owner must click the dedicated
  card for that exact operation; a normal, bulk or text approval and an allow rule cannot
  substitute. A deny rule still applies. The decision, item state and audit commit before
  dispatch. The preview is never saved in the item or relayed to the desktop pet.

Both paths show the exact operation and arguments or refuse. They bind a single-use,
five-minute proposal to its origin and account, refresh the target before dispatch and
never replay a mutation. An explicit rejection, acknowledgement, matching read-back,
mismatch, unknown result and no dispatch are distinct. A post-dispatch uncertainty does
not recall a committed operation; the owner checks the device before taking another action.

## Consequences

Account setup and read behavior from ADR 0107 remain unchanged. A fake approval and one
simulated dispatch test the control flow, not the real device effect. Before enabling any
real operation, verify its effects and eligibility separately; unsupported descriptors,
shared-only targets and opaque scenes are not approved by shape or by name alone. Neither
entry point permits unattended writes. This ADR does not authorize a rollout or change
upstream installation or distribution requirements.
