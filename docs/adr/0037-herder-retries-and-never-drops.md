# ADR 0037: The Herder retries, switches model, and never drops a message

- Status: Accepted; the 「重试」 card changed 2026-11-26 (see Decision)
- Date: 2026-11-06

## Context

On 2026-11-05 21:31 an owner message hit "Connection error." in the Herder. It was not retried and
the owner was not told.

## Decision

- Transient errors (network, timeout, 429, 5xx) retry after 2 s, 10 s, 30 s.
- Then the Herder runs on the next model by tier and tells the owner in a red card.
- If every model fails, the message stays queued and the owner gets a red card with 「重试」.
- Auth, balance and bad-request errors are not retried; the card says what to change.

Changed 2026-11-26. A 「重试」 card stayed open after what it held had run. The network was down at
09:00, the 09:00 timer was held and its card went out once the network came back, a minute after
the timer had already run again. The pet still counted it as waiting for the owner. The owner:
「我理解过时的就直接关了呗，不能一直挂着呀」.

- A card goes out only when the owner's own words wait, and it quotes their start. A timer, a
  letter or a task result that fails just waits and is tried again quietly; a held message failing
  again sends no second card.
- When what it held has run, the card is changed in place to 「刚才没连上模型，后来已经接着处理了。」
  and loses its button. One that never went out is dropped from the outbox.
- On start, and on a 「重试」 tap when nothing waits, cards left from before become
  「这条提醒已经过时，关掉了。」: what they held is taken up again by the restart (ADR 0062).
- Sent 「重试」 cards are kept in `owner_cards` (ADR 0072) so they can be found and closed.

## Consequences

- See [spec 08 §5](../spec/08-herder-interaction.md#5-errors).
