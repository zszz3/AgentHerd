# ADR 0029: Only a mass delete asks the owner; AgentHerd approves everything else

- Status: Superseded by [ADR 0056](0056-leaving-the-mac-asks-and-questions-close.md) (the mass-delete check stays)
- Date: 2026-11-05
- Changes: the approval pipeline in [04-herder §3](../spec/04-herder.md#3-approval-pipeline)

## Context

Every permission request without a matching rule went to the owner. With DSH in read-only mode,
OpenCode asking before edits and Codex in read-only mode, that is a card for almost every step,
and a task stops while the owner is away. The maintainer (2026-11-05): "简单的命令不需要任何批准，
我们只批准很重要的一些决策和操作，比如说要删特别多东西之类的". Asked which kinds should still
ask, they answered "除了rm .这种，其他都不要问我". OpenBot also has no dangerous-command list;
new agents get full access and their approvals are accepted without a card.

## Decision

- In `assist` and `auto` mode a permission request goes to the owner only when it is a **mass
  delete** (`packages/rules/src/mass-delete.ts`): deleting the project folder itself, a folder
  above it, the home folder, `/` or anything outside the project; emptying a folder (`*`, `.*`,
  `dir/*`); targets unknown before running (a variable, `xargs rm`, `find -delete` or
  `find -exec rm` without a name filter); `rm` after a `cd` the check cannot follow; a command
  the parser cannot read that mentions `rm`.
- Anything else is approved by AgentHerd (decision source `rule`, reason `auto-approved`, in the
  audit log, not listed in the report). `git push --force`, `sudo`, reading `.env` no longer ask.
- The owner's rules still apply: a `deny` rule still denies. A mass delete asks even when an
  `allow` rule matches.
- Entries the owner adds to `extraGuards` in `config.json` still always ask.
- `observe` mode is unchanged: everything goes to the owner, rules only suggest.
- The Herder's own tool calls keep the full built-in guard list; the Herder still cannot approve.
- Changed 2026-11-23: deleting anything inside a temporary folder (`/tmp`, `/private/tmp`,
  `/var/tmp` and the system's own `os.tmpdir()`) never asks, even all of it (`rm -rf /tmp/*`);
  deleting the folder itself still does. A task's `rm -f /tmp/t3-desktop.log` before a build had
  come to the owner as 「高风险」, because `/tmp` is outside the project. The owner: 「删tmp里的东西都
  无所谓啊」. A path given through a variable (`$TMPDIR/x`) still asks: its value is unknown.

## Consequences

- Fewer cards; a task runs on its own unless it is about to delete a lot.
- A harmful command that is not a delete (force push, leaking a secret) runs without asking. The
  owner can add `extraGuards` entries or `deny` rules for what they want stopped.
- The built-in guard list (`guardCheck`) is no longer used for agent requests, only for the
  Herder's tools.
