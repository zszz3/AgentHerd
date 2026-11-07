# ADR 0048: Watch mail only when the owner asks

- Status: Accepted
- Date: 2026-11-08
- Amends: [ADR 0047](0047-follow-the-pull-requests-tasks-open.md) (the "Gmail" alternative)

## Context

The owner wants to hear about some mail on Feishu, e.g. 「导师来邮件提醒我」. Gmail is reachable
through the owner's Composio connection (ADR 0041's apps). Composio triggers deliver to a public
webhook; on a desktop the only local ways are its Pusher websocket (`subscribe()`, documented as
for prototyping) or `composio dev triggers listen`, and the Gmail trigger itself is Composio
polling every few minutes.

The owner does not want this on for everyone who installs the app: most owners never ask, and
polling a mailbox nobody asked about is both waste and surprise.

## Decision

- A **mail watch** is a Gmail search the owner asked to hear about, with their words for it
  (`about`, e.g. 「导师的邮件」; `query`, e.g. `from:prof@uni.edu`). Table `mail_watches`
  (schema 10) keeps it and the ids already told.
- Only the Herder creates watches, with tool `mail_watch`, and only in an owner turn (never from
  an event, so a mail or an agent cannot add one). `mail_unwatch` stops one; `session_list` lists
  them. There is no setting: with no watch, nothing is polled.
- Core `MailWatches` (`packages/core/src/mail-watch.ts`) runs `GMAIL_FETCH_EMAILS` through
  Composio's `COMPOSIO_MULTI_EXECUTE_TOOL` with `(<query>) after:<watch created>` every 3 minutes,
  only while at least one watch exists. Creating a watch runs the search once, so a missing
  Gmail connection or a bad search fails at once and the Herder can say so.
- New matches are told once to the owner, up to 5 per message (sender, subject, first 100
  characters, Gmail link), through the outbox (ADR 0044). The Herder's conversation gets an
  event line with what was told, labeled as mail and not from the owner.
- These calls are AgentHerd's own reads, not an agent's app calls, so they do not go through the
  approval pipeline. Errors are audited (`mail.error`) once per distinct error.

## Considered

- **Composio websocket (`subscribe()`).** Real time is not gained (Gmail triggers poll), it adds
  a dependency and the vendor calls it prototype-only.
- **A public webhook.** Needs a public address the desktop does not have.
- **A setting that turns mail notices on.** The owner wanted none; asking in chat is the switch.
- **Telling about all new mail by default.** Noise, and reading mail nobody asked about.

## Consequences

- Notices come up to about 3 minutes late.
- Watches survive restarts and keep polling until the owner stops them.
- Each watch costs one Composio call every 3 minutes.
