# ADR 0063: The owner's message reaches a working Pi task at its next step

- Status: Accepted
- Date: 2026-11-14
- Builds on: [ADR 0022](0022-pi-through-a-bundled-acp-bridge.md) (Pi through a bundled ACP bridge), [ADR 0061](0061-small-news-on-the-board.md) (who a prompt comes from, unread messages go back)
- Changes: [03-agents](../spec/03-agents.md) (ACP mapping, Pi, mock agent), [04-herder](../spec/04-herder.md) (messages while the agent works), [07-delivery](../spec/07-delivery.md)

## Context

A message for a task whose turn was running waited until the whole turn ended
(「已排队：Agent 这一轮结束后会收到这条消息。」). A turn can run for twenty minutes, so a correction
such as 「先别改 API，只修测试」 arrived after the work it was meant to change. 郑天's article on
DeepSeek's SuperAgent (「关于 DeepSeek 的 SuperAgent，以及我们的实践」) names this: an agent that
works for a person has to hear them while it works, not only between turns.

Pi 1.5 can do this in RPC mode. Its `steer` command queues a message that the agent loop hands to
the model after the current step's tool calls, before the next model call; `queue_update` events
show the queue, `clear_queue` empties it, and `set_steering_mode all` delivers every queued message
at once. ACP has no method for it, and Codex and DSH offer nothing AgentHerd can use.

## Decision

1. **An ACP extension.** `_agentherd/steer` with `{ sessionId, prompt }` (ACP content blocks)
   answers `{ delivered }`. An agent offers it with `agentCapabilities._meta.agentherd.steer: true`;
   agents without it are never asked. The answer comes when the agent's model saw the message in
   the running turn (`true`), or when the turn ended without it (`false`).
2. **pi-acp maps it to Pi's `steer`.** It sets `set_steering_mode all`, sends one `steer` at a
   time, and counts a message read when Pi's steering queue shrinks in `queue_update` (only the
   bridge steers Pi, so the queue is its own messages in order). At `agent_settled` the messages
   left are answered `false` and Pi's queue is cleared. `session/cancel` clears the queue before
   `abort`, because Pi's abort goes on to queued messages. A Pi that exits answers `false`.
3. **Who goes into a running turn.** The owner's and the Herder's messages do, when the turn is
   not AgentHerd's own check on background work and the agent offers the extension. A pull
   request's prompt still waits for the turn to end: it is AgentHerd's own news (ADR 0061).
4. **A message the turn read joins it.** The transcript shows it where it was read; the turn now
   answers whoever asked last (the owner above the Herder above a pull request), so its
   `herd_ack` and its result reach the owner's phone; the agent's next `herd_ack` replies to that
   message; it settles when the turn ends, with one report for everything the turn answered.
5. **A message the turn did not read is not lost.** It goes first in the queue, before what came
   after it, and runs as the next prompt. When the task ended meanwhile, it goes back like any
   unread message (ADR 0061). A model switch ([ADR 0030](0030-switch-model-when-a-turn-breaks-before-acting.md))
   gives the new agent what the broken turn read as its next prompts.
6. **The owner hears which.** A direct reply to a busy task answers 「已插话：Agent 做完手上这一步就会看到。」
   when the agent takes it, and 「已排队…」 otherwise. The Herder's `session_prompt` is unchanged.
7. **The mock agent takes it too.** A script with `steer: true` offers the extension; a
   `read_steers: <ms>` step waits for messages and reads them, so tests run the same client code.

## Alternatives

- **Cancel the turn and send the message as a new prompt.** Loses the work in progress. It stays
  the explicit `/interrupt`.
- **Pi's `follow_up`.** Delivered only after the agent stops, which is the queue AgentHerd already
  had.
- **Pi's `prompt` with `streamingBehavior: "steer"`.** The same queue; a separate method keeps ACP's
  `session/prompt` meaning "start a turn".
- **The same for Codex and DSH.** Neither offers a way in; they keep the queue.

## Consequences

- With Pi, a correction reaches the agent after the step it is on (usually one tool call), not
  after the whole turn. Tried with Pi 1.5.0 and `deepseek-flash`: a message sent during an
  eight-second command was answered in the same turn; a cancelled turn answered `false` and Pi
  did not act on the message.
- pi-acp now starts a new paragraph for text from a later model call in the same turn, which a
  message read mid-turn makes common (「hello」 then 「BANANA」 no longer reads 「helloBANANA」).
- One turn may answer several messages, with one report. The transcript shows more than one
  prompt in that round.
- Only Pi. Codex and DSH work as before.
- Pi's docs say a queued message is not guaranteed to stay queued. The bridge counts a message
  read when it leaves the queue, so a message Pi dropped for another reason would count as read.
  Nothing but the bridge touches Pi's queue today.
