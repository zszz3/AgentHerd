<div align="center">

<img src="apps/desktop/resources/icon.svg" alt="AgentHerd" width="96">

# AgentHerd

English · [简体中文](README.zh-CN.md)

### Your coding agents, run from Feishu.<br>Tell the Herder what you want. It starts the agents on your machine, follows them, and tells you what they did.

[![macOS | Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-111)](docs/spec/02-architecture.md) [![Feishu / Lark](https://img.shields.io/badge/chat-Feishu%20%2F%20Lark-3370ff)](docs/spec/05-channels.md) [![ACP](https://img.shields.io/badge/protocol-ACP-6b5bd6)](https://agentclientprotocol.com) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)<br>
[![agent: Pi](https://img.shields.io/badge/agent-Pi-444)](https://github.com/earendil-works/pi) [![agent: Codex](https://img.shields.io/badge/agent-Codex-444)](https://github.com/openai/codex) [![agent: Claude Code](https://img.shields.io/badge/agent-Claude%20Code-444)](https://github.com/anthropics/claude-code)

[Features](#features) · [How it works](#how-it-works) · [Get started](#get-started) · [Docs](#docs)

</div>

<br>

> **Status:** in active development. There is no release yet; run it from source.

## Features

- **Feishu is the remote control.** Send a message to start work. Answer questions, approve and
  continue from cards on your phone. One QR scan connects it.
- **A Herder that talks like a person.** The Herder is a light-model agent that takes your
  messages, starts and follows tasks, and tells you each result in its own words, with the
  agent's own reply one tap away. It talks like a capable friend. The app's 「主管」 page shows
  every step it took and why, and what its next request carries: how full it is, which earlier
  talk is folded into summaries (as a tree that shows which fold holds which), and the tokens,
  cache hits and cost of every request, read from `herd.db` even while the Herder is off.
- **The right agent and model for each task.** Pi and Codex (for GPT models) come inside the app;
  Claude Code takes hard coding work, using your own `claude` or a download on the **Agent** page,
  with your own Anthropic-style model service. Antigravity runs when you ask for it, with your own
  `agy` and its Google sign-in and models. They run through the
  [Agent Client Protocol](https://agentclientprotocol.com), on your own model services. The
  Herder picks the model, the agent follows from it, and a broken first turn switches to the
  next model.
- **Tasks that keep going.** Each task works on a hidden copy of your project, is kept after it
  ends, and can be continued later. The app shows every task's conversation.
- **It only asks when it must.** Local work goes through. A push, a pull request, a merge, a
  publish, a deploy, a message to someone, or a mass delete asks you first, unless your request
  said to do it. Unanswered questions close after an hour instead of nagging.
  A watchdog notices a stuck task, and urgent news reaches you before small news.
- **Watches the work around your code.** It follows the pull requests its tasks open, offers new
  GitHub issues and reviews as "start a task / ignore", and watches mail when you ask it to. Turn on
  your 小红书 or 知乎 account and agents can search, read and (with your OK) post and reply there, and new
  comments reach you. Every watch is listed in one place, where you can pause it.
- **Your 飞书, news and notes.** Sign in 飞书 once (official lark-cli) and agents read your docs,
  sheets and calendar and write results as new docs; changing existing things asks you. GitHub
  Trending, Hacker News and arXiv need no sign-in: ask for a daily digest and nothing repeats.
  Notion comes through Composio, and your Obsidian vault is handed to every task.
- **Plugins.** Install Claude Code plugins and Gemini CLI extensions from the official library or a
  GitHub link. You see what they run first; tasks get their tools and skills, tools that change
  things ask you, and the Herder uses a plugin only if you switch it on.
- **Timers in the mailbox.** "Every weekday at 9, check for new issues" — the Herder adds a timer to
  the 信箱, and missed runs happen once when your machine wakes.
- **A mailbox for the outside world.** "Keep an eye on new issues in openai/codex" — a repository,
  an RSS feed, a Hacker News search or your own script is looked at by code on its own clock, and
  only new things reach the Herder. It tells you what matters now, keeps the rest for a morning
  digest, and the 信箱 page shows what it did with each letter and why.
- **Memory that stays useful.** The whole conversation is kept, and the Herder folds old parts
  itself. It keeps a profile card of you (what to call you, what you work on, your hours and
  likes), from things you say in passing, and lessons from what you correct; each turn brings only
  the memory that fits it, so the system prompt never changes and the prompt cache holds. You see
  and edit it all on the Memory page, and the first run asks what to call you. Past results are in
  task records.
- **A desktop pet.** 大肥鱼 or Claude 娘 floats on your desktop (she reads while the Herder thinks, jumps when it answers and walks when you drag her), says what AgentHerd just told you
  in Feishu, cheers when a task is done, and waits with 同意 / 拒绝 when something needs you. Click
  her to talk to the Herder: replies in Markdown; tables, numbers, steps, links and choices to tap
  drawn as components (in Feishu too); pictures a task saves for you (a QR code to scan, a
  screenshot) shown right in the reply; files the Herder points you to one click away; the same cards as Feishu;
  and a card for each task to stop or open it. Three pages — 对话, 任务, 卡片 — put running tasks
  and the cards waiting for you on pages of their own; a dot over her head for each running task
  shows at a glance which one waits on you. Drag a file or a screenshot onto her to hand it to the
  Herder. After a reply her empty input shows a grey guess of what you might say next; Tab takes
  it. Fold her into a dot when she is in the way.
  When she is out of sight she sends a system notification (only approvals and failures ring),
  a sheep in the menu bar shows what runs and waits, and quiet hours or a snooze keep her silent.
  ⇧⌘Space opens her to type from any app, ⇧⌘Y twice allows the oldest approval, and she can
  tuck at a screen edge or float on top only when she has something for you.
- **Local only.** No AgentHerd server. Keys and sign-ins stay in `~/.agentherd/secrets.json`
  (`%USERPROFILE%\.agentherd\secrets.json` on Windows). On Windows, access depends on the data
  directory's permissions. Turn on 防止休眠 to ask the system to
  prevent idle sleep while AgentHerd is open.

## How it works

<p align="center"><img src="docs/images/architecture.svg" alt="How AgentHerd works" width="900"></p>

AgentHerd is an Electron app with a headless core. The core starts each agent over ACP, checks
every tool call against its rules, and keeps tasks, memory and the Herder's conversation in one
local SQLite file (`~/.agentherd/herd.db`). The Herder is the only one that talks to you; your
own words reach the agent unchanged.

## Get started

Needs macOS or Windows, Node 22.18+, pnpm and a Feishu (or Lark) account.

```bash
pnpm install
pnpm --filter @agentherd/desktop start
```

The first run walks you through it: say what the Herder should call you and pick its figure
(both can be skipped), scan a QR code to connect Feishu, add a model service and its key (or
sign in with a ChatGPT, Claude, Copilot or other plan), pick the Herder's model. The packaged app includes Pi and Codex.
When running from source, download them once with `pnpm --filter @agentherd/desktop fetch-agents`
before using either one. On the **Agent** page, press 验证 to check that it starts.
For UI development, `pnpm --filter @agentherd/desktop dev` enables live reload. Then send the Herder a message
in Feishu.

- **Windows:** run the same commands in PowerShell. Closing the window keeps AgentHerd connected
  in the system tray; right-click the tray icon to quit. There is no Windows installer yet, so
  run from source.
- **macOS packaging:** `pnpm --filter @agentherd/desktop package:mac` builds `AgentHerd.app` and
  an unsigned `.dmg`.

<details>
<summary>Command line, without the app</summary>

```bash
node packages/cli/bin/agentherd.ts setup feishu                          # scan the QR code with Feishu
node packages/cli/bin/agentherd.ts model add deepseek --models deepseek-flash   # reads the key from stdin
node packages/cli/bin/agentherd.ts model use herder deepseek/deepseek-flash
node packages/cli/bin/agentherd.ts start
```

Run one task directly with `run --profile pi /tmp/demo "Create out.txt containing hello"`
(`C:\temp\demo` on Windows), and see recent decisions with `status`.

</details>

## Docs

[Baseline](docs/spec/00-baseline.md) · [Product](docs/spec/01-product.md) · [Architecture](docs/spec/02-architecture.md) · [Agents](docs/spec/03-agents.md) · [Herder](docs/spec/04-herder.md) · [Channels](docs/spec/05-channels.md) · [Security](docs/spec/06-security.md) · [ADRs](docs/adr/README.md) · [Plans](plans/README.md) · [References](docs/references.md) · [AGENTS.md](AGENTS.md)

## License

AgentHerd is under the [MIT License](LICENSE).

<sub>The Herder's loop is a fork of [Pi](https://github.com/earendil-works/pi)'s agent loop (MIT, [`packages/herder-loop`](packages/herder-loop/UPSTREAM.md)). Its context management uses [acp-kernel](https://github.com/ranxianglei/acp-kernel) from [billion-context](https://github.com/ranxianglei/billion-context) (MIT plus an attribution term), copied into [`packages/context-kernel`](packages/context-kernel/UPSTREAM.md). See [References](docs/references.md). The desktop pet's figures come from community Codex pets: 大肥鱼 and Claude 娘 drawn by ZipZipPipe from [llm-pet](https://github.com/savanna0425/llm-pet), and sixteen anime figures by their makers from [awesome-codex-pet](https://github.com/legeling/awesome-codex-pet). They are not under the MIT License and may not be used commercially; the characters belong to their original works. Every figure's maker, terms and link are in the [notice](apps/desktop/src/renderer/src/pet/figures/NOTICE.md).</sub>
