# Glossary

Use these terms in code, UI text, docs and commit messages. Read this page before you name a
new type, table, IPC channel or product string.

| Term | Meaning | Do not use |
| --- | --- | --- |
| **AgentHerd** | The product | Herd (alone), the bot |
| **Herder** | The one resident secretary agent: talks with the owner, starts and steers sessions, relays, keeps the board. Never approves | supervisor, manager, router, brain |
| **Approval pipeline** | Guard list → rules → Reviewer → owner, for permission requests and agent questions | Herder (for this) |
| **Reviewer** | One call to the strongest model for one item, inside the approval pipeline | judge, L2 |
| **Relay** | The owner talks directly to one task's session; the Herder steps out | transfer, attach |
| **Board** | The pinned card that lists all tasks and their stages | dashboard |
| **Stage** | A task's place on the board: `queued`, `working`, `needs-owner`, `stuck`, `done`, `failed` | status (for tasks) |
| **Report** | What an agent did, sent at task end: its final reply, or its own summary when the reply is long | summary |
| **Watchdog** | Code that raises alarms for loops, silence and crashes | |
| **Agent** | A coding agent product (Claude Code, Codex, an ACP agent) | bot, worker |
| **Session** | One conversation of one agent, identified by the agent's own session id | thread, chat |
| **ACP** | Agent Client Protocol; the only runtime protocol between AgentHerd and agents | |
| **Agent profile** | Config that says how to start one ACP agent (command, env) | adapter, driver |
| **Exporter** | Code that writes AgentHerd rules into one agent's own permission config | adapter, sync |
| **Export status** | Per rule and agent: `exact`, `narrowed` or `not exported` | |
| **Item** | An event that needs the owner, or a notification for the owner, in the inbox | ticket, task, request |
| **Inbox** | The queue of open items | |
| **Decision** | The result for one item: allow, deny, answer, escalate | verdict |
| **Escalate** | Send the item to the owner | |
| **Rule** | A deterministic match + action (L0) | policy |
| **Guard list** | Built-in matches that always escalate | blocklist |
| **Precedent** | A past decision used to decide a new item | |
| **Mode** | How much AgentHerd applies by itself: `observe`, `assist`, `auto` | level |
| **Channel** | A chat app integration (Feishu first) | IM, notifier |
| **Owner** | The one person allowed to act on items | admin, user (in code) |
| **Card** | A channel message for one item | |
| **Task** | One piece of work the Herder started for the owner, with its session(s) | job, ticket |
| **Edge tuck** | The pet's resting position at the left or right edge of the desktop after the owner drops it there with an outward push | |
| **Edge grip** | The pose in which a tucked pet holds the desktop edge with both hands and shows its head on the visible side | |
