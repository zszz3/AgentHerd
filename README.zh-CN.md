<div align="center">

<img src="apps/desktop/resources/icon.svg" alt="AgentHerd" width="96">

# AgentHerd

[English](README.md) · 简体中文

### 在飞书里指挥你的 Coding Agent。<br>跟主管说你要什么，它在你的 Mac 上启动 Agent、盯着进度，做完用自己的话告诉你。

[![macOS](https://img.shields.io/badge/macOS-only-111?logo=apple)](docs/adr/0013-macos-only-for-v1.md) [![Feishu / Lark](https://img.shields.io/badge/chat-Feishu%20%2F%20Lark-3370ff)](docs/spec/05-channels.md) [![ACP](https://img.shields.io/badge/protocol-ACP-6b5bd6)](https://agentclientprotocol.com) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)<br>
[![agent: Pi](https://img.shields.io/badge/agent-Pi-444)](https://github.com/earendil-works/pi) [![agent: Codex](https://img.shields.io/badge/agent-Codex-444)](https://github.com/openai/codex) [![agent: DeepSeek Harness](https://img.shields.io/badge/agent-DeepSeek%20Harness-444)](https://github.com/deepseek-ai/deepseek-harness)

[主要功能](#主要功能) · [怎么工作](#怎么工作) · [开始使用](#开始使用) · [文档](#文档)

</div>

<br>

> **状态：** 正在开发，还没有发布版本，请从源码运行。

## 主要功能

- **飞书就是遥控器。** 发一条消息就能派活；在手机上用卡片回答问题、批准、继续任务。扫一次码就接好。
- **会说人话的主管。** 主管是一个用轻量模型的 Agent：接你的消息，启动并跟进任务，每个结果都用自己的话告诉你，
  Agent 的原话点一下就能看。说话风格可以选：能干的朋友、有主见的搭档或干练的秘书。
- **每个任务用对的 Agent 和模型。** Pi、Codex、DeepSeek Harness 通过
  [Agent Client Protocol](https://agentclientprotocol.com) 运行，用你自己的模型服务。主管选模型，Agent 跟着模型走；
  第一轮就出错时自动换下一个模型。
- **任务能一直接着做。** 每个任务在项目的隐藏副本里干活，结束后保留，之后还能继续。App 里能看到每个任务的完整对话。
- **只在必须的时候问你。** 本地的活直接放行；推送、开或合并 PR、发布、部署、替你给别人发消息、一次删除大量文件，才先问你（你在任务里说过要做的除外）。没人回的问题一小时后自动收起，不会一直催。看门狗会发现卡住的任务，
  急事先到，小事不打扰。
- **代码之外的事也帮你盯。** 跟进任务开出的 PR；GitHub 上的新 issue 和 review 以「开任务 / 忽略」的方式递给你；
  你要求时帮你看邮件。打开小红书账号后，Agent 能搜索、阅读，经你同意后发帖和回复；新评论和 @ 会告诉你。
  所有在盯的东西都列在一处，可以随时暂停。
- **一句话建定时任务。** 「工作日每天 9 点看看有没有新 issue」，主管就建好；Mac 睡着时错过的，醒来只补跑一次。
- **记忆有用不啰嗦。** 整段对话都保留，旧的部分由主管自己折叠。只有任务出了问题才记一条经验，以前的结果去任务记录里查。
- **只在本机运行。** 没有 AgentHerd 服务器，Key 存在 `~/.agentherd/secrets.json`，只有你的账户能读。合上盖子 Agent 也能接着跑。

## 怎么工作

<p align="center"><img src="docs/images/architecture.zh-CN.svg" alt="AgentHerd 怎么工作" width="900"></p>

AgentHerd 是一个 Electron 应用，里面是一个无界面的核心。核心通过 ACP 启动每个 Agent，按规则检查每一次工具调用，
任务、记忆和主管的对话都存在本地一个 SQLite 文件里（`~/.agentherd/herd.db`）。只有主管跟你说话；你的原话原样交给 Agent。

## 开始使用

需要 macOS、Node 22.18+、pnpm，以及一个飞书（或 Lark）账号。

```bash
pnpm install
pnpm --filter @agentherd/desktop start
```

第一次打开会一步步带你：扫码接入飞书，添加模型服务和 Key，给主管选模型和说话风格。在「Agent」页下载 Pi 或 Codex，
点「验证」确认能启动。然后在飞书里给主管发条消息就行。

<details>
<summary>不用 App，用命令行</summary>

```bash
node packages/cli/bin/agentherd.ts setup feishu                          # 用飞书扫码
node packages/cli/bin/agentherd.ts model add deepseek --models deepseek-flash   # Key 从标准输入读取
node packages/cli/bin/agentherd.ts model use herder deepseek/deepseek-flash
node packages/cli/bin/agentherd.ts start
```

直接跑一个任务：`run --profile pi /tmp/demo "Create out.txt containing hello"`；看最近的决定：`status`。

</details>

## 文档

[基线](docs/spec/00-baseline.md) · [产品](docs/spec/01-product.md) · [架构](docs/spec/02-architecture.md) · [Agent](docs/spec/03-agents.md) · [主管](docs/spec/04-herder.md) · [渠道](docs/spec/05-channels.md) · [安全](docs/spec/06-security.md) · [ADR](docs/adr/README.md) · [计划](plans/README.md) · [参考项目](docs/references.md) · [AGENTS.md](AGENTS.md)

## 许可证

AgentHerd 使用 [MIT 许可证](LICENSE)。

<sub>主管的循环 fork 自 [Pi](https://github.com/earendil-works/pi) 的 agent loop（MIT，[`packages/herder-loop`](packages/herder-loop/UPSTREAM.md)）。上下文管理用的是 [billion-context](https://github.com/ranxianglei/billion-context) 的 [acp-kernel](https://github.com/ranxianglei/acp-kernel)（MIT，另加一条署名条款），代码复制在 [`packages/context-kernel`](packages/context-kernel/UPSTREAM.md)。详见[参考项目](docs/references.md)。</sub>
