# 05. Channels

Applied ADRs: [0005](../adr/0005-channel-abstraction-feishu-first.md), [0019](../adr/0019-relay-verbatim-board-and-reports.md),
[0108](../adr/0108-mijia-writes-require-exact-owner-confirmation.md).

A **channel** is the chat app through which AgentHerd reaches the owner. The core does not
know which chat app is in use. v1 ships one channel: **Feishu** (the same code serves Lark,
the international brand). Later channels: Slack, Telegram, Discord, DingTalk, WeCom, a
plain push service (Bark/ntfy).

## 1. Channel interface

```ts
interface Channel {
  id: string;                                   // "feishu"
  capabilities: ChannelCapability[];            // "buttons" | "free-text" | "update-message" | "pin" | "table" | "files"
  setup(ui: SetupUI): Promise<ChannelBinding>;  // onboarding, e.g. QR scan
  start(binding: ChannelBinding, sink: InboundSink): Promise<void>;
  stop(): Promise<void>;
  send(view: View): Promise<MessageRef>;
  exactApproval?: true;                        // complete literal preview and card-bound actions
  update(ref: MessageRef, view: View): Promise<void>; // in place, no new notification
  pin(ref: MessageRef): Promise<void>;
}

type View = ItemView | BoardView | ReportView | RelayView | TextView;

type Inbound =
  | { kind: "action"; target: string; action: string; text?: string; from: string; cardRef?: MessageRef }
  | {
      kind: "message";
      nativeText?: true;           // set by the adapter only for a native text event
      text: string;               // may be empty when the owner sent only images
      from: string;
      replyTo?: MessageRef;
      images?: { mimeType: string; data: Uint8Array }[];
      files?: { name: string; data: Uint8Array }[];   // documents, audio, video
    };
```

Files the owner sends are saved under `<home>/attachments/` as `<date>-<id>-<name>` (the name
made safe for every OS, logged as `owner.file`). The message text gets one line per file with
its name and path (`[主人发来一个文件「…」，已保存在 …]`), so the Herder, a relayed agent or
`/run` reads it like any text and can open the file.

Images the owner sends are saved under `<home>/attachments/` (`<date>-<uuid>.<ext>`, logged as
`owner.image`) and go where the text goes:

- To the Herder: when its model reads images (`input` includes `image`) it sees them with the
  message; it always gets a line with where each image is saved. Image data is not kept in the
  saved conversation, only the path. A task it starts or messages for that owner message gets
  the images too.
- To an agent (relay, `/run`, or through the Herder): as ACP `image` content blocks when the
  agent advertises `promptCapabilities.image`; otherwise the prompt gets a line with the saved
  path. The transcript always shows the path line. The Pi bridge advertises image support and
  passes the images to Pi's `prompt` command.

The core renders channel-neutral views: `ItemView` (title, body, risk, options, reason),
`BoardView` (task rows), `ReportView` (completion report), `RelayView` (active relay),
`TextView` (agent or Herder text with a task label). Each channel turns them into its own
message format. A channel without buttons must still work: the user replies with a short code
(`1` allow, `2` deny, or text). A channel without `pin` or `update-message` sends a new board
on `status` instead.

An `ItemView` with `exactApproval?: string` is an exception. The channel must opt in with
`exactApproval: true`, show the entire preview as literal text, and return the originating
`cardRef` with the owner's action. Exact approvals stay separate from normal item cards: no
folding, truncation, text reply, bulk answer, or fallback card. If the channel cannot show it
as specified, the operation is not approved. Feishu opts in; `channel-fake` does so for tests.
Other adapters do not opt in. The desktop pet forwards the capability only from its wrapped
channel and does not echo or keep these cards. This is the channel contract for the simulated
Mi Home task route; production Mi Home control is disabled.

Only messages from the owner are accepted. Every channel binding stores the owner's id;
inbound messages from anyone else are dropped and logged.

## 2. What the owner sees

The owner talks to one bot in a direct chat. What it sends there:

| Message | When | Notifies? |
| --- | --- | --- |
| Task board | One pinned card. Rows: task, stage, project, agent, last report, updated. Open tasks, and ended ones only for 24 hours after their last change ([ADR 0071](../adr/0071-look-things-up-and-keep-the-board-short.md)); at most 20 rows. Tasks that need the owner come first. Updated in place by code when a stage changes; a select menu under the table starts a relay. | Only when first sent |
| Item card | An approval, labeled with its task, with 批准 / 拒绝 / 先不管. At most one open item per session; newer items for the same session queue behind it. Items of different sessions that are open together share one card: numbered lines with their own buttons, 「全部批准」 / 「都先不管」, and the owner can reply 「都批」 or 「批 1、3」 ([ADR 0056](../adr/0056-leaving-the-mac-asks-and-questions-close.md)). Updated in place with the final state: "Allowed by you", "Denied by you", "Left by you", "No answer in 1 hour; the step was not done". | Yes |
| Agent text | During a relay: everything the agent says, verbatim, with a task prefix | Yes |
| Completion report | Every time a task ends (done, blocked, failed): title, what was done, verification, outputs, risks, automatic decisions; long replies and decisions are folded. Feishu shows "Relay to this task" only for non-done results. Replying to any report still reaches that task. | Yes |
| Relay status | While a relay is active: "Talking to <task>", "End relay" button | When it starts and ends |
| Reminder | Once, `remindMinutes` (default 30) after an item opened; it closes as not done at `timeoutMinutes` (default 60) | Yes |
| Daily digest | On by default, can be turned off. Done today, still running, automatic decisions with reasons, decisions marked wrong | Yes |

Each kind of message has its own look ([ADR 0036](../adr/0036-message-cards-by-kind.md), spec 08 §3):
Herder talk has no header; Herder questions are purple 「主管问你」; reports carry ✅/❌/⚠️/⏹ with
the task name and a subtitle (result · project · agent · time), coloured by result; a task's
messages are blue ⏳, alarms orange ⚠️, errors red ❌; approvals are orange 「⚠️ 等你确认 · 任务名」.

A Herder question shows short answers as buttons. An answer over 15 characters, or any path, is a
whole-width clickable box (`interactive_container`) with the full text wrapped: a Feishu button is
one line, and a cut path hid which folder was meant. Both send the same `{target, action}`.

Long messages are folded, never shortened: over `foldChars` (default 400) the card shows the
first lines and puts the rest in a collapsible panel; code blocks and logs are collapsed; over
the card size limit the text is stored as a file and sent as a link.

Feishu card markdown does not render LaTeX. Math spans (`$…$` that look like TeX, `$$…$$`,
`\(…\)`, `\[…\]`) are written as plain Unicode text in the card: `$O(n \log \log n)$` shows as
O(n log log n), `$x^2 \le \alpha$` as x² ≤ α; code is left alone and money like "$5" stays
(`packages/channel-feishu/src/math.ts`). Only the display changes; the stored text is the agent's.

Tool-call activity of agents is stored, not sent. Nothing the agent says to the owner is
filtered ([ADR 0019](../adr/0019-relay-verbatim-board-and-reports.md)).

Commands (see [04-herder.md §1](04-herder.md#inbound) for routing):

| Text | Effect |
| --- | --- |
| Any text | To the Herder, or to the relayed session during a relay |
| `status` | Send the board (and pin it again if needed) |
| `/herder <text>` | To the Herder during a relay |
| `/end` | End the relay |
| `/interrupt <text>` | Cancel the relayed session's turn, then send the text |
| Reply to an item card | Answer that item |

## 3. Feishu channel

### Onboarding: one QR scan

Uses `registerApp` from `@larksuiteoapi/node-sdk` (1.61.1 or later), which implements the
Feishu "create agent app with one scan" flow (OAuth device grant). Tested in a prototype on
2026-11-04: one scan creates the app with the scopes, event and callback below, returns App
ID, App Secret and the owner's `open_id`, and no separate publish step is needed.

- App name: `<user name>'s AgentHerd`, created with `createOnly: true`.
- Scopes (tenant): `im:message`, `im:message:send_as_bot`, `im:message.p2p_msg:readonly`,
  `im:resource` (uploading pictures the Herder shows, ADR 0075).
- Event: `im.message.receive_v1`. Callback: `card.action.trigger`.
- The desktop app shows the QR code and the state of the flow (waiting for scan, waiting for
  confirm, verifying, connected). The QR code is valid for one hour.
- After the scan the app verifies the credentials (tenant access token) and sends a welcome
  card.

### Connection

The Feishu long connection (WebSocket, `WSClient` with an `EventDispatcher`) receives both
messages and card callbacks. No public IP and no webhook URL are needed. The prototype
confirmed that `card.action.trigger` arrives over the long connection.

### Inbound messages

`text` messages are passed as they are. `image` messages and `post` (rich text) messages are
supported too: a post becomes plain text (title, paragraphs; links as `label (url)`, mentions as
`@name`, code blocks as text) and its embedded images are downloaded. Images are downloaded with
`im.v1.messageResource.get` (`type: image`); the `im:message` scope covers it. A download that
fails becomes a note in the text (`[图片没能下载：…]`) instead of dropping the message. `file`,
`audio` and `media` (video) messages are downloaded the same way (`type: file`) and passed as
files; a voice message without a name is saved as `<file_key>.opus`. A failed file download
also becomes a note. Stickers and other types are ignored.

### Cards

Card JSON 2.0 with `update_multi: true`, so the card can be updated after an action. An update of
the card that was just tapped is returned in the callback response: a `patch` sent before the
callback is answered is not shown (seen in the M1 manual run). Card
callback values carry `{ target, action }`. The callback handler checks the owner, applies
the action once (duplicate callbacks are ignored), and returns a toast plus the updated card.

The board uses the card `table` component. Tested in the prototype on 2026-11-04
(`feishu-proto/board.ts`): a 6-column table with `options` (colored stage tags) and `lark_md`
columns was sent, pinned with `im.v1.pin.create` using the scopes above, and updated twice in
place with `im.v1.message.patch`. Limits from the Feishu docs and the test:

- at most 5 tables per card; a table must be at the card root; cells cannot hold buttons, so
  actions on a row use a select menu or a link under the table;
- `page_size` 1–10 rows, with paging; first column can be frozen;
- a column width of `70px` was rejected (error `200912`); `80px` worked.

Whether an in-place update makes a notification sound on the phone, and how the pin shows in a
direct chat, are open (Q13).

A reply that holds a herd-ui block ([ADR 0074](../adr/0074-the-herder-draws-with-herd-ui-blocks.md))
is drawn as elements (`packages/channel-feishu/src/herd-ui-card.ts`): `table` → a `table` element
like the board's (at most 5 a card, the rest as Markdown tables), `stats` → a `column_set`
(`flex_mode: bisect`), `link` → a bordered `interactive_container` with an `open_url` behavior,
`choices` → buttons (or wide boxes for long answers) numbered across the reply with the reply's
`ui:` target, 「你选了：x」 once chosen; the rest as Markdown. If Feishu refuses such a card
(230001, 230025, 230099) it is sent once more drawn from `herdUiPlain`, answers as ordinary
buttons, and later updates of that message stay plain.

A picture a reply shows ([ADR 0075](../adr/0075-the-herder-shows-pictures.md)) — a Markdown image
`![alt](/path.png)` on this computer, or a herd-ui `image` item — is read from disk
(`readPicture`: full path, png/jpg/gif/webp by extension and first bytes, 1 byte to 10 MB),
uploaded with `im/v1/images` (`image_type: message`, once per picture, kept by hash) and drawn as
`![alt](image_key)` in the card's Markdown (an `image` item: an `img` element, `fit_horizontal`,
with its title and description under it). A picture that cannot be read or uploaded (no
`im:resource`, too big) is named by its path and not tried again for 10 minutes; the reason
goes to the host log. A Markdown image on the web becomes a link.

## 4. Adding a channel

A new channel is a package `channel-<id>` that implements the interface, plus a setup page
in the desktop app. It must pass the shared channel contract tests (send, update, owner
check, duplicate action, reply mapping).
