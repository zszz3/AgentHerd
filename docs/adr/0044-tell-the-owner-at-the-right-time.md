# ADR 0044: Tell the owner at the right time: background work, urgent reports, acknowledgements, a kept outbox

- Status: Accepted
- Date: 2026-11-07
- Amends: [ADR 0041](0041-agent-tools-through-a-local-mcp-gateway.md) (the gateway also offers `herd_ack`)

## Context

AgentHerd copies the way super-agent (deepseek-ai/dsh-superagent-prototype) keeps a person
informed. Four gaps were left:

- A turn that ended while the agent's build or test run was still going in the background was
  reported as finished; the result never reached the owner.
- `herd_report` with `waiting`, `blocked` or `failed` only changed the board. The owner learned
  about it at the end of the turn, if at all.
- The owner heard nothing between sending a request and the report.
- A message the channel did not take (network, Feishu error) was only audited and lost.

## Decision

- **Background work.** When a turn ends normally and the agent's last word in it was
  `herd_report` with `progress` (no tool call after it), no report is sent. The board says
  「后台还在运行：…」, and after `backgroundCheckMinutes` (default 5) AgentHerd prompts the agent to
  check on it. Up to 6 checks (about 30 minutes), then the report goes out as usual. A prompt from
  the owner ends the wait; ending the task cancels it. The `herd_report` description tells agents
  to do this.
- **Urgent reports.** `herd_report` with `waiting`, `blocked` or `failed` is sent to the owner at
  once (「需要你：」「卡住了：」「失败了：」, linked to the task so a reply reaches it). The same
  report is not sent twice, and the end-of-turn report is skipped when it would repeat it; the
  board and the Herder still get it.
- **Acknowledgement.** New gateway tool `herd_ack(text ≤ 200)`: one line to the owner about what
  the agent is starting, once per turn, only while a turn runs.
- **Outbox.** Messages for the owner sent through `send()` (texts, reports, alarms, relay views)
  are stored in table `outbox` (schema 8) before they are sent and deleted once the channel took
  them. A failure is retried after 2 s, doubling up to 60 s; after 24 h it is dropped and audited
  (`send.dropped`). After a restart what is left goes out at once. The board, approval cards and
  Herder questions keep their own paths.

## Consequences

- An agent that reports `progress` and then forgets to report again is asked within 5 minutes
  instead of being reported done at once.
- Owners can get a message from a turn before its report; the report may be absent when it would
  only repeat an urgent one.
- A message can be sent twice if AgentHerd dies between the channel taking it and the row being
  deleted.
