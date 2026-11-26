# ADR 0106: DeepSeek Harness, the owner's own DSH desktop app, as an agent

- Status: Accepted
- Date: 2026-11-24
- Changes: [ADR 0066](0066-pinned-agents-and-claude-code-for-hard-work.md) (decision 3: DSH is an agent again,
  the owner's own app, not shipped or patched)

## Context

- The owner (2026-11-24): 「你看下Agent这里，项目接入dsh」, then 「这个任务你来做吧」.
- ADR 0066 removed DSH because other owners do not have the large nightly app and AgentHerd had to
  patch its models (ADR 0042). Neither holds for an agent that is only the owner's own app, like
  Antigravity (ADR 0104).
- Checked on Windows with DeepSeek Harness 0.2.1-rc.2:
  - The installer registers an uninstall entry (`DisplayName` "DeepSeek Harness …",
    `InstallLocation`). The app's CLI is `resources/runtime/cli/bin/dsh.cmd`; on macOS
    `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`. A `dsh` on `PATH`
    may be an old npm package that no longer runs.
  - `dsh acp` starts the ACP server; the `acp` profile is created from the app's template on first
    use, so there is nothing to install. Models and sign-in are those set up in DSH.
  - `session/new` lists the models as a grouped `model` select whose values are JSON ids such as
    `["personal-claude","claude-opus-5-5"]`; an unknown value is refused
    (`Invalid params: unknown model option`).
  - By default writes and commands run without asking. With `DSH_PERMISSION_MODE=read-only` every
    write asks over ACP (allow once / reject once) and a rejection is honoured; read-only commands
    run in DSH's sandbox without asking, as with Codex's read-only mode.

## Decision

1. **A built-in agent named 「DeepSeek Harness」** (id `dsh`). Found from `AGENTHERD_DSH`, then the
   installed app (the uninstall entries on Windows, the app bundle on macOS), then `dsh` on `PATH`.
   The app comes before `PATH` because a stale npm `dsh` is common. It is not shipped or
   downloaded.
2. **Started as `dsh acp` with `DSH_PERMISSION_MODE=read-only`**, so edits go through AgentHerd's
   approvals like any other agent's.
3. **Its own models**, as in ADR 0104 (`ownModels`). A model the owner names is matched to one of
   the session's model ids — the exact id, the model part of the id, or the display name — and
   set with `session/set_config_option`; without one the task runs on DSH's default.
4. **Only when the owner names it.** The Herder passes `profile dsh` when the owner asks for DSH or
   DeepSeek Harness.
5. **On the Agent page** as a row; when the app is missing it says to install DSH and set up its
   models.

## Alternatives

- **The npm `dsh` package.** Not kept in step with the app; the copy found here fails to start.
- **DSH's default mode.** Writes and commands would skip AgentHerd's approvals.
- **Passing AgentHerd's model list to DSH** (ADR 0042). That is what ADR 0066 removed; DSH has its
  own.

## Consequences

- DeepSeek Harness works only where the owner installed it and set up a model.
- Read-only commands run without asking, inside DSH's sandbox.
- What a task costs is on the owner's DSH providers, not in AgentHerd's usage numbers.
- DSH writes a non-JSON log line on stdout; the ACP SDK skips it.

## Tests

- `packages/host/test/agents.test.ts` "DeepSeek Harness (ADR 0106)": install folders from the
  registry, the app before `PATH`, started with `acp` and read-only, `ownModels`.
- `packages/acp-client/test/mapping.test.ts` `modelValue`; `connection.test.ts` a named model set by
  its DSH id.
- Live (2026-11-24, Windows, DSH 0.2.1-rc.2): found through the registry; `claude-sonnet-5-5` set;
  a write asked, was denied, and the file was not created.
