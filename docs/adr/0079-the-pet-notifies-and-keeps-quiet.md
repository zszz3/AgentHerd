# ADR 0079: The pet notifies, keeps quiet when asked, and has a menu bar icon

- Status: Accepted
- Date: 2026-11-19
- Changes: [0070](0070-a-desktop-pet.md) (the pet only showed things in its own window; the
  Windows tray only opened the app)

## Context

- The pet shows what waits for the owner and what tasks finished, but only in its window. When
  the owner works in another app, in another space, or folded the pet into a dot, an approval
  waits unseen until Feishu rings on the phone.
- The research the owner asked for (2026-11-19, `pet-mock/pet-research-2026-11-19.md`) put
  system notifications with graded sound first among what agent pets lack (Codex pets, Claude
  Island, Vibe Island and the Claude Code notification hooks all have them), then quiet hours,
  then a menu bar icon. The owner: 「前六个感觉都可以做」 (m24319).
- A notification that rings for every finished task is noise; one that never rings misses the
  approval that blocks a task.

## Decision

1. **System notifications** from main, for what is new in the pet's view (the host's `pet`
   event): a card that waits (an approval: 「⚠️ 等你确认 · 任务」, with the item; a question:
   「❓ 主管问你」) and a task's report card (「✅ 「任务」做完了」, 「❌ …没做成」, 「⚠️ …卡住了」,
   「⏹ …停了」). Each is told once (keyed by card and, for a combined approval card, by how many
   it holds); what is there when main connects is no news. Several at once become one
   notification (「AgentHerd · 3 件事，1 件等你」), what waits first. Nothing is notified while an
   AgentHerd window has the keyboard: the owner is looking at it.
2. **Graded sound**: an approval, a question, a failed or stalled task ring; a finished or
   stopped task only shows. 设置 → 桌宠 has 系统通知 and 提示音 switches (both on by default).
3. **Answers on the notification**: an approval's notification carries its first two buttons
   (同意, 拒绝); pressing one answers the card as the owner, as in the pet (`petPress`). macOS
   shows them only for a signed app with `NSUserNotificationAlertStyle` `alert`, which the mac
   package now sets; elsewhere a click is enough. A click opens the pet's panel on the page it
   is about (卡片 for what waits, 对话 for results) and gives it the keyboard; with the pet off,
   the app opens at the task.
4. **Quiet**: 免打扰时段 (`HH:MM-HH:MM`, may cross midnight; off by default, 22:00–08:00 when
   turned on) and 暂停提醒 (1 小时, 到明早 8 点, 恢复提醒) in settings and the menu bar. While
   quiet: no notification, no sound, and a closed panel does not open by itself for a new line;
   it only counts it on the figure's badge, and a small moon shows by the figure. Nothing is
   lost: the panel, the cards and Feishu keep everything. Feishu itself is not silenced — its
   own do-not-disturb is the phone's.
5. **Menu bar icon** on macOS (a template image of the app icon's figure, tinted by the system) and the tray on Windows,
   also when the pet is off: the count of what waits next to the icon; a menu with how AgentHerd
   is doing (「2 个任务在跑」, 「还没连上飞书」, 「AgentHerd 服务未连接」), the quiet line, 「N 件等你
   处理…」 and 「看在跑的任务…」 (the pet's pages), 和主管说话…, 显示桌宠, 打开 AgentHerd, the 免打扰
   submenu (with the two switches) and 退出 AgentHerd. Closing the main window on macOS still
   leaves the app running, as before.
6. **The settings live with the pet's** in config (`pet.notify`, `pet.sound`, `pet.quietHours`,
   `pet.quietUntil`), checked by the host like the rest; the decisions are one pure module
   (`apps/desktop/src/shared/pet-notify.ts`) used by main and the pet.
7. **Development**: `brand-dev-electron` renames the dev Electron bundle, which broke its
   signature, and macOS refuses notifications to such an app (`UNErrorDomain` 1); the script now
   signs the bundle again, ad hoc, when it no longer checks.

## Alternatives

- **Notify from the host** (node): it cannot reach the system's notification center, and the
  click has to open a window anyway; main has both.
- **Ring for every result**: the owner would turn sound off and then miss the approvals.
- **Silence Feishu in quiet hours**: Feishu is where the owner answers from the phone; its own
  do-not-disturb already does this.
- **A per-kind matrix of switches**: two switches and a grading cover what owners asked for;
  more can come when someone needs it.

## Consequences

- The first notification makes macOS ask the owner to allow AgentHerd's notifications; until
  then nothing shows (main logs `notification failed`).
- On a Mac with a notch and many menu bar icons, macOS hides icons behind the notch; the
  AgentHerd icon may be one of them (a system limit; tools like Ice show hidden icons).
- Notification buttons on macOS need the packaged, signed app; the dev build shows the
  notification and its click only.

## Tests

- `apps/desktop/test/pet-notify.test.ts`: quiet hours across midnight, snoozes and their words,
  what is new (once, the first view is a baseline, a combined card told again with its count),
  order, sound grading, merging, the menu bar's lines.
- `packages/host/test/host.test.ts`: the new settings' defaults, saving and refusals.
- By hand (2026-11-19, dev build): a finished task notified (after the dev bundle was signed
  again, macOS asked to allow it); 1 小时 in settings put the moon on the pet and 「免打扰到
  12:13」 in the menu; 看在跑的任务… opened the pet on 任务.
