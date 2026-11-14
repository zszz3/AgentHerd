# ADR 0061: Small news goes on the task board; unread messages come back

- Status: Accepted
- Date: 2026-11-14
- Builds on: [ADR 0019](0019-relay-verbatim-board-and-reports.md) (pinned task board), [ADR 0049](0049-short-messages-written-by-the-agent.md) (`herd_ack`), [ADR 0051](0051-keep-following-pull-requests-after-they-close.md) (pull requests wake their task), [ADR 0053](0053-the-herder-tells-task-results.md) (the Herder tells results)
- Changes: [04-herder](../spec/04-herder.md) ("When the Herder runs", "Completion report", "Acknowledgement", "Notices", "Pull requests", tools), [07-delivery](../spec/07-delivery.md), [09-agent-tools §2](../spec/09-agent-tools.md) (`herd_ack`)

## Context

The owner follows AgentHerd on a phone. Everything AgentHerd says rings it, and some of it is
not worth a ring. One pull request from open to merge sent about nine messages: for every round
of review comments the task's one-line `herd_ack` and then the Herder's words about the result,
one message per bare approval, and one for the merge. The owner only needed to hear when they had
to decide something.

The same holds for a task the Herder started for the owner: the Herder already said 「好，我让 Pi
去做了」, so the task's `herd_ack` says it a second time, and a model switch before the agent did
anything is not something the owner can act on.

[DeepSeek's SuperAgent write-up](https://zhuanlan.zhihu.com/p/2104223372263671295) describes the
same problem: most events need no human, and a message that was *delivered* to an agent is not one
it *read*. AgentHerd had a hole there too: a message queued for a task that ended before reading it
(the owner's reply, the Herder's follow-up) was dropped with only an error in the log.

## Decision

1. **Three levels.** Each informational notice has a level: `push` (a message to the owner now),
   `board` (only the task's row on the pinned board changes, ADR 0019; the phone stays quiet) or
   `off` (only the audit log). The level is decided by code from the notice's kind, never by a
   model; senders know what they send, so there is no guessing where a message came from.

2. **What goes on the board by default.** The kinds the owner can change (`NOTICE_KINDS` in
   `packages/core/src/notices.ts`), all `board` by default:

   | Kind | What |
   | --- | --- |
   | `pr-approved` | someone approved a task's pull request without a comment |
   | `pr-merged`, `pr-closed`, `pr-reopened` | a task's pull request was merged, closed, reopened |
   | `pr-follow-up` | the result of a turn its pull request woke, when the task handled it on its own (stage done) |
   | `task-ack` | the `herd_ack` line of a turn the owner did not ask for directly (the Herder started it, or its pull request woke it) |
   | `model-switched` | a task moved to another model before it did anything (ADR 0030), in such a turn |

   Everything else is pushed and cannot be turned down: results the owner asked for (also through
   the Herder), questions, approvals, a task that needs the owner, is stuck or failed, watchdog
   alarms, comments no task can take and failed checks no task fixes, and the mail and platform
   notices the owner chose to watch.

3. **Who asked for a turn.** Prompts carry `from`: `owner` (the owner's own message, typed or
   replied to a task), `herder` (the Herder's `session_start` and `session_prompt`) or
   `pull-request` (a pull request woke the task). A background check belongs to whoever asked for
   the work. A turn the owner asked for directly acknowledges as a reply to their message, as
   before; a `pull-request` turn that ends done goes on the board without asking the Herder for
   words; one that needs the owner (`herd_report` waiting), is stuck or failed is pushed as usual.
   The pull request prompt tells the agent to use `herd_report` waiting when the owner has to
   decide.

4. **The owner changes levels through the Herder.** `notice_level(kind, level)`, owner turns
   only; `session_list` shows every kind's level. Saved in herd.db state `notice.levels`, only the
   kinds that differ from the default. No app page.

5. **The Herder still learns everything.** Events carry `shown` (unset = sent to the owner,
   `board`, `none`); the Herder sees them under "[Already sent to the owner]" or
   "[Not pushed to the owner]" in front of its next turn, and brings one up only when it matters
   to what the owner asks.

6. **A message a task never read comes back.** When a task ends with prompts still queued:
   the owner's go to the Herder as the owner's message, after an `unread` event naming the task
   and why it ended, and the Herder sends it again with `session_prompt` (which opens the task
   again) or answers it; the Herder's, or the owner's when there is no Herder or AgentHerd itself
   is stopping, are shown to the owner (「这条没送到：任务还没读到就结束了（…）」, at most 300
   characters of it) as a message whose reply opens the task again. A pull request's prompt that
   never reached its task is told by the watch (comments, failed checks) as when no task can take
   it. Background checks need nothing.

## Alternatives

- **A model sorts every message.** Costs a call per message, can be talked into anything by the
  text it sorts, and is not needed: every sender knows what it sends.
- **A daily digest instead of the board.** The board already exists, is pinned and updated in
  place; a digest would be one more message and late for anything that matters.
- **Let the owner change every kind.** Results, questions, approvals and failures need the owner;
  turning them down would only hide what the owner must do.

## Consequences

- One pull request from open to merge rings the phone once (the result the owner asked for) unless
  something needs the owner; the rest is on the board.
- The owner sees less of what tasks do on their pull requests; the board row and the Herder (who
  knows every event) answer when they ask.
- Notice levels are global, not per project or per pull request.
- Messages are no longer lost when a task ends first; the owner may see a message come back that
  they had expected the task to read.
