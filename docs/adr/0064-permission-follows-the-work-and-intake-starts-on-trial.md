# ADR 0064: Permission follows the work, and automatic intake starts on a trial run

- Status: Accepted
- Date: 2026-11-14
- Builds on: [ADR 0056](0056-leaving-the-mac-asks-and-questions-close.md) (steps that leave the Mac ask unless allowed), [ADR 0057](0057-decisions-the-owner-made.md) (decisions the owner made), [ADR 0051](0051-keep-following-pull-requests-after-they-close.md) (pull requests wake their task), [ADR 0052](0052-offer-new-github-work-when-asked.md) (new GitHub work)
- Changes: [04-herder](../spec/04-herder.md) (§3 approval pipeline, pull requests, new work), [07-delivery](../spec/07-delivery.md)

## Context

ADR 0056 lets a task do the steps that leave the Mac which the owner's request named:
「做完推上去开个 PR」 gives the task `push` and `pull-request`. Two things were loose.

- **The permission outlived the request.** A task keeps its allowed steps for its whole life. A
  week later a stranger comments on its pull request, the comment wakes the task, and the turn
  that answers the stranger still may push anywhere, comment and open pull requests without
  asking. The owner allowed those steps for the work they asked for, not for whatever a comment
  asks. 郑天's article on DeepSeek's SuperAgent (「关于 DeepSeek 的 SuperAgent，以及我们的实践」)
  calls this out: a permission belongs to the piece of work it was given for (its "mandate"), and
  work that resumes later is checked again against what was allowed.
- **The Herder filled in `allowed` by itself.** `session_start` took the Herder's list as it came.
  A Herder that misread the owner, or read an issue body that said "push it and merge", could
  hand a task steps nobody allowed.

ADR 0052 also lets the owner make an intake watch automatic: a new issue or review request starts
a task by itself. The first time the Herder runs that on its own, nobody has seen how it decides
(which project, which agent, what it allows). The same article runs every new automatic rule as a
dry run first, writing down what it would have done and why, until a person has seen enough.

## Decision

1. **A turn a pull request woke may only push to that pull request's branch.** The pull request
   watch keeps the branch (`headRefName` from `gh pr view`, `pr_watches.branch`). In a turn whose
   prompt came from the pull request (`turnFrom` `pull-request`, ADR 0061), of the task's allowed
   steps only `push` still runs, and only a `git push` that names nothing but those branches, or a
   bare push from a folder whose checked-out branch is one of them (`pushPlans` in
   `packages/rules/src/outbound.ts`, which follows `cd` and `git -C`). `--all`, `--tags`,
   `--mirror`, a deletion, another branch, a refspec into other refs, a command that cannot be
   parsed, and every other step that leaves the Mac (comments, merges, new pull requests, app
   calls) ask the owner again, with 「这一轮是 PR 上的新动静唤醒的，开任务时你给的许可这时只放行推到这个
   PR 的分支」 on the card. Turns the owner or the Herder asked for keep what the owner allowed.
2. **`allowed` is checked against the owner's words.** `session_start` keeps a step only when the
   owner's words of this turn (their message, the answer they tapped, a schedule's saved words)
   or the words behind a decision they made (`[记忆 · 定了的事]`, ADR 0057) name it
   (`stepsSaidIn`: 推/push for push, PR/合并请求 for pull requests, 合并/合入/merge for merge, and so
   on; words right after 不/别/不用/不要/no/don't do not count). An intake turn's item is someone
   else's words and allows nothing. A dropped step is audited (`task.allowed-dropped`), the
   Herder is told "Not allowed: …", and the step asks the owner when the task gets there.
3. **An automatic intake watch starts on a trial run.** A watch made automatic (new, or `auto`
   turned on again) gets `trial`. On a trial run each new item is still offered with
   「开任务」「忽略」, the card says 「试运行第 n 条：自动开工还没放开…」, and the Herder gets a trial
   intake turn. `session_start` there runs every check (project, agent, model, allowed) and starts
   nothing; it audits `intake.trial` with what it would have started, and the Herder tells the
   owner in one line what it would have done and which words of the item decided it.
4. **The owner ends the trial.** When the owner says so (「放开」「以后直接开」), the Herder calls
   `intake_watch` with `trial` false and new items start by themselves (「按你的规则开工：…」). The
   owner may also say no trial when making the watch. `session_list` and the app's watch list show
   a watch on its trial run and how many items it has tried.

## Alternatives

- **Drop all allowed steps in a turn a pull request woke.** Then a reviewer's 「改一下变量名」 ends
  in a card for every push to the pull request's own branch, which the owner already wanted.
- **Let the Herder or a model judge whether a comment's request is covered.** A comment can say
  anything; code checking the branch cannot be talked out of it.
- **Reject `session_start` when `allowed` names an unsaid step.** The task would not start over a
  wrong guess; dropping the step only means the agent asks later.
- **A trial of a fixed number of items, then automatic.** Whether the calls look right is the
  owner's judgement, not a count.

## Consequences

- A pull request turn that pushes to its own branch runs as before; a stranger's comment can no
  longer make the task push elsewhere, merge or comment without the owner.
- Matching words is coarse: 「推一下」 allows push, 「推荐」 does not; an owner who allows a step in
  unusual words gets a card the first time, and can keep a decision so it passes from then on.
- An automatic watch now costs one Herder turn per item during its trial, the same turn it would
  run when released, and the owner still decides each item until they release it.
- Watches made before this change get their branch the next time AgentHerd looks at the pull
  request, which is saved before that look wakes the task. When GitHub reports no branch, there
  is nothing to compare, so every push in a pull request turn asks.
