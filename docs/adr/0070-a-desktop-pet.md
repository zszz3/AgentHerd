# ADR 0070: A desktop pet that says what Feishu says and takes answers

- Status: Accepted; what the conversation shows extended by [ADR 0072](0072-cards-in-the-pet.md), how it looks by [ADR 0073](0073-the-pets-conversation-looks-like-a-chat.md); more moves by [ADR 0087](0087-the-pet-moves-more.md)
  (cards as in Feishu, a card for each task)
- Date: 2026-11-17
- Changes: the local API no longer only reads items (spec 02 §4): the pet can press a card's
  button for the owner

## Context

- The owner asked for a floating window on the desktop, "like a pet": not only in Feishu, the
  owner should be able to talk to the Herder from the desktop and approve from there.
- Asked what it should be (m19718 era), the owner chose: talk to the Herder, see what is
  going on, approve directly; always there, foldable into a small dot. The chat panel of a first
  mock was "too big": only a small bubble.
- Notifications go to **both** the pet and Feishu ("都发").
- Look: Q-version figures, a few simple motions "like the DSH whale pet"
  (`dsh-plugin-whale-pet`: six states, one picture each, CSS motion, fixed lines, no model).
  The owner picked the two community figures of DeepSeek (大肥鱼) and Claude (Claude 娘) and left
  a default figure of our own for later ("默认形象再说吧，先把这两个放进去").
- The only Q-version art with both figures in one style is
  [savanna0425/llm-pet](https://github.com/savanna0425/llm-pet) (Codex pet sprite sheets). Its
  notice: art by Bilibili artist ZipZipPipe, credit the artist, **no commercial use**. The DSH
  whale's art may not be taken out of that plugin.

## Decision

1. **A tee in front of the channel.** The host wraps the Feishu channel in `PetFeed`
   (`packages/host/src/pet.ts`). Every view still goes to Feishu unchanged; the pet sees the same
   views. It keeps the latest line (Herder text, task progress, report, error, question) and the
   cards that wait for the owner (approval cards, asks, offers with buttons), and drops a card
   when its Feishu card is closed or updated without buttons. The board and relay cards are not
   shown. Nothing is stored: after a restart the pet starts empty.
2. **Answers go in as the owner's own.** `petPress(target, action)` delivers
   `{kind: "action", target, action, from: ownerId}` and `petSay(text)` delivers
   `{kind: "message", text, from: ownerId}` to the herd, exactly what a press or a message in
   Feishu delivers. So the inbox, asks, offers and the Herder need no change, and the Feishu card
   closes too. What the owner types is also shown in the chat as 「（在桌宠里说）…」, so the Feishu
   conversation still reads in order. It is not a message of its own: a Feishu bot message
   always rings, and the owner does not want the desktop to ring for words they wrote
   (「飞书里可以发，但是不要弹提示和声音到我桌面来，因为这是用户发的」). The send API has no
   silent flag (its only `system` message is a divider of at most 10 characters). So the line
   waits, up to 2 minutes, and is quoted on top of the Herder's next answer (its own text, with or
   without herd-ui choices, or a question; not a task's message, an offer, a report or a card),
   which rings anyway. It is set apart as a Markdown quote (`> `, one per message) and a rule
   (`---`) before the Herder's words: a first version put it there as plain text, and the owner
   could not tell their words from the Herder's (「没有做隔离，无法区分用户和主管说的话」). That
   version also missed the Herder's reply with choices (it has a target), so the line rode on a
   later, unrelated answer. Several lines typed before the answer are quoted together; an update
   in place of that message keeps the quote. The line is posted alone when no answer comes in 2
   minutes, when the channel stops, and when the owner presses a button or writes in the chat
   first, so it never sits on top of an answer to something else.
   Holding the line also keeps `petSay` from waiting on Feishu. A press on a card that is no
   longer open is refused
   ("这件事已经处理过了"); with no channel connected, both are refused.
3. **Mood from state, not from a model.** The pet's mood follows the host: something waits for
   the owner → waiting; a report or error just came → celebrate or error for 6 s; a task is
   queued or working → working; nothing for 2 minutes or no host → sleeping; else resting. It
   has no words of its own: what it shows is what AgentHerd sent, whole. No model calls.
4. **The art's own frames.** Each figure is one atlas of 192×208 cells cut from llm-pet's chibi
   sheets (`apps/desktop/src/renderer/src/pet/figures/`, layout in `pet/sprite.ts`): the rows
   idle (resting), running (working), waiting, jumping (celebrate), failed (error, played once)
   and waving (when clicked), played with the Codex pet frame times; resting holds still for
   2.4 s between rounds so it stays calm. Sleeping is one frame with a slow CSS breath, zZ on top;
   sparkles when cheering. `prefers-reduced-motion` shows first frames only. The first version
   moved one still frame per mood with CSS (a 2 px bob, a 1° sway); the owner found it choppy
   ("动作一顿一顿的不流畅") although it drew at the screen's full rate, so it plays the drawn
   frames instead.
5. **The window.** A frameless, transparent, always-on-top window (`pet.html`,
   `apps/desktop/src/main/pet-window.ts`), on all spaces, not in the task bar, sized to the pet
   and growing up and left when the conversation opens. It takes the first click even while
   another app is in front (`acceptFirstMouse`), so one click opens her, puts the cursor in the
   input or presses 同意. Drag moves it (the corner is saved); the small – button folds it into a
   round dot with a red count of open cards and of lines that came while it was folded. On Windows,
   transparent space outside the figure and conversation panel ignores mouse events
   (`setIgnoreMouseEvents`), so other apps behind the pet stay clickable. The main
   window still decides when the app quits; the dock icon brings the main window back.
5a. **Always the conversation.** A click on the figure opens the conversation both ways, newest
   at the bottom, with the open card and the input under it; ×, Esc or another click closes it.
   When a new line comes (a reply, a report, a question, a card), the conversation opens by
   itself and stays open, without taking the keyboard from the app in front; folded, the dot
   counts it instead. The latest line is shown after the conversation when herd.db does not hold
   it (task progress). There is no small bubble: the first version had one with the latest line
   cut to 90 characters and a double click for the conversation, and the owner found it could
   not be read (「这样是看不全的，所以我宁愿一直都是对话框」), and wanted new lines to show in
   the conversation directly (「直接显示对话框吧」).
   The conversation is the Herder's as herd.db keeps it (`herder_turns`: the owner's
   messages and answers, the Herder's replies, questions and the reports it passed on), the last
   80 lines, so it reaches back past restarts and holds what was said in Feishu too. A first
   version kept only the lines since the host started, in memory; the owner rejected that
   (「肯定不是按照这次启动算起啊」). The window grows up and left from the figure's corner and
   moves in rather than leave the screen.
5b. **Its size.** The owner sizes the conversation: handles on its top-left corner and its left
   and top edges (away from the figure) change the panel's width and the height of the messages,
   from 280×240 up to what fits on the screen; the size is kept for the next time and a double
   click on a handle goes back to 360×420. It opens at the start of the newest message, so a long
   answer is read from its first line. The window has no frame and is transparent, so the
   system's own resizing (invisible edges, growing from the bottom-right with the figure in tow)
   was not used; 小/中/大 in the settings was less direct than dragging.
   "What fits" is the room left of and above the figure's corner, which main tells the pet, not
   the whole screen: measured against the whole screen, a pet standing low grew taller than the
   room above it, main moved the window down to keep it on screen, and the figure jumped a few
   pixels each time the conversation opened or closed (owner, 2026-11-19: 「pet一点就跳一下」).
   Changed 2026-11-25: plugging in a second screen moved the coordinates under the pet, and the
   saved corner was left 432 px past the right edge of its screen, so the conversation opened
   half off the screen (owner: 「接入扩展显示屏，莫名其妙变成这样了」). Main now pulls the corner
   onto the nearest screen whenever it measures, and places the pet again when a screen is
   plugged in, unplugged or rearranged. The pet also draws its own thin scrollbar; the system's
   showed a white strip in dark mode.
6. **Settings.** 设置 → 桌宠: 显示桌宠 (on by default) and 形象 (大肥鱼 default, Claude 娘; ADR 0092 adds sixteen anime figures and a grid picker), saved
   in `config.json` as `pet: {on, figure}`. The figure credit is shown under the choice.
7. **License of the art.** The two strips are not under AgentHerd's MIT license:
   `figures/NOTICE.md` credits ZipZipPipe and llm-pet and says no commercial use; the README says
   the same. A figure of our own, free to ship, comes later.

## Alternatives

- **A small bubble with the latest line** — the first version, after the owner found a chat
  panel too big in a mock; a line cut to 90 characters could not be read, so the pet shows the
  conversation, sized by the owner (5b).
- **Fixed lines of its own (开工啦！, 我先眯一会儿…)** — dropped with the bubble; the motion
  already says that much.
- **The pet calls a model for its own lines (Claude Code `/buddy`)** — costs a call per line and
  can say things AgentHerd did not; fixed lines and AgentHerd's own text are enough.
- **The typed line as a message of its own** — the first version; the bot's message rang on the
  owner's desktop for words the owner had just written.
- **Leave the typed line out of Feishu** — Feishu would hold answers to questions it never shows.
- **Send the line as the owner (user token)** — the owner's own messages do not ring, but it needs a
  second Feishu sign-in and a user scope.
- **A host API that decides items directly** — would duplicate the inbox's rules (owner check,
  batch cards, asks, offers); delivering the same inbound as Feishu reuses all of them.
- **One still frame per mood with CSS motion (the DSH whale's way)** — the first version; a
  bitmap that only bobs and sways looks stiff next to drawn frames. The whale is vector art made
  for that; these figures are drawn as frame animations.
- **The whole Codex sheets** — 2 MB each with rows the pet does not use (walking left and right,
  review); the cut atlases are about 0.5 MB each.
- **The DSH whale** — its art may not be extracted from that plugin.

## Consequences

- The local API can now answer cards (`petPress`) and send messages (`petSay`), only as the bound
  owner and only through the inbox's rules; anyone who can reach the socket (mode 600) could
  already change settings.
- What the owner types in the pet shows in Feishu with a 「（在桌宠里说）」 prefix, on top of the
  Herder's answer. A task's message or report that comes before the answer shows above it. During
  a relay the agent's text is a task's message, so the line comes alone after 2 minutes.
- After a restart the pet does not know older open cards until they change; Feishu still has
  them.
- The bundled art cannot be shipped commercially as it is.

Tests: `packages/host/test/pet.test.ts` (feed, inbound, stale buttons, E2E-PET-APPROVE),
`packages/host/test/host.test.ts` (settings, `petSay`), `apps/desktop/test/pet-state.test.ts`
(mood, new lines, sizing).
