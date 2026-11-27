# ZCode tasks

## Purpose

Let an owner use their installed ZCode agent and its account for a task while receiving the usual AgentHerd approvals and completion report.

## ADDED Requirements

### Requirement: Run the owner's installed bridge

AgentHerd SHALL launch the owner's installed ZCode ACP bridge, use its backend discovery, and pass through an explicit `ZCODE_BIN` override. The Agent page SHALL identify a missing bridge and give actionable guidance for backend or sign-in failures reported by the bridge.

#### Scenario: Use the bridge's default backend

- **WHEN** the owner starts ZCode with no backend override
- **THEN** the bridge can use the CLI on its process `PATH`, including when both installations exist
- **AND** a discoverable ZCode Desktop backend is sufficient when the standalone CLI is absent

#### Scenario: Select the desktop backend explicitly

- **WHEN** both backends exist and the owner sets `ZCODE_BIN` to the desktop entry
- **THEN** the bridge uses that entry for the task

#### Scenario: An installation or account needs attention

- **WHEN** the bridge is missing, or it reports a missing backend or unusable sign-in
- **THEN** AgentHerd identifies the failing step, tells the owner what to check and keeps credentials out of the diagnostic

### Requirement: Dispatch ZCode on the owner's request

AgentHerd SHALL use the ZCode profile only when selected by the owner for the task. ZCode SHALL use its own account and default model unless the owner explicitly selects a supported ZCode model. The Herder SHALL use its configured model for natural-language dispatch.

#### Scenario: Start directly with no AgentHerd model service

- **WHEN** the owner sends `/run zcode <dir> <task>` with a usable ZCode account and an empty AgentHerd model-service list
- **THEN** the task runs on ZCode with its default model and the owner receives the usual task report on completion

#### Scenario: Name ZCode in a request to the Herder

- **WHEN** the owner asks a configured Herder to use ZCode for a task
- **THEN** the Herder starts the ZCode worker in the selected task workspace with the owner's task text preserved

#### Scenario: ZCode is installed and a task names no agent

- **WHEN** an ordinary task starts without a request to use ZCode
- **THEN** AgentHerd does not select ZCode, including when it is the only installed profile

### Requirement: Verify approval behavior before work

AgentHerd MUST verify the effective ZCode session mode (`build`) before sending the first task prompt on a new or restored session. File writes, gated shell commands (including `rm -rf`, Windows wrapped deletes such as `cmd //c del` and `powershell Remove-Item`, `sudo`, and `git push`), and external-action tools (`WebFetch`) forwarded by ZCode's `build` mode MUST reach AgentHerd's existing approval pipeline before execution. By upstream ZCode 4.0.0 design (accepted for `zcode`), ZCode runs its built-in `Read` tool (both inside and outside `cwd`) and harmless read-only commands (`ls`, `echo`) without issuing `session/request_permission`; those unforwarded reads do not enter AgentHerd's `guard` pipeline, while outbound tools and writes stay gated. If the mode or a forwarded permission decision is unavailable, ambiguous or times out, the action MUST NOT proceed.

#### Scenario: A session starts or resumes in an unrestricted mode

- **WHEN** a fresh or restored session reports an unrestricted mode
- **THEN** AgentHerd establishes and verifies a supported approval mode before dispatching work, or stops and tells the owner why the session cannot run

#### Scenario: A guarded action is denied on a new or resumed task

- **WHEN** ZCode requests an action that the pipeline refers to the owner
- **THEN** the owner sees the action and its target through the normal approval channel before it runs
- **AND** denying it leaves the target untouched

#### Scenario: The owner allows an action

- **WHEN** the bound owner approves a pending action for this request
- **THEN** ZCode receives the matching one-time decision and can finish the task
- **AND** a non-owner response cannot grant permission

#### Scenario: The session drifts to another mode mid-turn

- **WHEN** a running session reports a mode other than the established `build`
- **THEN** AgentHerd ends the task instead of continuing under an unverified mode
- **EXCEPT** a drift to `plan`, the one mode a live probe (2026-11-27) showed to execute no mutation and issue no permission request, so the approval property holds and the task may continue

### Requirement: Preserve the account choice across recovery

AgentHerd SHALL exclude ZCode from automatic fallback for other tasks. When a ZCode task cannot continue on ZCode, AgentHerd SHALL inform the owner and require an explicit choice before starting work on a different agent or account.

#### Scenario: Another agent fails

- **WHEN** an ordinary task cannot start its next turn or reopen its original agent
- **THEN** AgentHerd never starts ZCode as an automatic substitute

#### Scenario: ZCode loses a saved session

- **WHEN** the saved ZCode session cannot load but a fresh ZCode session is usable
- **THEN** the task can continue on ZCode using existing task history after verifying the new session's permission mode

#### Scenario: ZCode itself is unavailable

- **WHEN** a ZCode task cannot start or reopen on the selected account
- **THEN** the owner is told what failed and no alternative account or agent starts without their choice
