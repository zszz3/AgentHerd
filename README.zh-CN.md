<div align="center">

<img src="apps/desktop/resources/icon.svg" alt="AgentHerd" width="96">

# AgentHerd

[English](README.md) · 简体中文

### 在飞书里指挥你的 Coding Agent。<br>跟主管说你要什么，它在你的电脑上启动 Agent、盯着进度，做完用自己的话告诉你。

[![macOS | Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-111)](docs/spec/02-architecture.md) [![Feishu / Lark](https://img.shields.io/badge/chat-Feishu%20%2F%20Lark-3370ff)](docs/spec/05-channels.md) [![ACP](https://img.shields.io/badge/protocol-ACP-6b5bd6)](https://agentclientprotocol.com) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)<br>
[![agent: Pi](https://img.shields.io/badge/agent-Pi-444)](https://github.com/earendil-works/pi) [![agent: Codex](https://img.shields.io/badge/agent-Codex-444)](https://github.com/openai/codex) [![agent: Claude Code](https://img.shields.io/badge/agent-Claude%20Code-444)](https://github.com/anthropics/claude-code)

[主要功能](#主要功能) · [怎么工作](#怎么工作) · [开始使用](#开始使用) · [文档](#文档)

</div>

<br>

> **状态：** 正在开发，还没有发布版本，请从源码运行。

## 主要功能

- **飞书就是遥控器。** 发一条消息就能派活；在手机上用卡片回答问题、批准、继续任务。扫一次码就接好。
- **会说人话的主管。** 主管是一个用轻量模型的 Agent：接你的消息，启动并跟进任务，每个结果都用自己的话告诉你，
  Agent 的原话点一下就能看。它说话像个能干的朋友。
  它每一步做了什么、为什么做，在 App 的「主管」页都看得到；同一页的「上下文」里能看到它下一次请求带了多少内容、都是什么，哪些旧对话折成了摘要（一棵树，看得出谁包着谁），以及每次请求、每天用了多少 token、命中多少缓存、花了多少钱；主管没在跑也能看。
- **每个任务用对的 Agent 和模型。** Pi 和 Codex（GPT 模型用它）随 App 一起装好；复杂的编程任务交给
  Claude Code，用你电脑上的 `claude`，没有就在「Agent」页下载，模型用你自己的 Anthropic 接口服务。你点名时用 Antigravity，用的是你自己装的 `agy` 和它的 Google 账号、模型。它们通过
  [Agent Client Protocol](https://agentclientprotocol.com) 运行，用你自己的模型服务。主管选模型，Agent 跟着模型走；
  第一轮就出错时自动换下一个模型。
- **任务能一直接着做。** 每个任务在项目的隐藏副本里干活，结束后保留，之后还能继续。App 里能看到每个任务的完整对话。
- **只在必须的时候问你。** 本地的活直接放行；推送、开或合并 PR、发布、部署、替你给别人发消息、一次删除大量文件，才先问你（你在任务里说过要做的除外）。没人回的问题一小时后自动收起，不会一直催。看门狗会发现卡住的任务，
  急事先到，小事不打扰。
- **代码之外的事也帮你盯。** 跟进任务开出的 PR；GitHub 上的新 issue 和 review 以「开任务 / 忽略」的方式递给你；
  你要求时帮你看邮件。打开小红书或知乎账号后，Agent 能搜索、阅读，经你同意后发帖和回复；新评论和 @ 会告诉你。
  所有在盯的东西都列在一处，可以随时暂停。
- **你的飞书、资讯和笔记。** 飞书扫码登录一次（用官方 lark-cli），Agent 就能读你的文档、表格和日程，把结果写成新文档；
  改已有的东西会先问你。GitHub Trending、Hacker News、arXiv 不用登录，说一句就每天推给你，推过的不再重复。
  Notion 通过 Composio 连接，Obsidian 笔记库会交给每个任务。
- **插件。** 从 Claude Code 官方插件库或 GitHub 链接装 Claude Code 插件和 Gemini CLI 扩展。装之前先看它会运行什么；
  任务能用它的工具和技能，会改东西的工具先问你；主管要你打开开关才能用。
- **定时的事也放进信箱。** 「工作日每天 9 点看看有没有新 issue」，主管就在信箱里加一个定时；电脑睡着时错过的，醒来只补跑一次。
- **信箱。** 「帮我盯一下 openai/codex 的新 issue」：GitHub 仓库、RSS、Hacker News 搜索或你自己的脚本，由代码按时去看，只有新东西才交给主管。主管觉得要紧的马上告诉你，其余的留到早上汇总；「信箱」页能看到每封信主管怎么处理的、为什么。
- **记忆有用不啰嗦。** 整段对话都保留，旧的部分由主管自己折叠。主管会记一张你的画像（怎么称呼你、在做什么、作息和喜好），聊天里顺口说的也算；你纠正它的地方会记成经验。每一轮只带跟这一轮有关的记忆，系统提示词不变，缓存一直命中。在「记忆」页能看能改；第一次打开时就可以告诉它怎么叫你。以前的结果去任务记录里查。
- **桌宠。** 大肥鱼或 Claude 娘浮在桌面上（主管在想时她捧着书、头上冒「…」，回复到了跳一下，拖着她会走路）：飞书收到什么她就说什么，任务做完会开心，有事要你点头时带着「同意 / 拒绝」等你。点她就是和主管的对话：回复按 Markdown 显示，表格、数字、步骤、链接和可点的选项会画成组件（飞书里一样），任务存下的二维码、截图直接显示在回复里，主管觉得你该看的文件点一下就能打开，卡片和飞书里一样，每个任务还有一张任务卡，可以停止或打开；面板顶上分「对话 / 任务 / 卡片」三页，在跑的任务和等你处理的卡片单独一页看；她头顶每个在跑的任务一个小圆点，哪个在等你一眼就知道。把文件或截图拖到她身上，就能连同一句话交给主管。主管回完话，输入框里会灰着显示你可能想说的下一句，按 Tab 就填进去。不在眼前时她会弹系统通知（要你确认的事和出错的任务才响），菜单栏有个小羊图标看状态；晚上可以设免打扰时段，或临时暂停一会儿。在哪个应用里按 ⇧⌘空格 都能直接跟她说话，按两下 ⇧⌘Y 同意最早那件等你的事；可以把她拖到屏幕边上藏起来，也可以设成只有有事时才浮在最上面。
  点她就能跟主管说话，嫌碍事可以收成一个小圆点。
- **只在本机运行。** 没有 AgentHerd 服务器，Key 和订阅登录凭据存在 `~/.agentherd/secrets.json`（Windows 在 `%USERPROFILE%\.agentherd\secrets.json`）。Windows 上谁能读取凭据取决于数据目录的权限。打开「防止休眠」后，AgentHerd 会在运行期间请求系统阻止空闲休眠。

## 怎么工作

<p align="center"><img src="docs/images/architecture.zh-CN.svg" alt="AgentHerd 怎么工作" width="900"></p>

AgentHerd 是一个 Electron 应用，里面是一个无界面的核心。核心通过 ACP 启动每个 Agent，按规则检查每一次工具调用，
任务、记忆和主管的对话都存在本地一个 SQLite 文件里（`~/.agentherd/herd.db`）。只有主管跟你说话；你的原话原样交给 Agent。

## 开始使用

需要 macOS 或 Windows、Node 22.18+、pnpm，以及一个飞书（或 Lark）账号。

```bash
pnpm install
pnpm --filter @agentherd/desktop start
```

第一次打开会一步步带你：告诉主管怎么叫你、选主管形象（都可以跳过），扫码接入飞书，添加模型服务和 Key（也可以用 ChatGPT、Claude、Copilot 等订阅账号登录），给主管选模型。打包版自带 Pi 和 Codex。从源码运行时，要使用 Pi 或 Codex，先运行一次 `pnpm --filter @agentherd/desktop fetch-agents` 下载它们，再到「Agent」页点「验证」。开发界面时可用 `pnpm --filter @agentherd/desktop dev` 热重载。然后在飞书里给主管发条消息就行。

- **Windows：** 在 PowerShell 里运行上面两行命令即可。关闭窗口后 AgentHerd 收进系统托盘保持连接，彻底退出请右键托盘图标；目前暂无 Windows 安装包，请从源码运行。
- **macOS 打包：** `pnpm --filter @agentherd/desktop package:mac` 打出 `AgentHerd.app` 和 `.dmg`（暂未签名）。

<details>
<summary>不用 App，用命令行</summary>

```bash
node packages/cli/bin/agentherd.ts setup feishu                          # 用飞书扫码
node packages/cli/bin/agentherd.ts model add deepseek --models deepseek-flash   # 从标准输入读取 Key
node packages/cli/bin/agentherd.ts model use herder deepseek/deepseek-flash
node packages/cli/bin/agentherd.ts start
```

直接跑一个任务：`run --profile pi /tmp/demo "Create out.txt containing hello"`（Windows 把路径换成 `C:\temp\demo`）；看最近的决定：`status`。

</details>

## 文档

[基线](docs/spec/00-baseline.md) · [产品](docs/spec/01-product.md) · [架构](docs/spec/02-architecture.md) · [Agent](docs/spec/03-agents.md) · [主管](docs/spec/04-herder.md) · [渠道](docs/spec/05-channels.md) · [安全](docs/spec/06-security.md) · [ADR](docs/adr/README.md) · [计划](plans/README.md) · [参考项目](docs/references.md) · [AGENTS.md](AGENTS.md)

## 许可证

AgentHerd 使用 [MIT 许可证](LICENSE)。

<sub>主管的循环 fork 自 [Pi](https://github.com/earendil-works/pi) 的 agent loop（MIT，[`packages/herder-loop`](packages/herder-loop/UPSTREAM.md)）。上下文管理用的是 [billion-context](https://github.com/ranxianglei/billion-context) 的 [acp-kernel](https://github.com/ranxianglei/acp-kernel)（MIT，另加一条署名条款），代码复制在 [`packages/context-kernel`](packages/context-kernel/UPSTREAM.md)。详见[参考项目](docs/references.md)。桌宠形象来自社区的 Codex 宠物：大肥鱼和 Claude 娘由画师 ZipZipPipe 绘制，来自 [llm-pet](https://github.com/savanna0425/llm-pet)；另外 16 个动漫形象由各自的作者制作，来自 [awesome-codex-pet](https://github.com/legeling/awesome-codex-pet)。它们不在 MIT 许可证范围内，不可商用，角色版权归原作。每个形象的作者、授权和原图链接见[说明](apps/desktop/src/renderer/src/pet/figures/NOTICE.md)。</sub>
