# ADR 0059: 飞书 through lark-cli, news sources, Notion and Obsidian

- Status: Accepted
- Date: 2026-11-11
- Builds on: [ADR 0056](0056-leaving-the-mac-asks-and-questions-close.md) (leaving the Mac), [ADR 0058](0058-xiaohongshu-zhihu-and-watches.md) (应用连接), [ADR 0055](0055-schedules-the-herder-makes.md) (schedules)
- Changes: [09-agent-tools §3c](../spec/09-agent-tools.md), [04-herder](../spec/04-herder.md), [07-delivery](../spec/07-delivery.md)

## Context

After 小红书 and 知乎, the owner asked for more sources: 「我们飞书的确实要接入」, then GitHub
Trending, Hacker News, Notion and Obsidian (2026-11-11, 「可以的，就先加这些」). Agents should
write research as a 飞书文档, read the owner's docs, sheets and calendar, and the Herder should be
able to push a daily digest of what is new without repeating itself.

AgentHerd's Feishu app only has a bot identity: a doc it creates belongs to the bot, not to the
owner. 飞书's official lark-cli signs in as the owner (device flow, QR), covers docs, wiki, sheets,
base, calendar, tasks, minutes, mail and messages, is written for agents (every command has a risk
level, high-risk writes need `--yes`) and ships guides (`lark-cli skills read lark-doc`).

## Decision

1. **飞书 is lark-cli, not our own client.** The host finds lark-cli (PATH, ~/.local/bin,
   Homebrew), installs `@larksuite/cli` with npm when missing, sets it up with AgentHerd's own
   Feishu app when lark-cli has none (`config init --app-id … --app-secret-stdin`; an existing
   lark-cli setup is kept), and starts a sign-in with `auth login --no-wait --json` for docs,
   drive, wiki, sheets, base, markdown, slides, calendar, task, minutes, contact and im. The app
   shows the link as a QR; the host finishes with `--device-code` in the background. 应用连接 has
   连接, 测试连接, 重连 and 断开, like the platforms, but no risk notice (official tool, the
   owner's own account).
2. **Every new task is told what the Mac offers.** When lark-cli is signed in, session_start adds
   one paragraph: it is there, as whom, where its guides are, and what asks. The same goes for an
   Obsidian vault folder the owner set in 应用连接 → 账号 → Obsidian. Agents use lark-cli and the vault with
   their own shell and file tools; no gateway tools.
3. **What a lark-cli command may do** (rules/outbound.ts, a new step `edit` 「改飞书等线上的文档、
   表格或日程」): reads (`+fetch`, `+search`, `list`, `get`, `+agenda` …), `--help`, `--dry-run`,
   `auth`, `config`, `schema`, `skills` stay on the Mac; making a new doc, sheet, slides, base or
   mind note (`+create`) passes, because it lands in the owner's own space; anything else asks:
   im, mail, calendar, vc and approval writes as `send` (other people see them), the rest as
   `edit`; `lark-cli api` asks unless it is GET. Coarse on purpose, as ADR 0056 says: a false hit
   costs one tap.
4. **News sources: GitHub Trending, Hacker News, arXiv.** No sign-in, read only. The host reads
   github.com/trending (daily / weekly / monthly, per language), the Hacker News API (front page,
   best of the week, Algolia search) and the arXiv API (newest for words or a category). All are
   on unless switched off in 应用连接 → 资讯. The Herder reads them itself with `feed_read`, no
   task needed; agents get GITHUB_TRENDING, HACKER_NEWS and ARXIV_SEARCH through the gateway
   (read-only, never ask).
5. **Digests do not repeat.** `feed_read` with `told: true` records the items in
   ~/.agentherd/feeds/told.json (last 2,000); later reads mark them `[told before]` and the
   Herder leaves them out unless asked. Agents' reads never mark. A digest is an ordinary
   schedule (ADR 0055): 「每天早上 9 点把 AI 相关的 Trending 挑几个发我」.
6. **Notion is Composio.** Its row in 应用连接 → 账号 connects it through Composio (更多应用 holds the key and the other apps).

## Alternatives

- **Our own 飞书 client on AgentHerd's bot app.** Docs would belong to the bot and every API would
  be ours to keep up; lark-cli already does this and is maintained by 飞书.
- **Gateway tools wrapping lark-cli.** Hundreds of commands; agents read lark-cli's own help and
  guides better than a list we would keep in sync.
- **Ask for every lark-cli write.** The owner chose that a new doc in their own space does not
  ask; changing existing things and anything others see does.
- **A news watcher that pushes by itself.** The owner picks what and when through a schedule; a
  built-in push would be one more thing to turn off.

## Consequences

- An owner whose lark-cli is already set up with another app keeps it; its scopes decide what
  works. A fresh setup uses AgentHerd's app, which needs the user scopes enabled in the 飞书
  developer console, or the sign-in reports what is missing.
- Trending is read from the web page; when GitHub changes it, the read finds nothing and says so.
- A lark-cli command we classify wrong either asks once too often or, for a write we did not
  foresee, asks as `edit`; a read with a new verb asks until added.
- Not tried on a phone or with a real digest schedule yet.
