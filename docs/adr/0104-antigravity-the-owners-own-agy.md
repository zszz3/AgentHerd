# ADR 0104: Antigravity, the owner's own `agy`, with its own sign-in and models

- Status: Accepted
- Date: 2026-11-23
- Changes: [ADR 0069](0069-claude-code-the-owners-own-or-downloaded.md) (which agents there are)

## Context

- The owner (2026-11-23): 「我们要接入 gemini……应该是 agy……agy-acp（这里 agy 要全称）」, then
  「这两件事都不急，先做 agy 这件事」.
- Google's Antigravity CLI (`agy`) has an ACP server built in: `agy acp`
  ([docs](https://antigravity.google/docs/cli/acp)). A third-party Python adapter,
  [agy-acp](https://github.com/Kcrong/agy-acp), wraps the CLI too; with the built-in one it adds a
  layer and nothing else.
- Checked on the owner's Mac with `agy` 1.5.15 (signed in with Google): `initialize` answers
  "Antigravity ACP Server"; `session/new` lists the account's models (Gemini 4 Neon, Gemini 3.8
  Flash, Claude Opus 5.5 through Google, …), with a 1M context; `session/set_config_option`
  `model` switches the model; a small task took about 12 seconds.
- Its tool calls are `run_command` (`rawInput.CommandLine`) and `write_file` (with `locations`).
- The owner's own settings say `"toolPermission": "always-proceed"`, so with them no write or
  command asks. `--cli_dir_name <dir>` makes `agy acp` read its CLI settings from
  `~/.gemini/antigravity-cli/<dir>/`; the Google sign-in is shared and keeps working.

## Decision

1. **A built-in agent named 「Antigravity」** (id `antigravity`, not the short `agy`). It is the
   owner's own CLI: `AGENTHERD_ANTIGRAVITY`, then `agy` on `PATH`, then `~/.local/bin/agy` (where
   its installer puts it, often missing from an app's `PATH`). It is not shipped or downloaded.
2. **Started as `agy acp --cli_dir_name agentherd`.** AgentHerd writes
   `~/.gemini/antigravity-cli/agentherd/settings.json` with `"toolPermission": "request-review"`
   and no auto mode, so every edit, command, web and MCP tool asks over ACP and goes through
   AgentHerd's approvals like any other agent's. The owner's own settings are not touched.
   `CommandLine` counts as the command of a tool call, so the mass-delete rule sees it.
3. **Its own sign-in and models.** The profile has `ownModels`: AgentHerd's model list and keys are
   not used, no model env is given, and the first-turn model switch of ADR 0043 does not apply.
   Without a named model the task runs on what the owner set in `agy`. A model the owner names
   (`gemini-3.8-flash`, `claude-opus-5-5`) is set in the session with
   `session/set_config_option` and shown on the task.
4. **Only when the owner names it.** It spends the owner's Google quota, so AgentHerd never picks
   it by itself: the Herder passes `profile antigravity` when the owner asks for Antigravity, agy or
   Gemini. `session_list` marks it "own sign-in and models; only when the owner names it".
5. **On the Agent page** as a row with what it is, where it was found, and, when missing or not
   signed in, how to get it (「在终端运行一次 agy，用 Google 账号登录」).

## Alternatives

- **agy-acp (the Python adapter).** Needs Python and one more process; the built-in `agy acp`
  already speaks ACP.
- **Running it with the owner's own settings.** They may proceed without asking, which would skip
  AgentHerd's approvals.
- **`--dangerously-skip-permissions`, or `--app-data-dir` to another folder.** The first skips the
  approvals; the second must be a relative path and leaves the sign-in behind.
- **Picking it automatically for Gemini models.** The owner's Gemini models in AgentHerd's list run
  in Pi with the owner's key; Antigravity runs on a different account and quota.

## Consequences

- Antigravity works only where the owner installed and signed in to `agy`.
- AgentHerd cannot check which model names the account has before starting; a wrong name fails the
  task's start with Antigravity's own error.
- What a task costs is on the owner's Google account, not in AgentHerd's usage numbers.

## Tests

- `packages/host/test/agents.test.ts` "Antigravity (ADR 0104)": found in `~/.local/bin`, started
  with `acp --cli_dir_name agentherd`, `ownModels`, and the settings file.
- `packages/core/test/e2e/model.e2e.test.ts` "an agent with its own models": starts with an empty
  model list, no model env, the named model kept on the task.
- `packages/acp-client/test/connection.test.ts` setModel; `mapping.test.ts` `CommandLine`.
- Live: a task in the app with Antigravity (see the PR).
