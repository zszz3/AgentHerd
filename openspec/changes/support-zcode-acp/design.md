# Design

## Context

The [proposal](proposal.md) records the owner-facing behavior and local resolver checks. AgentHerd already has two relevant precedents. Claude Code and Codex use external ACP bridges. Antigravity owns its login and models and runs when requested. ZCode combines those two properties. Its bridge version and its backend version can change independently.

## Goals / Non-Goals

Use one ZCode profile with the existing task workspace, approval pipeline and report flow. The owner can start the worker directly or name it to a configured Herder. The Herder's inference provider, installation of third-party software and other contribution ideas in the proposal are outside this change.

## Decisions

### Let the bridge own backend discovery

Register the owner-installed `zcode-acp` command with the explicit `server` argument in the [host catalog](../../../packages/host/src/catalog.ts). The argument selects stdio even if the launcher could open a terminal UI. Use the host's existing command discovery, Windows launcher handling and Agent page. Give the profile `ownModels`. Keep the worker account inside ZCode and pass through an explicit `ZCODE_BIN` or `ZCODE_NODE` in the bridge environment. The bridge already handles the CLI on its own PATH and desktop bundle discovery, including the Windows registry. A second backend locator in AgentHerd would give the desktop page and the worker two potentially different answers.

Separate “bridge found” from “worker can run.” The [host verification action](../../../packages/host/src/verify.ts) opens a session in a temporary folder without sending a model prompt. ZCode can defer materializing the backend session. Report the stage actually reached, and distinguish an explicit sign-in error from a missing executable or protocol failure. An advertised sign-in method is a capability, not evidence that the account has expired or that a particular plan was billed. Use existing redaction on errors returned to the page and host log.

### Establish the permission mode on the session that will run the task

First qualify a real bridge/backend pair in a disposable workspace. Record the effective mode, the evidence that it came from the running session, the permission options and the result of a denied local action. Use the capabilities AgentHerd actually advertises, including its existing `session/request_permission` handler. Exercise a file edit and a harmless command whose effect is observable, with a decision required by the test policy. Also check how any enabled external-action tools request approval using a harmless stand-in. An operation that AgentHerd must guard cannot be allowed to execute outside the pipeline.

In bridge 0.88.0 the default is `yolo`. Stored bridge settings take precedence over `ZCODE_ACP_MODE`. The advertised `guarded` mode covers only some commands, and the bridge can report a default mode if the real session is pending or its state read fails. Selecting a mode by its name or trusting the initial mode menu would give a false positive. Test a session-scoped ACP mode change (such as `session/set_mode`) and its confirmation from the live backend. Keep only a mode and confirmation path whose behavior the qualification demonstrates. If the bridge offers no reliable one, stop this integration at the compatibility finding and return it for review. Do not change the owner's ZCode settings.

The [ACP client](../../../packages/acp-client/src/connection.ts) currently returns only the session ID from creation and discards the load response. Make session preparation available at that boundary, preserving existing callers' return values. Bind confirmation to the specific connection and session ID. Apply it after creation, after loading a saved session, and after creating a replacement when a saved session is gone. Do this before sending work, including replayed task history. On rejection, timeout, ambiguous evidence or disconnection, close the attempted connection and report the failure. A readiness check that claims this capability must use the same preparation path.

Use the existing tool-call tracker and one-time decision mapping. Qualify that ZCode's permission request identifies the actual action and target, including when it refers to an earlier tool-call update by ID. Unclear requests follow the existing escalation policy. The Herder cannot answer a permission request. Only the owner can answer a card referred to them.

### Keep account selection explicit on start and recovery

The fixed [owner command](../../../packages/core/src/owner-commands.ts) selects a profile directly. For natural language, update the [Herder tools](../../../packages/herder/src/tools.ts) and prompt so a request naming ZCode uses that profile and carries the owner's words. Reuse the existing `ownModels` branch. Omit the worker model unless the owner names one. Propagate a rejected explicit model as a start failure. The Herder still needs its own configured model for natural-language requests.

Apply the ZCode selection rule at the automatic chooser and at recovery, including when ZCode is the only available profile. The [task runner](../../../packages/core/src/task-runner.ts) currently tries the saved profile, then Pi, then the remaining profiles. For a saved ZCode task, retry within ZCode and preserve the existing load-or-replay behavior. If ZCode is unavailable, tell the owner and wait for an explicit choice through the existing owner interaction. For other tasks, exclude ZCode from automatic candidates and preserve their relative order. Use the saved profile ID to recognize a ZCode task even when its executable is now missing.

## Risks / Trade-offs

| Risk | Response |
| --- | --- |
| Backend updates change a mode or its permission behavior | Record exact versions in live evidence. Treat unsupported or unverifiable behavior as a compatibility failure and surface it to the owner. |
| Retrying a failed resume could send work before session preparation | Test load success, same-profile replacement, and preparation failure. Assert the order of ACP calls and the absence of a task prompt on failure. |
| A successful login or task is mistaken for a billing measurement | Use a non-secret account or usage indicator if available. Otherwise record the successful task and leave quota attribution unverified. |

## Migration Plan

The change adds an owner-installed profile and uses existing task and session storage. Existing installations require no data migration. Removing the bridge makes ZCode unavailable. A saved ZCode task should remain identifiable so recovery can explain which agent the owner needs.
