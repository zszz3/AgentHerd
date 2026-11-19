# ADR 0080: Global shortcuts for the pet, and where it floats

- Status: Accepted
- Date: 2026-11-19
- Changes: [0070](0070-a-desktop-pet.md) (the pet always floated above every window, also over
  full-screen apps, and was reached only with the mouse), [0079](0079-the-pet-notifies-and-keeps-quiet.md)
  (menu items show the shortcuts)

## Context

- The owner asked for the first six items of the pet research (2026-11-19, 「前六个感觉都可以做」).
  Two of them are here: global shortcuts, and keeping the pet out of the way (not over a
  full-screen video, not on top when it has nothing to say, tucked at a screen edge).
- To answer an approval the owner had to find the pet with the mouse, open it and press 同意. To
  say something to the Herder they had to click the figure first. Other desktop agents (Raycast,
  Claude desktop, ChatGPT's launcher) open with one key combination from any app.
- The pet floated above everything, also above full-screen apps, and stood on the screen in full
  even when there was nothing to show.

## Decision

1. **Two global shortcuts, set in 设置 → 桌宠.**
   - 和主管说话, default ⇧⌘空格 (Ctrl+Shift+Space): opens the pet's conversation with the cursor in
     the input, from any app. With the pet turned off it opens the app.
   - 同意最早的那件事, default ⇧⌘Y (Ctrl+Shift+Y): the first press opens the pet on 卡片, marks the
     oldest approval still open and says above the input 「再按一次 ⇧⌘Y 同意：…」; a second press
     within 5 seconds allows exactly that one. A late second press, or one after another approval
     became the oldest, marks again instead: the key never allows something the owner was not
     shown. Esc lets go. Questions (主管问你) are never answered by the key, and a combined card is
     answered one line at a time, never 全部同意.
   - A shortcut is recorded by pressing it on the settings row (Delete clears, Esc cancels). Only
     combinations that do not type are taken: a modifier other than Shift, or F1–F24 alone. While
     the row records, the old shortcuts let go so the press reaches the page. A combination another
     app holds is shown as taken on the row.
   - The menu bar items 「和主管说话…」 and 「N 件等你处理…」 show the shortcuts.
2. **Floating on top: 一直 (default) or 有事时.** With 有事时 the pet floats above other windows only
   while it has something for the owner: an approval or question waits, an unread line, its panel
   is open, or the approve key marked something. Otherwise it is an ordinary window other windows
   cover.
3. **Full-screen apps (macOS): off by default.** The pet no longer shows over an app in full
   screen (a video, a talk); a switch in settings turns it back on. Notifications still come.
4. **Tucked at a screen edge.** Dropped with more than a third of the figure past the left or right
   edge of its screen, the pet tucks there: only a 44 px strip of the figure shows. It comes out
   while the cursor is on it or its panel is open, and goes back 0.6 s after the cursor leaves.
   On Windows the dragged pet stays inside the work area and tucks when released against an exposed
   left or right side. The pointer can cross to another display. Dragging it away untucks it. Where and whether it is tucked is kept with its position.

## Alternatives

- **The approve key allows at once.** One press from any app that runs a shell command is too easy
  to hit by mistake; the mark-then-confirm keeps it one hand, two presses, with the thing named.
- **A shortcut for every button (deny, skip).** More keys to learn for rare answers; those stay on
  the card, one tap away once the pet is open.
- **Hiding the pet completely when nothing happens.** The figure is also the status (working,
  sleeping); 有事时 and the edge tuck keep it there but out of the way.

## Consequences

- Two system-wide key combinations are taken while AgentHerd runs; the owner can change or clear
  them.
- The pet window stays visible on all spaces but not over full-screen apps unless asked.

## Tests

- `apps/desktop/test/pet-shortcuts.test.ts`: the oldest approval (questions and closed cards left
  out, a combined card's first open line), the second press within 5 seconds and the re-mark when
  late or when another one is older, recording key presses, shortcut labels.
- `apps/desktop/test/pet-edge.test.ts`: when a drop tucks, the strip that shows, where it peeks.
- `packages/host/test/host.test.ts`: shortcut and placement settings, defaults and errors.
