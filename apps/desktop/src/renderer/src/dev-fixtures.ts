// Sample data for the in-memory dev bridge (dev-bridge.ts): a placeholder QR code,
// tasks, model services, the provider catalog, the Herder's schedules,
// and the platforms and watches of 应用连接.

import type {
  MemoryView,
  ModelsView,
  ProviderView,
  SchedulesView,
  SocialView,
  TasksView,
  TranscriptView,
  WatchView,
} from "@agentherd/host/api";

export const PLACEHOLDER_QR = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" shape-rendering="crispEdges">
<rect width="21" height="21" fill="#fff"/>
<path fill="#000" d="M0 0h7v7H0zM1 1v5h5V1zM2 2h3v3H2zM14 0h7v7h-7zM15 1v5h5V1zM16 2h3v3h-3zM0 14h7v7H0zM1 15v5h5v-5zM2 16h3v3H2zM9 1h2v2H9zM8 4h3v2H8zM9 8h3v3H9zM13 9h2v2h-2zM16 9h3v2h-3zM8 13h2v3H8zM11 14h3v2h-3zM15 13h2v2h-2zM17 16h3v3h-3zM12 18h3v2h-3zM9 18h2v3H9z"/>
</svg>`,
)}`;

function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

const OPENROUTER_MODELS: readonly (readonly [string, string])[] = [
  ["anthropic/claude-sonnet-4.5", "Anthropic: Claude Sonnet 4.5"],
  ["anthropic/claude-opus-4.1", "Anthropic: Claude Opus 4.1"],
  ["anthropic/claude-haiku-4.5", "Anthropic: Claude Haiku 4.5"],
  ["openai/gpt-5", "OpenAI: GPT-5"],
  ["openai/gpt-5-mini", "OpenAI: GPT-5 mini"],
  ["openai/gpt-5-codex", "OpenAI: GPT-5 Codex"],
  ["openai/gpt-oss-120b", "OpenAI: gpt-oss-120b"],
  ["google/gemini-2.5-pro", "Google: Gemini 2.5 Pro"],
  ["google/gemini-2.5-flash", "Google: Gemini 2.5 Flash"],
  ["google/gemini-2.5-flash-lite", "Google: Gemini 2.5 Flash Lite"],
  ["deepseek/deepseek-chat-v3.1", "DeepSeek: DeepSeek V3.1"],
  ["deepseek/deepseek-r1-0528", "DeepSeek: R1 0528"],
  ["qwen/qwen3-coder", "Qwen: Qwen3 Coder"],
  ["qwen/qwen3-max", "Qwen: Qwen3 Max"],
  ["qwen/qwen3-235b-a22b-2507", "Qwen: Qwen3 235B A22B 2507"],
  ["moonshotai/kimi-k2-0905", "MoonshotAI: Kimi K2 0905"],
  ["z-ai/glm-4.6", "Z.AI: GLM 4.6"],
  ["z-ai/glm-4.5-air", "Z.AI: GLM 4.5 Air"],
  ["x-ai/grok-4", "xAI: Grok 4"],
  ["x-ai/grok-code-fast-1", "xAI: Grok Code Fast 1"],
  ["mistralai/devstral-medium", "Mistral: Devstral Medium"],
  ["mistralai/mistral-medium-3.1", "Mistral: Mistral Medium 3.1"],
  ["meta-llama/llama-4-maverick", "Meta: Llama 4 Maverick"],
  ["minimax/minimax-m2", "MiniMax: MiniMax M2"],
];

const task = (
  id: string,
  title: string,
  project: string,
  stage: TasksView["tasks"][number]["stage"],
  lastReport: string,
  updated: number,
): TasksView["tasks"][number] => ({
  id,
  title,
  project,
  agent: "dsh",
  stage,
  lastReport,
  startedAt: minutesAgo(updated + 30),
  updatedAt: minutesAgo(updated),
  automaticDecisions: [],
});

/** The sample tasks and approval items; none for the empty states. */
/** A sample conversation for the task view (`?open=task-<id>`). */
export function sampleTranscript(taskId: string): TranscriptView {
  const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  if (taskId !== "s2") return { entries: [], live: "" };
  return {
    entries: [
      {
        id: 1,
        at: at(9),
        role: "prompt",
        text: [
          "[Owner's message]",
          "给订单服务补单元测试，重点覆盖退款和部分发货。",
          "",
          "[Context added by the Herder, for reference]",
          "测试放在 test/orders 下，用现有的 vitest 配置；不要改业务代码。",
          "",
          "过去类似任务的记录（仅供参考）：",
          "- [经验] 改测试前先跑一遍现有测试，确认基线是绿的。",
        ].join("\n"),
      },
      { id: 2, at: at(9), role: "agent", text: "我先看一下订单服务的结构和现有测试。" },
      {
        id: 3,
        at: at(9),
        role: "tool",
        text: "cd /Users/me/.agentherd/worktrees/order-service-1d9a25/s2 && ls src/orders test",
        status: "completed",
      },
      {
        id: 31,
        at: at(9),
        role: "tool",
        text: "cd /Users/me/.agentherd/worktrees/order-service-1d9a25/s2 && git log --oneline -5 -- src/orders",
        status: "completed",
      },
      {
        id: 32,
        at: at(9),
        role: "tool",
        text: [
          "cd /Users/me/.agentherd/worktrees/order-service-1d9a25/s2 && python3 - <<'EOF'",
          "import json",
          "cases = json.load(open('test/fixtures/orders.json'))",
          "print(len([c for c in cases if c['refund']]))",
          "EOF",
        ].join("\n"),
        status: "completed",
      },
      { id: 4, at: at(8), role: "tool", text: "Read src/orders/refund.ts", status: "completed" },
      {
        id: 5,
        at: at(6),
        role: "agent",
        text: [
          "## 退款逻辑",
          "",
          "`refund()` 有三条分支，我按这三条各写测试，再补**部分发货**：",
          "",
          "1. 全额退款",
          "2. 部分退款",
          "   - 金额不能超过已付",
          "3. 超过 *30 天*：拒绝",
          "",
          "| 分支 | 测试 |",
          "| --- | --: |",
          "| 全额 | 3 |",
          "| 部分 | 5 |",
          "",
          "```ts",
          "expect(refund(order, 100)).toEqual({ ok: true });",
          "```",
          "",
          "> 部分发货的规则见 [文档](https://example.com/orders)。",
        ].join("\n"),
      },
      {
        id: 6,
        at: at(5),
        role: "tool",
        text: "Write test/orders/refund.test.ts",
        status: "completed",
      },
      { id: 7, at: at(3), role: "tool", text: "npm test", status: "completed" },
      {
        id: 8,
        at: at(3),
        role: "agent",
        text: "12 个测试都过了：退款 8 个，部分发货 4 个。测试在 test/orders/refund.test.ts。",
      },
      {
        id: 9,
        at: at(2),
        role: "prompt",
        text: "[Message from the Herder, not from the owner]\n负责人想再加几个超过 30 天退款的边界测试。",
      },
      { id: 10, at: at(1), role: "tool", text: "npm test -- refund", status: "in_progress" },
    ],
    live: "已写完 12 个测试，正在跑 npm test",
  };
}

export function sampleTasks(empty: boolean): TasksView {
  return empty
    ? { tasks: [], items: [] }
    : {
        tasks: [
          task(
            "s1",
            "修复登录页在 Safari 上的白屏",
            "web-portal",
            "needs-owner",
            "修好了，想发一个 next 版本验证，等你批准",
            3,
          ),
          task(
            "s2",
            "给订单服务补单元测试",
            "order-service",
            "working",
            "已写完 12 个测试，正在跑 npm test",
            1,
          ),
          task("s3", "把日志库换成 pino", "order-service", "queued", "", 6),
          task("s4", "升级 Node 到 24", "infra", "stuck", "CI 里的镜像拉不下来，已经重试 3 次", 18),
          task("s5", "整理 README 的安装步骤", "web-portal", "done", "已提交 PR #128", 55),
          task("s6", "迁移旧的用户表", "order-service", "failed", "迁移脚本报错：外键冲突", 120),
          task("s7", "给首页加骨架屏", "web-portal", "done", "已提交 PR #127", 240),
        ],
        items: [
          {
            id: "i1",
            sessionId: "s1",
            title: "执行命令",
            body: "npm publish --access public --tag next ./packages/web-portal",
            risk: "high",
            createdAt: minutesAgo(3),
            cwd: "/Users/me/code/web-portal",
            profileId: "dsh",
            taskTitle: "修复登录页在 Safari 上的白屏",
          },
          {
            id: "i2",
            sessionId: "s0",
            title: "写入文件",
            body: "~/.npmrc: registry=https://npm.example.com/",
            risk: "medium",
            createdAt: minutesAgo(9),
            cwd: "/Users/me/code/scratch",
            profileId: "dsh",
          },
        ],
      };
}

/** The sample model services. */
export function sampleServices(): ModelsView["services"] {
  return [
    {
      id: "deepseek",
      name: "DeepSeek",
      kind: "builtin",
      provider: "deepseek",
      models: ["deepseek-chat", "deepseek-reasoner"],
      hasKey: true,
    },
    {
      id: "gateway",
      name: "公司网关",
      kind: "openai-compatible",
      baseUrl: "https://llm.example.com/v1",
      models: ["qwen3-coder-plus", "glm-4.6", "deepseek-chat"],
      hasKey: false,
    },
  ];
}

export const providers: ProviderView[] = [
  {
    provider: "deepseek",
    models: [
      { id: "deepseek-chat", name: "DeepSeek Chat" },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
    ],
  },
  {
    provider: "anthropic",
    models: [
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      { id: "claude-opus-4-1", name: "Claude Opus 4.1" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    ],
  },
  {
    provider: "openai",
    models: [
      { id: "gpt-5", name: "GPT-5" },
      { id: "gpt-5-mini", name: "GPT-5 mini" },
    ],
  },
  {
    provider: "google",
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    ],
  },
  {
    provider: "openrouter",
    // Many models, so the model panes can be seen scrolling.
    models: OPENROUTER_MODELS.map(([id, name]) => ({ id, name })),
  },
];

type MemoryEntry = MemoryView["entries"][number];

function mem(
  id: string,
  kind: MemoryEntry["kind"],
  abstract: string,
  extra: Partial<MemoryEntry> = {},
): MemoryEntry {
  return {
    id,
    kind,
    scope: "global",
    abstract,
    body: "",
    source: "said",
    status: "active",
    accessCount: 0,
    rev: 1,
    createdAt: "2026-11-05T10:00:00.000Z",
    updatedAt: "2026-11-05T10:00:00.000Z",
    ...extra,
  };
}

/** What the 记忆 page shows in the browser preview. */
export function sampleMemory(): MemoryView {
  return {
    ready: true,
    used: { owner: 31, decision: 22, note: 18 },
    caps: { owner: 1375, decision: 2200, note: 2200 },
    entries: [
      mem("m0", "decision", "AgentHerd 仓库的改动可以直接推 main，不用开 PR", {
        evidence: "AgentHerd 以后直接推 main 就行，不用开 PR",
      }),
      mem("m1", "owner", "回复用中文，先说结论，别太长", {
        evidence: "以后都用中文回复，先说结论",
        accessCount: 12,
      }),
      mem("m2", "owner", "提交 PR 前先跑测试", { evidence: "每次提 PR 前都要先跑测试" }),
      mem("m3", "note", "这台 Mac 上 Codex 启动会被杀掉，用 Pi", {
        source: "noticed",
        until: "2026-12-31",
      }),
      mem("m4", "person", "小王负责 pi-desktop 的打包和发布", {
        evidence: "小王管 pi-desktop 打包",
      }),
      mem("m5", "project", "pi-desktop 是 Pi 的桌面版，Electron + React", {
        scope: "project:/Users/me/learn-agent/pi-desktop",
      }),
      mem("m6", "experience", "梳理开源仓库 issue 时先按标签和最近更新筛，再看能不能复现", {
        source: "task",
        body: "适用于「看看有哪些 issue 可以做」一类任务。\n来自案例 c1a2b3c4",
        accessCount: 2,
      }),
      mem("m7", "case", "pi-desktop：梳理可做的 issue，挑出 5 个，已写进 issues.md", {
        source: "task",
        scope: "project:/Users/me/learn-agent/pi-desktop",
        body: "结果：done（issues.md 已提交）\n做法：gh issue list --label good-first-issue\n教训：先确认项目目录，别写到临时目录",
      }),
    ],
    deleted: [mem("m8", "owner", "用英文写提交信息", { status: "deleted" })],
  };
}

/** An ISO time some hours from now, so a preview's 下次 times look right. */
export function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

/** What the 定时任务 page shows in the browser preview; `empty` shows the empty state. */
export function sampleSchedules(empty: boolean): SchedulesView {
  if (empty) return { ready: true, schedules: [] };
  const createdAt = "2026-11-05T10:00:00.000Z";
  return {
    ready: true,
    schedules: [
      {
        id: "sch1",
        about: "早上看 PI-Desktop 新 issue",
        prompt: "看看 PI-Desktop 有没有新 issue，有好上手的就告诉我",
        when: { kind: "daily", at: "09:00", days: [1, 2, 3, 4, 5] },
        paused: false,
        createdAt,
        nextAt: hoursFromNow(18),
      },
      {
        id: "sch2",
        about: "盯着 #2000 的 CI",
        prompt: "看一下 #2000 的 CI 过了没有，没过就告诉我哪里挂了",
        when: { kind: "every", hours: 3 },
        paused: false,
        createdAt,
        nextAt: hoursFromNow(2),
        lastAt: createdAt,
      },
      {
        id: "sch3",
        about: "周报",
        prompt: "汇总这周做完的任务，写一份周报",
        when: { kind: "daily", at: "17:30", days: [5] },
        paused: true,
        createdAt,
      },
    ],
  };
}

/** The platforms in the browser preview: 小红书 signed in with mentions on, 知乎 not connected. */
export function sampleSocials(): SocialView[] {
  return [
    {
      platform: "xiaohongshu",
      name: "小红书",
      available: true,
      accepted: true,
      enabled: true,
      state: "ready",
      account: "小羊不吃草",
      watch: { mentions: true, likes: false, follows: false },
      checkedAt: hoursFromNow(-0.2),
    },
    {
      platform: "zhihu",
      name: "知乎",
      available: true,
      accepted: false,
      enabled: false,
      state: "off",
      watch: { mentions: true, likes: false, follows: false },
    },
  ];
}

/** What the 监听 section shows in the browser preview; `empty` shows the empty state. */
export function sampleWatches(empty: boolean): WatchView[] {
  if (empty) return [];
  return [
    {
      id: "pr:zszz3/AgentHerd#212",
      kind: "pr",
      title: "AgentHerd #212 小红书接入",
      detail: "CI、评审和合并，每 5 分钟看一次",
      paused: false,
      removable: true,
      createdAt: hoursFromNow(-30),
      activeAt: hoursFromNow(-0.3),
    },
    {
      id: "mail:m1",
      kind: "mail",
      title: "Apple 开发者账号续费的回信",
      detail: "Gmail，有回信就告诉你",
      paused: false,
      removable: true,
      createdAt: hoursFromNow(-50),
    },
    {
      id: "intake:i1",
      kind: "intake",
      title: "PI-Desktop 新 issue",
      detail: "GitHub 上分给你或没人认领的新 issue，每 30 分钟看一次",
      paused: true,
      removable: true,
      createdAt: hoursFromNow(-120),
      activeAt: hoursFromNow(-52),
    },
    {
      id: "social:xiaohongshu:mentions",
      kind: "social",
      title: "小红书 · 评论和@",
      detail: "每 20 分钟左右看一次通知",
      paused: false,
      removable: false,
      activeAt: hoursFromNow(-2),
    },
  ];
}
