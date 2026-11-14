# ADR 0062: Restarts lose nothing, cut text says so, and a pull request wakes its task three times in a row

- Status: Accepted
- Date: 2026-11-14
- Builds on: [ADR 0037](0037-herder-retries-and-never-drops.md) (the Herder never drops a message), [ADR 0040](0040-ask-before-continuing-cut-off-tasks.md) (cut-off tasks), [ADR 0051](0051-keep-following-pull-requests-after-they-close.md) (pull requests wake their task), [ADR 0061](0061-small-news-on-the-board.md) (small news on the board)
- Changes: [04-herder](../spec/04-herder.md) (tools, "Context and restarts", "Pull requests"), [07-delivery](../spec/07-delivery.md)

## Context

郑天's article on DeepSeek's SuperAgent and Alibaba's own practice (「关于 DeepSeek 的 SuperAgent，以及我们的
实践」) lists what an always-on agent needs from classic engineering. Four of those were missing
in AgentHerd:

1. **The Herder forgot on a restart.** `Herder.stop()` emptied its queue and aborted the running
   turn. A message the owner sent just before a restart (or an update of AgentHerd) was gone, and
   nobody said so.
2. **A task continued after a restart was not told it had been cut off.** It got the owner's
   「接着做」 and could push, open a pull request or comment again, because it did not know some of
   that was already done.
3. **Cut text did not say it was cut.** The Herder got the first 1000 characters of a result that
   only went on the board, a task got the first 1500 characters of a pull request comment, and a
   saved transcript entry kept its first 20,000, each ending in a bare 「…」 or nothing. A model
   takes half a reply for the whole, and a reply's conclusion is usually at its end. The Herder
   had no way to read a task's reply in full.
4. **A pull request could wake its task twenty times by itself.** Checks that keep failing, or two
   reviewers talking past each other, mean twenty paid rounds that nobody looks at. The article caps
   agent-to-agent wake-ups at three in a row and starts over when a person writes.

## Decision

1. **The Herder keeps the owner's messages until their turn is done.** Each message and answer of
   the owner is written to `herd.db` (state `herder.pending`: time, text, the saved paths of its
   images, whether the owner's words are already in the conversation record) before its turn runs.
   It is removed when the turn ends, answered or given up on with the owner told; a message held
   for 「重试」 stays. When AgentHerd starts, the Herder takes up what is left, oldest first. Each
   turn starts with 「[This came at HH:MM, before AgentHerd restarted, and was not finished then …]」;
   when it already did what was asked it answers `[quiet]` and nothing is said. A message older
   than 24 hours is dropped (audit `herder.pending.dropped`).
2. **A task the stop cut off looks before it goes on.** The first prompt to a task AgentHerd stopped
   in the middle of its work (a restart or a crash) starts with 「（AgentHerd）这个任务上次做到一半，
   AgentHerd 停了（重启或者崩溃）。接着做之前，先看看项目文件、git status、分支和 PR 现在是什么样；已经做过的事
   （提交、推送、开 PR、评论）不要再做一遍。」 Only that first prompt; a task that had finished does not
   get it. Continuing still waits for the owner (ADR 0040).
3. **Cut text keeps its start and its end and says what is left out.** `headTail(text, max, whole?)`
   keeps 60 % of the room from the start and the rest from the end, with
   `[… N characters left out; <where the whole is> …]` between them. It cuts the reply the Herder
   gets with a result that only went on the board (1000 characters, "task_read gives the whole
   reply"), pull request comments in a task's prompt (1500, "read it whole with gh") and saved
   transcript entries (20,000). The earlier conversation a reopened agent gets keeps its newest
   8000 characters and says how many are left out. The Herder gets a tool, `task_read(task,
   replies?)`: a task's latest reply, or up to its last 5, whole, quoted as the agent's words, at
   most 40,000 characters together (each reply cut the same way). Short snippets on the owner's
   cards stay as they are.
4. **Three wake-ups in a row, then the owner.** A pull request wakes its task by itself at most three
   times in a row (`pr_watches.wakesInRow`). The fourth time the task is not woken and the owner is
   told once: 「PR #n 又有新动静（…）。任务已经连着自己处理了 3 次，这次先不叫它。要它接着处理，回复这条消息就行，
   它会一起看到这些新动静。」 More news while it waits only changes the task's row on the board
   (「PR #n 又有新动静，等你回话」) and is held (`held`, the latest 20 items). The next prompt from the owner
   or the Herder to that task, such as a reply to that message, carries everything held and starts
   the count over. The limit of 20 wake-ups per pull request stays.

## Alternatives

- **Replaying the Herder's interrupted turn as it was.** Its tool calls may have run already; a new
  turn that is told what happened decides better than a replay.
- **Continuing cut-off tasks by themselves.** Rejected in ADR 0040: the owner may not want them any
  more. They still wait for the owner; they only learn to look first.
- **A model summary instead of a cut.** It costs a call each time and can drop the one line that
  mattered; start, end and a note cost nothing, and `task_read` has the whole.
- **Asking the owner on every wake-up.** That is the noise ADR 0061 removed. Three in a row lets a
  task go through an ordinary review round by itself.

## Consequences

- A message sent just before a restart is answered after it. When the Herder had already acted but
  the stop came before it noted the turn as done, the turn runs again; the restart note and
  `[quiet]` keep the owner from hearing it twice.
- A pull request that keeps failing costs at most three rounds before the owner hears about it.
- The Herder reads a task's own words with `task_read` instead of guessing from a first line.
- Tests: E2E-CUT-OFF (`packages/core/test/e2e/restart.e2e.test.ts`), E2E-PR-WAKE-CAP
  (`packages/core/test/e2e/github.e2e.test.ts`), the Herder's restart tests
  (`packages/herder/test/herder.test.ts`), `task_read` (`packages/herder/test/tools.test.ts`) and
  `headTail` (`packages/core/test/cut-text.test.ts`).
