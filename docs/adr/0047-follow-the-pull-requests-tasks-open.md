# ADR 0047: Follow the pull requests tasks open

- Status: Accepted
- Date: 2026-11-07
- Amends: [ADR 0046](0046-tell-the-owner-at-the-right-time.md) (one more reason to tell the owner)

## Context

super-agent (deepseek-ai/dsh-superagent-prototype) subscribes each ticket to the pull request it
opened: review comments, approvals and CI changes wake the worker, and a merge or close ends the
ticket with one chat notice (its `docs/003-execution.md`). AgentHerd only heard the owner's
Feishu messages: a task opened a pull request, a reviewer asked for changes or CI failed, and
nothing happened until the owner noticed and told the task.

The owner already has `gh` logged in on the machine (agents use it to open pull requests), and
AgentHerd has no public address for webhooks.

## Decision

- Core gets a `GitHubWatch` (`packages/core/src/github-watch.ts`), enabled by
  `HerdOptions.github = { run: GhRun, pollMinutes? }`. The host passes the real `gh`;
  `agentherd run` and tests without it follow nothing.
- At the end of a turn, pull request links in the reply and the `herd_report` summary are read
  with `gh`. A link is followed only when the `gh` user opened it after the task started and it is
  open. Watches are stored in table `pr_watches` (schema 9) and survive restarts.
- Every 2 minutes each watch is read (`gh pr view`, and the REST lists of issue comments, reviews
  and line comments). New items by people wake the task with one prompt quoting them, marked as
  coming from GitHub, and tell the owner in one line linked to the task. A bare approval is only
  told. Bots never wake or notify. Failed checks (all finished) go to the task once per head
  commit, with an alarm-toned line to the owner. A merge or close is told once and ends the watch.
- Because the agent and the owner share one `gh` account, the account's own comments are treated
  as the agent's when they appear while the task works or before its ended turn was looked at;
  only those written while the task is idle count as the owner's.
- Limits: 20 wakes per pull request, 14 days without activity, first 100 items of each list.

## Considered

- **Webhooks.** Need a public URL or a relay service; polling with `gh` works on any machine.
- **Following every pull request of the repo, or new issues (super-agent's admission).** Starting
  work the owner did not ask for needs a policy and owner confirmation; left for later.
- **Gmail and other Composio apps.** Composio triggers deliver by webhook or its own websocket;
  not done here. Mail is watched on request instead ([ADR 0048](0048-watch-mail-only-when-asked.md)).

## Consequences

- Review → fix → push loops run without the owner relaying them; the owner sees each step.
- A comment the owner writes with the same account while the task works is taken as the agent's
  and does not wake it; the owner can tell the task directly.
- Each followed pull request costs 4 `gh` calls every 2 minutes.
