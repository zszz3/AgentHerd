// A fake bridge for previewing the UI in a plain browser (vite dev without Electron).
// It is installed only when the preload script did not set `window.agentherd`.
// `?sim=` picks the starting state:
//   fresh (default)  not bound, no Herder model: the first run opens
//   bound            bound and connected, no Herder model
//   network          bound, but connecting to Feishu failed; 重新连接 then works
//   ready            bound, connected, Herder chosen
//   empty            like ready, with no tasks
//   no-agent         like empty, with no agent profiles
//   offline          like ready, then the connection to the host drops
// `?open=` opens a dialog at once, for screenshots (see `devOpen`):
//   add-service      the 添加服务 chooser
//   add-builtin      the 添加服务 form of OpenRouter, with a few models chosen
//   add-custom       the 添加服务 form of an OpenAI-compatible address
//   edit-<id>        the edit dialog of the service <id> (deepseek, gateway)
//   task-<id>        the conversation of the task <id> (s2 has one)
//   subscription     the 用订阅登录 vendor list (ADR 0068)
//   chat             the expanded pet with the conversation (/pet.html)
// The pet window (/pet.html, ADR 0070) uses the same bridge; `?pet=` picks what it shows:
//   waiting          an approval waits for the owner
//   done             a task just finished
// `&arm=1` with `?pet=waiting` shows the approve shortcut's first press (ADR 0080).

import type {
  AgentView,
  AppsView,
  DanjuanTest,
  DanjuanView,
  FeedView,
  HostEvent,
  HostStatus,
  LarkView,
  LoginView,
  MailboxView,
  MemoryView,
  ModelsView,
  ModelTiersView,
  PetCard,
  PetView,
  PluginCatalogEntry,
  PluginPreview,
  PluginView,
  RemoteHost,
  SetupState,
  SocialView,
  Tier,
  WatchView,
  WecomView,
  WestockTest,
  WestockView,
} from "@agentherd/host/api";
import { DEFAULT_HERDER_WINDOW, DEFAULT_PET } from "@agentherd/host/api";
import { HERD_UI_TARGET, herdUiChoices, herdUiFence } from "@agentherd/protocol/herd-ui";
import type { Bridge } from "../../shared/bridge";
import type { Theme } from "../../shared/theme";
import {
  PLACEHOLDER_QR,
  providers,
  SAMPLE_SUBSCRIPTIONS,
  sampleFeeds,
  sampleHerderActivity,
  sampleHerderContext,
  sampleHerderMessages,
  sampleLark,
  sampleMailbox,
  sampleMemory,
  sampleServices,
  sampleSocials,
  sampleTasks,
  sampleTranscript,
  sampleWatches,
} from "./dev-fixtures";
import { fakeProfile, profileFieldOf } from "./profile";

type Listener<T> = (value: T) => void;

const SIMS = ["fresh", "bound", "network", "ready", "empty", "no-agent", "offline"] as const;

type Sim = (typeof SIMS)[number];

function simulation(): Sim {
  const value = new URLSearchParams(window.location.search).get("sim");
  return SIMS.find((s) => s === value) ?? "fresh";
}

function installFakeBridge(): void {
  const sim = simulation();
  const herderChosen = sim !== "fresh" && sim !== "bound" && sim !== "network";
  let devTheme: Theme = "system";
  const eventListeners = new Set<Listener<HostEvent>>();
  const connectionListeners = new Set<Listener<boolean>>();
  const keys = new Map<string, string>([["deepseek", "sk-fake"]]);
  let setupTimers: ReturnType<typeof setTimeout>[] = [];

  let status: HostStatus = {
    version: "0.0.0-dev",
    home: "~/.agentherd",
    channel:
      sim === "fresh"
        ? { bound: false, connected: false }
        : sim === "network"
          ? {
              bound: true,
              appId: "cli_fake123",
              connected: false,
              error: "getaddrinfo ENOTFOUND open.feishu.cn",
            }
          : { bound: true, appId: "cli_fake123", connected: true },
    herder: herderChosen
      ? { on: true, ref: "deepseek/deepseek-chat" }
      : { on: false, reason: "no model chosen for the Herder" },
    mode: "observe",
    locale: "zh-CN",
    keepAwake: true,
    herderWindow: DEFAULT_HERDER_WINDOW,
    profiles: sim === "no-agent" ? [] : ["pi"],
    // `?quiet=1`: the pet keeps quiet (ADR 0079).
    pet: {
      ...DEFAULT_PET,
      ...(new URLSearchParams(location.search).get("quiet") === "1"
        ? { quietUntil: new Date(Date.now() + 3_600_000).toISOString() }
        : {}),
    },
  };

  const petSim = new URLSearchParams(window.location.search).get("pet");
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const petHistory: PetView["history"] = [
    { id: 1, at: minutesAgo(42), kind: "owner", text: "帮我小红书搜一下西岸智塔附近好吃的面条" },
    { id: 2, at: minutesAgo(41), kind: "say", text: "好，我开个任务去小红书搜，挑走路能到的。" },
    {
      id: 3,
      at: minutesAgo(31),
      kind: "task",
      text: "下载并启动 yetone/magpie: cd /tmp/magpie-run && curl -L -o magpie.tar.gz https://github.com/yetone/magpie/releases/latest && tar xzf magpie.tar.gz",
    },
    { id: 4, at: minutesAgo(3), kind: "owner", text: "有啥参考的产品么" },
    {
      id: 5,
      at: minutesAgo(2),
      kind: "say",
      task: "Agent 资产分发调研",
      text: [
        "完整清单在这：~/.agentherd/tasks/b1ead723/agent-asset-distribution-products.md，**26 个链接**都验过。",
        "",
        "- **目录与市场**：Claude Marketplace、claude-plugins-official、ClawHub",
        "- **索引**：Official MCP Registry、Glama（12 万+ server）、[mcp.so](https://mcp.so)",
        "- **打包与版本**：MCP Bundle `.mcpb`、`npx skills`",
        "",
        "| 方向 | 值得看 |",
        "| --- | --- |",
        "| 签名 | Sigstore、npm provenance |",
        "| 审核 | 平台审核 + 命名空间验证 |",
        "",
        "最关键的一点：**签名是最大缺口**，目录大多只做到平台审核加命名空间验证。",
        "",
        "1. 先看 Claude Marketplace 的格式",
        "2. 再对照 MCP Registry 的 server.json",
        "3. 最后看 ClawHub 怎么做版本",
        "",
        "还想往哪个方向再挖？",
      ].join("\n"),
    },
    { id: 6, at: minutesAgo(1.9), kind: "owner", text: "把这几个整理一下给我看看" },
    // A reply with a herd-ui fence using every component (ADR 0074).
    {
      id: 7,
      at: minutesAgo(1.8),
      kind: "say",
      task: "Agent 资产分发调研",
      text: [
        "整理好了，三个最值得参考的放在一起比：",
        "",
        herdUiFence({
          title: "Agent 资产分发：三个参考",
          items: [
            { type: "text", content: "按**分发方式**和**信任模型**挑的，数字是今天看到的。" },
            {
              type: "stats",
              items: [
                { label: "验过的链接", value: "26" },
                { label: "目录", value: "9", hint: "含 3 个官方" },
                { label: "做了签名", value: "2", hint: "缺口最大" },
              ],
            },
            {
              type: "table",
              columns: ["产品", "形态", "签名", "版本"],
              rows: [
                ["Claude Marketplace", "插件目录", "无", "git tag"],
                ["MCP Registry", "server.json 索引", "命名空间验证", "semver"],
                ["ClawHub", "技能市场", "无", "自动递增"],
              ],
            },
            {
              type: "keyvalue",
              pairs: [
                { key: "任务", value: "Agent 资产分发调研" },
                { key: "用时", value: "18 分钟" },
                { key: "来源", value: "官方文档 + GitHub" },
              ],
            },
            {
              type: "steps",
              steps: [
                { title: "收集目录和索引", desc: "26 个链接", status: "done" },
                { title: "对比签名和版本", status: "doing" },
                { title: "写成一页结论", status: "todo" },
              ],
            },
            {
              type: "list",
              items: ["`.mcpb` 是打包格式，不管分发", "`npx skills` 直接从 GitHub 装"],
            },
            {
              type: "callout",
              tone: "warning",
              title: "签名是最大缺口",
              content: "目录大多只做到平台审核加命名空间验证，装进来的东西没人签过。",
            },
            {
              type: "code",
              lang: "json",
              code: '{\n  "name": "io.github.yetone/magpie",\n  "version": "0.4.2"\n}',
            },
            {
              type: "link",
              url: "https://github.com/yetone/magpie",
              title: "yetone/magpie",
              desc: "把 MCP server 打包成一个能双击运行的应用。",
              meta: "★ 38k · TypeScript",
            },
            {
              type: "file",
              path: "~/.agentherd/tasks/b1ead723/agent-asset-distribution-products.md",
              title: "完整清单",
              desc: "26 个链接，按方向分好",
            },
            { type: "divider", label: "接下来" },
            {
              type: "choices",
              question: "往哪个方向再挖？",
              options: ["签名", "版本管理", "先不用"],
            },
          ],
        }),
        "",
        "选一个我就接着查。",
      ].join("\n"),
    },
    // A picture on this computer, written as Markdown (ADR 0075); a missing one is named.
    {
      id: 8,
      at: minutesAgo(1.5),
      kind: "say",
      task: "查最近的未读邮件",
      text: [
        "飞书邮箱缺读信权限，扫这个码授权一下，10 分钟内有效：",
        "",
        "![飞书邮箱授权码](/tmp/lark-mail-auth.png)",
        "",
        "扫不了就打开 https://accounts.feishu.cn/oauth/v1/device/verify?user_code=RCKY-YCNM 。旧的码 ![旧码](/tmp/missing-old.png) 已经过期。",
      ].join("\n"),
    },
  ];
  let petLineId = 8;
  const waitingCard: PetCard = {
    ref: "fake:m9",
    at: minutesAgo(1),
    open: true,
    view: {
      kind: "item",
      itemId: "item-1",
      taskLabel: "清理旧日志",
      title: "运行 rm -rf ./logs/*",
      body: "rm -rf ./logs/*",
      risk: "high",
      reason: "一次删除大量文件，需要你确认",
      options: [
        { action: "allow", label: "同意" },
        { action: "deny", label: "拒绝" },
        { action: "skip", label: "跳过" },
      ],
    },
  };
  const petCards: PetCard[] = [
    {
      ref: "fake:m2",
      at: minutesAgo(41.5),
      open: false,
      view: {
        kind: "ask",
        askId: "a1",
        text: "要走路能到的吗？",
        options: [
          { action: "0", label: "要，走路十分钟以内" },
          { action: "1", label: "不用" },
        ],
        final: "要，走路十分钟以内",
      },
    },
    {
      ref: "fake:m5",
      at: minutesAgo(32),
      open: false,
      view: {
        kind: "report",
        taskId: "s9",
        result: "done",
        title: "小红书：西岸智塔附近面馆",
        subtitle: "已完成 · 无项目 · Pi · 9m",
        body: "找到了，最近的是传媒港 B1 那一排，走过去五分钟：\n- 阿娘面馆：黄鱼面，排队快\n- 味千拉面：豚骨汤浓\n- 和府捞面：环境好，适合坐着聊\n\n要不要我把营业时间也查一下？",
        summarized: true,
        fullReply:
          "我在小红书搜了「西岸智塔 面」「传媒港 面馆」两组词，读了 14 篇笔记，按距离和提到的次数排了一下……",
        fullReplyBy: "Pi",
        automaticDecisions: [
          "自动同意：XIAOHONGSHU_SEARCH_FEEDS ×2、XIAOHONGSHU_GET_FEED_DETAIL ×5",
        ],
      },
    },
    // A Herder reply that offers herd-ui choices comes as a text card (ADR 0074); 下载跑一下 picks.
    {
      ref: "fake:m11",
      at: minutesAgo(1.2),
      open: true,
      view: {
        kind: "text",
        target: `${HERD_UI_TARGET}3f6c1a2e-8d4b-4c1e-9a7f-0b2d5e6f7a81`,
        text: [
          "magpie 的发布包我看过了，能直接跑：",
          "",
          herdUiFence({
            items: [
              {
                type: "callout",
                tone: "success",
                content: "最新版 **v0.4.2**，macOS 包 18 MB，校验和对得上。",
              },
              { type: "choices", question: "现在就跑一下吗？", options: ["下载跑一下", "先不用"] },
            ],
          }),
        ].join("\n"),
      },
    },
    ...(petSim === "waiting" ? [waitingCard] : []),
  ];
  let pet: PetView = {
    connected: sim !== "fresh" && sim !== "network",
    last: petHistory.at(-1),
    history: petHistory,
    cards: petCards,
    // The Herder's guess at the next message (ADR 0084).
    suggestion: "把第二家的地址也发我",
    pending:
      petSim === "waiting"
        ? [
            {
              target: "item-1",
              task: "清理旧日志",
              title: "运行 rm -rf ./logs/*",
              body: "rm -rf ./logs/*",
              options: [
                { action: "allow", label: "同意" },
                { action: "deny", label: "拒绝" },
                { action: "skip", label: "跳过" },
              ],
            },
          ]
        : [],
  };
  const petLine = (line: Omit<NonNullable<PetView["last"]>, "id" | "at">) => {
    petLineId++;
    const next = { ...line, id: petLineId, at: new Date().toISOString() };
    pet = { ...pet, history: [...pet.history, next].slice(-80) };
    return next;
  };
  const petSays = (line: Omit<NonNullable<PetView["last"]>, "id" | "at">): void => {
    pet = { ...pet, last: petLine(line) };
    emit({ topic: "pet", data: structuredClone(pet) });
  };
  if (petSim === "done") {
    setTimeout(() => {
      const card: PetCard = {
        ref: "fake:m20",
        at: new Date().toISOString(),
        open: false,
        view: {
          kind: "report",
          taskId: "s2",
          result: "done",
          title: "修登录 401",
          subtitle: "已完成 · web-portal · Pi · 12m",
          body: "登录修好了，测试都过了，PR 已开。",
          summarized: false,
          automaticDecisions: [],
        },
      };
      petLineId++;
      pet = {
        ...pet,
        cards: [...pet.cards, card],
        last: {
          id: petLineId,
          at: card.at,
          kind: "report",
          task: "修登录 401",
          result: "done",
          text: "登录修好了，测试都过了，PR 已开。",
          card: card.ref,
        },
      };
      emit({ topic: "pet", data: structuredClone(pet) });
    }, 1500);
  }

  let tasks = sampleTasks(sim === "empty" || sim === "no-agent");

  let models: ModelsView = {
    services: sampleServices(),
    roles: herderChosen ? { herder: { serviceId: "deepseek", model: "deepseek-chat" } } : {},
  };

  let setup: SetupState = { phase: "idle" };
  let memory: MemoryView = sampleMemory();
  let apps: AppsView =
    sim === "ready"
      ? {
          hasKey: true,
          apps: [
            { slug: "gmail", name: "Gmail", connected: true, connecting: false },
            { slug: "github", name: "GitHub", connected: false, connecting: false },
            { slug: "slack", name: "Slack", connected: false, connecting: false },
            { slug: "notion", name: "Notion", connected: true, connecting: false },
          ],
        }
      : { hasKey: false, apps: [] };
  const appsChanged = (): void => emit({ topic: "apps", data: structuredClone(apps) });
  // `?fail=zhihu` shows a platform in error, which opens its row on 应用连接.
  const failing = new URLSearchParams(window.location.search).get("fail");
  let socials: SocialView[] = sampleSocials().map((s) =>
    s.platform === failing
      ? { ...s, accepted: true, enabled: true, state: "failed", problem: "浏览器没能打开登录页" }
      : s,
  );
  let watches: WatchView[] = sampleWatches(sim === "empty" || sim === "no-agent");
  let lark: LarkView = sampleLark(sim === "empty" || sim === "no-agent");
  const wecomDisconnected: WecomView = { state: "disconnected", capabilities: [] };
  let wecom = wecomDisconnected;
  let wecomTimer: ReturnType<typeof setTimeout> | undefined;
  const clearWecom = () => {
    clearTimeout(wecomTimer);
    wecom = wecomDisconnected;
    return delay(wecom);
  };
  let feeds: FeedView[] = sampleFeeds();
  let westock: WestockView = {
    enabled: true,
    cliState: "missing",
    supported: true,
  };
  const setWestock = (next: WestockView): void => {
    westock = next;
    emit({ topic: "westock", data: structuredClone(westock) });
  };
  let danjuan: DanjuanView = {
    available: true,
    accepted: false,
    enabled: false,
    state: "off",
  };
  const setDanjuan = (next: DanjuanView): void => {
    danjuan = next;
    emit({ topic: "danjuan", data: structuredClone(danjuan) });
  };
  // 插件 (ADR 0094): one installed plugin and a small library.
  const pluginCatalog: PluginCatalogEntry[] = [
    {
      name: "context7",
      title: "Context7",
      description:
        "Upstash Context7 MCP server for up-to-date documentation lookup. Pull version-specific docs and code examples directly from source repositories into your LLM context.",
      category: "development",
      author: "Upstash",
      source: "official:context7",
      installed: true,
    },
    {
      name: "github",
      title: "GitHub",
      description:
        "Official GitHub MCP server for repository management. Create issues, manage pull requests, review code, search repositories.",
      category: "productivity",
      author: "GitHub",
      source: "official:github",
      installed: false,
    },
    {
      name: "playwright",
      title: "Playwright",
      description: "Browser automation and end-to-end testing MCP server by Microsoft.",
      category: "testing",
      author: "Microsoft",
      source: "official:playwright",
      installed: false,
    },
    {
      name: "code-review",
      title: "Code Review",
      description: "Automated code review for pull requests using multiple specialized agents.",
      category: "productivity",
      author: "Anthropic",
      source: "official:code-review",
      installed: false,
    },
    {
      name: "xcode",
      title: "Xcode",
      description: "Build and test iOS apps from Xcode.",
      category: "development",
      why: "要用它自己的命令装，AgentHerd 不支持",
      installed: false,
    },
  ];
  let mailbox: MailboxView = sampleMailbox(sim === "empty" || sim === "no-agent");
  const setMailbox = (next: MailboxView): Promise<MailboxView> => {
    mailbox = next;
    emit({ topic: "mailbox", data: structuredClone(mailbox) });
    return delay(structuredClone(mailbox));
  };
  let plugins: PluginView[] = [
    {
      id: "context7",
      source: "official:context7",
      link: "https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/context7",
      name: "context7",
      description: "Upstash Context7 MCP server for up-to-date documentation lookup",
      format: "claude",
      servers: [
        {
          name: "context7",
          kind: "http",
          run: "https://mcp.context7.com/mcp?client=claude-code-plugin",
        },
      ],
      keys: [],
      skills: [],
      ignored: [],
      problems: [],
      enabled: true,
      herder: false,
      installedAt: "2026-11-21T07:30:00.000Z",
      state: "ready",
      tools: 2,
      readTools: 2,
      keysSet: [],
      dir: "~/.agentherd/plugins/context7",
    },
  ];
  const setPlugins = (next: PluginView[]): PluginView[] => {
    plugins = next;
    emit({ topic: "plugins", data: structuredClone(plugins) });
    return structuredClone(plugins);
  };
  const pluginPreview = (source: string): PluginPreview => ({
    source,
    link: "https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/github",
    name:
      source
        .replace(/^official:/, "")
        .split("/")
        .pop() ?? "plugin",
    description: "Official GitHub MCP server for repository management.",
    format: "claude",
    servers: [{ name: "github", kind: "http", run: "https://api.githubcopilot.com/mcp/" }],
    keys: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    skills: [{ name: "pr-review", description: "Review a pull request step by step" }],
    ignored: ["3 个斜杠命令", "1 个子 Agent"],
    problems: [],
  });
  /** Changes 飞书 and tells the page, as the host's "lark" event does. */
  const setLark = (next: LarkView): void => {
    lark = next;
    emit({ topic: "lark", data: structuredClone(lark) });
  };
  /** Changes one platform and tells the page, as the host's "socials" event does. */
  const setSocial = (platform: SocialView["platform"], patch: Partial<SocialView>): void => {
    socials = socials.map((s) => (s.platform === platform ? { ...s, ...patch } : s));
    emit({ topic: "socials", data: structuredClone(socials) });
  };

  let login: LoginView | undefined;
  const finishLogin = (vendor: (typeof SAMPLE_SUBSCRIPTIONS)[number]): void => {
    if (login === undefined) return;
    const ids = vendor.models.map((m) => m.id);
    keys.set(login.serviceId, "signed-in");
    const others = models.services.filter((s) => s.id !== login?.serviceId);
    models = {
      ...models,
      services: [
        ...others,
        {
          id: login.serviceId,
          name: vendor.name,
          kind: "builtin",
          provider: vendor.provider,
          auth: "subscription",
          models: ids,
          hasKey: true,
        },
      ],
    };
    login = { ...login, status: "done", models: ids, prompt: undefined };
    emit({ topic: "login", data: structuredClone(login) });
    emit({ topic: "models", data: structuredClone(models) });
  };
  const emit = (event: HostEvent): void => {
    for (const l of eventListeners) l(event);
  };
  const delay = <T>(value: T, ms = 150): Promise<T> =>
    new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), ms));

  const herderStatus = (): HostStatus["herder"] => {
    const ref = models.roles.herder;
    return ref === undefined
      ? { on: false, reason: "no model chosen for the Herder" }
      : { on: true, ref: `${ref.serviceId}/${ref.model}` };
  };
  const modelsChanged = (): ModelsView => {
    // Like core: roles that point at models no longer listed are cleared.
    const roles: ModelsView["roles"] = {};
    for (const role of ["herder", "reviewer", "pi"] as const) {
      const ref = models.roles[role];
      if (ref === undefined) continue;
      const s = models.services.find((x) => x.id === ref.serviceId);
      if (s?.models.includes(ref.model)) roles[role] = ref;
    }
    models = { ...models, roles };
    status = { ...status, herder: herderStatus() };
    emit({ topic: "models", data: structuredClone(models) });
    emit({ topic: "status", data: structuredClone(status) });
    return models;
  };
  const setSetup = (next: SetupState): void => {
    setup = next;
    emit({ topic: "setup", data: structuredClone(setup) });
  };

  const missing = (id: string, name: string, extra: Partial<AgentView> = {}): AgentView => ({
    id,
    name,
    state: "missing",
    canInstall: false,
    canRemove: false,
    ...extra,
  });
  const bundled = (id: string, name: string, version: string): AgentView => ({
    id,
    name,
    state: "ready",
    source: "bundled",
    version,
    adapted: version,
    path: `/Applications/AgentHerd.app/Contents/Resources/agents/${id}/${version}`,
    canInstall: false,
    canRemove: false,
  });
  const claudeMissing = missing("claude", "Claude Code", {
    adapted: "0.107.2",
    onRequest: true,
    canInstall: true,
    ...(sim === "no-agent" ? {} : { ownCli: "/Users/me/.local/bin/claude" }),
  });
  const antigravity: AgentView =
    sim === "no-agent"
      ? missing("antigravity", "Antigravity")
      : {
          id: "antigravity",
          name: "Antigravity",
          state: "ready",
          source: "system",
          path: "/Users/me/.local/bin/agy",
          canInstall: false,
          canRemove: false,
        };
  let agents: AgentView[] =
    sim === "no-agent"
      ? [
          missing("pi", "Pi", { adapted: "1.5.0" }),
          missing("codex", "Codex", { adapted: "2.5.0" }),
          claudeMissing,
          antigravity,
        ]
      : [
          bundled("pi", "Pi", "1.5.0"),
          bundled("codex", "Codex", "2.5.0"),
          claudeMissing,
          antigravity,
        ];
  const setAgents = (next: AgentView[]): AgentView[] => {
    agents = next;
    const ids = agents.filter((a) => a.state === "ready").map((a) => a.id);
    status = { ...status, profiles: ids };
    emit({ topic: "agents", data: structuredClone(agents) });
    emit({ topic: "status", data: structuredClone(status) });
    return agents;
  };
  const patch = (id: string, change: Partial<AgentView>): AgentView[] =>
    setAgents(agents.map((a) => (a.id === id ? ({ ...a, ...change } as AgentView) : a)));
  const reset = (a: AgentView): AgentView =>
    a.id === "claude" ? claudeMissing : missing(a.id, a.name);

  // The fake places models by a few names; the real rules are in packages/herder/src/model-guide.ts.
  let placed: Record<Tier, string[]> | null = null;
  const fakeTier = (model: string): Tier =>
    /opus|gpt-6|pro-latest/.test(model)
      ? "strong"
      : /flash|mini|haiku/.test(model)
        ? "fast"
        : "balanced";
  const tiersView = (): ModelTiersView => {
    const names = [...new Set(models.services.flatMap((s) => s.models))];
    const all = names.map((model) => ({
      model,
      services: models.services.filter((s) => s.models.includes(model)).map((s) => s.name),
    }));
    const tiers: ModelTiersView["tiers"] = { strong: [], balanced: [], fast: [] };
    const done = new Set<string>();
    for (const tier of ["strong", "balanced", "fast"] as const) {
      for (const name of placed?.[tier] ?? []) {
        const m = all.find((x) => x.model === name);
        if (m === undefined || done.has(name)) continue;
        done.add(name);
        tiers[tier].push({ ...m, auto: false });
      }
    }
    for (const m of all)
      if (!done.has(m.model)) tiers[fakeTier(m.model)].push({ ...m, auto: true });
    return { tiers, custom: placed !== null };
  };

  const fake: RemoteHost = {
    apps: (search) =>
      delay({
        ...apps,
        apps: apps.apps.filter(
          (a) => search === undefined || a.slug.includes(search.toLowerCase()),
        ),
      }),
    setComposioKey: (key) => {
      if (key.trim() === "") apps = { hasKey: false, apps: [] };
      else if (key.trim() === "bad")
        return delay({ ...apps, problem: "这个 Composio API Key 不能用：Invalid API key" });
      else
        apps = {
          hasKey: true,
          apps: [
            { slug: "gmail", name: "Gmail", connected: false, connecting: false },
            { slug: "github", name: "GitHub", connected: false, connecting: false },
          ],
        };
      return delay(apps, 600);
    },
    lark: () => delay(lark),
    connectLark: () => {
      // The preview installs lark-cli when it is missing, then "scans" by itself.
      const installing = lark.state === "missing";
      if (installing) setLark({ state: "installing" });
      const wait = installing ? 2500 : 800;
      setTimeout(
        () => setLark({ state: "ready", account: "预览账号", version: "1.4.0" }),
        wait + 4000,
      );
      return delay({ image: PLACEHOLDER_QR, url: "https://open.feishu.cn/example" }, wait);
    },
    testLark: () =>
      delay({
        ok: lark.state === "ready",
        message: lark.state === "ready" ? "飞书连接正常，读到了你的日历" : "还没登录飞书",
        lark,
      }),
    logoutLark: () => {
      lark = { state: "signed-out", version: "1.4.0" };
      return delay(lark);
    },
    wecom: () => delay(wecom),
    startWecomLogin: () => {
      if (wecom.state === "connecting" || wecom.state === "connected") return delay(wecom);
      wecom = { state: "connecting", qr: PLACEHOLDER_QR, capabilities: [] };
      wecomTimer = setTimeout(() => {
        wecom =
          failing === "wecom"
            ? { state: "failed", capabilities: [] }
            : {
                state: "connected",
                capabilities: [
                  { id: "doc", name: "文档", toolCount: 3 },
                  { id: "calendar", name: "日程", toolCount: 3 },
                ],
              };
      }, 4000);
      return delay(wecom);
    },
    cancelWecomLogin: () => (wecom.state === "connecting" ? clearWecom() : delay(wecom)),
    disconnectWecom: clearWecom,
    pet: () => delay(pet),
    petSay: (text, paths = []) => {
      if (!pet.connected)
        return Promise.reject(new Error("AgentHerd 还没连上飞书，先在 App 里设置好"));
      const files = paths.map((p) => `[主人拖来文件「${p.split("/").at(-1)}」：${p}]`);
      const said = [text, ...files].filter((x) => x !== "").join("\n");
      petLine({ kind: "owner", text: said });
      const { suggestion: _gone, ...rest } = pet;
      pet = rest;
      emit({ topic: "pet", data: structuredClone(pet) });
      setTimeout(() => petSays({ kind: "say", text: `收到：「${said}」。我这就去办。` }), 1200);
      setTimeout(() => {
        pet = { ...pet, suggestion: "好，做完告诉我" };
        emit({ topic: "pet", data: structuredClone(pet) });
      }, 2400);
      return delay(pet);
    },
    petPress: (target, action) => {
      if (target.startsWith(HERD_UI_TARGET)) {
        // An answer of a reply's herd-ui choices (ADR 0074): the card keeps it and closes.
        const offer = pet.cards.find(
          (c) => c.open && c.view.kind === "text" && c.view.target === target,
        );
        if (offer === undefined || offer.view.kind !== "text")
          return Promise.reject(new Error("这件事已经处理过了"));
        const label =
          herdUiChoices(offer.view.text).find((c) => c.action === action)?.label ?? action;
        pet = {
          ...pet,
          cards: pet.cards.map((c) =>
            c === offer && c.view.kind === "text"
              ? { ...c, open: false, view: { ...c.view, chosen: label } }
              : c,
          ),
        };
        emit({ topic: "pet", data: structuredClone(pet) });
        setTimeout(() => petSays({ kind: "say", text: `好，就「${label}」。我这就去办。` }), 1200);
        return delay(pet);
      }
      const card = pet.pending.find((p) => p.target === target);
      if (card === undefined) return Promise.reject(new Error("这件事已经处理过了"));
      const label = card.options.find((o) => o.action === action)?.label ?? action;
      pet = {
        ...pet,
        pending: pet.pending.filter((p) => p !== card),
        cards: pet.cards.map((c) =>
          c.view.kind === "item" && c.view.itemId === target
            ? { ...c, open: false, view: { ...c.view, options: [], final: `你已${label}` } }
            : c,
        ),
      };
      emit({ topic: "pet", data: structuredClone(pet) });
      petSays({
        kind: "task",
        task: card.task ?? "",
        text: action === "allow" ? "你同意了，继续干活。" : "好的，这步不做了。",
      });
      return delay(pet);
    },
    stopTask: (taskId) => {
      tasks = {
        ...tasks,
        tasks: tasks.tasks.map((t) =>
          t.id === taskId
            ? {
                ...t,
                stage: "failed",
                lastReport: "已报告：你停下了这个任务，做到一半的事没有做完。",
                updatedAt: new Date().toISOString(),
              }
            : t,
        ),
      };
      emit({ topic: "tasks", data: structuredClone(tasks) });
      return delay(undefined);
    },
    feeds: () => delay(feeds),
    setFeed: (source, on) => {
      feeds = feeds.map((f) => (f.source === source ? { ...f, on } : f));
      return delay(feeds);
    },
    westock: () => delay(structuredClone(westock)),
    setWestockEnabled: (on) => {
      setWestock({ ...westock, enabled: on });
      return delay(structuredClone(westock));
    },
    installWestock: async () => {
      setWestock({ ...westock, cliState: "installing", problem: undefined });
      await new Promise((r) => setTimeout(r, 350));
      setWestock({
        enabled: westock.enabled,
        cliState: "ready",
        supported: true,
        version: "0.0.2",
        managed: true,
        path: "~/.agentherd/bin/westock",
      });
      return structuredClone(westock);
    },
    removeWestock: () => {
      setWestock({ enabled: westock.enabled, cliState: "missing", supported: true });
      return delay(structuredClone(westock));
    },
    testWestock: (): Promise<WestockTest> => {
      const cliLabel = westock.cliState === "ready" ? " · westock v0.0.2 就绪" : "";
      return delay({
        ok: true,
        message: `实时行情正常：上证指数 3328.45 (+0.62%) · 腾讯控股 412.60 (+1.53%)${cliLabel}`,
        sample:
          "- 上证指数 (sh000001): 3328.45 (+20.51 / +0.62%) | 开 3310.12 昨收 3307.94 区间 3302.18-3334.90 | 成交额 6420.15亿 CNY\n- 腾讯控股 (hk00700): 412.60 HKD (+6.20 / +1.53%) | 开 408.00 昨收 406.40 区间 407.20-415.00 | 成交额 98.42亿 HKD | PE 19.80\nSource: 腾讯财经实时行情 (qt.gtimg.cn) · Objective market data for reference only, not investment advice.",
        westock: structuredClone(westock),
      });
    },
    danjuan: () => delay(structuredClone(danjuan)),
    mailbox: () => delay(structuredClone(mailbox)),
    mailboxAdd: (draft) =>
      setMailbox({
        ...mailbox,
        sources: [
          ...mailbox.sources,
          {
            id: `m-${Date.now()}`,
            kind: draft.kind,
            name: draft.name,
            note: draft.note ?? "",
            config: {
              ...(draft.repo === undefined ? {} : { repo: draft.repo }),
              ...(draft.what === undefined ? {} : { what: draft.what }),
              ...(draft.url === undefined ? {} : { url: draft.url }),
              ...(draft.words === undefined ? {} : { words: draft.words }),
              ...(draft.command === undefined ? {} : { command: draft.command }),
              ...(draft.query === undefined ? {} : { query: draft.query }),
              ...(draft.platform === undefined ? {} : { platform: draft.platform }),
              ...(draft.label === undefined ? {} : { label: draft.label }),
              ...(draft.when === undefined ? {} : { when: draft.when }),
            },
            everyMinutes:
              draft.kind === "timer"
                ? 0
                : (draft.everyMinutes ?? mailbox.every[draft.kind].default),
            act:
              draft.kind === "timer"
                ? "sort"
                : draft.act === "auto"
                  ? "trial"
                  : (draft.act ?? "sort"),
            trials: 0,
            ...(draft.kind === "timer"
              ? { nextAt: new Date(Date.now() + 3600_000).toISOString() }
              : {}),
            paused: false,
            by: "owner",
            createdAt: new Date().toISOString(),
            started: draft.kind === "timer",
            fails: 0,
            letters: 0,
          },
        ],
      }),
    mailboxSet: (id, patch) =>
      setMailbox({
        ...mailbox,
        sources: mailbox.sources.map((s) =>
          s.id === id
            ? {
                ...s,
                ...(patch.paused === undefined ? {} : { paused: patch.paused }),
                ...(patch.name === undefined ? {} : { name: patch.name }),
                ...(patch.note === undefined ? {} : { note: patch.note }),
                ...(patch.everyMinutes === undefined ? {} : { everyMinutes: patch.everyMinutes }),
                ...(patch.act === undefined
                  ? {}
                  : { act: patch.act === "auto" ? ("trial" as const) : patch.act }),
                ...(patch.fields === undefined
                  ? {}
                  : {
                      config: Object.fromEntries(
                        Object.entries(patch.fields).filter(([, v]) => v !== undefined),
                      ),
                      ...(s.kind === "timer" ? {} : { started: false, fails: 0 }),
                    }),
              }
            : s,
        ),
      }),
    mailboxRemove: (id) =>
      setMailbox({
        ...mailbox,
        sources: mailbox.sources.filter((s) => s.id !== id),
        letters: mailbox.letters.filter((l) => l.sourceId !== id),
      }),
    mailboxRun: async (id) => {
      await new Promise((r) => setTimeout(r, 700));
      return setMailbox({
        ...mailbox,
        sources: mailbox.sources.map((s) =>
          s.id === id
            ? {
                ...s,
                lastRunAt: new Date().toISOString(),
                lastError: undefined,
                fails: 0,
                started: true,
              }
            : s,
        ),
      });
    },
    mailboxTry: async (draft) => {
      await new Promise((r) => setTimeout(r, 700));
      if (draft.kind === "timer") {
        const next = new Date(Date.now() + 3600_000).toISOString();
        return [{ id: "next", title: draft.name, body: `daily; next ${next}` }];
      }
      if (draft.kind === "github") {
        return [
          { id: "issue:7012", title: "#7012 Crash on macOS 26 when resuming a session" },
          { id: "issue:7011", title: "#7011 Support for custom MCP timeouts" },
          { id: "release:1", title: "发布 rust-v0.72.0" },
        ];
      }
      return [];
    },
    pluginCatalog: () => delay(structuredClone(pluginCatalog)),
    plugins: () => delay(structuredClone(plugins)),
    previewPlugin: async (source) => {
      await new Promise((r) => setTimeout(r, 600));
      return pluginPreview(source);
    },
    installPlugin: async (source) => {
      const p = pluginPreview(source);
      return setPlugins([
        ...plugins,
        {
          ...p,
          id: p.name,
          enabled: true,
          herder: false,
          installedAt: new Date().toISOString(),
          state: "idle",
          tools: 0,
          readTools: 0,
          keysSet: [],
          dir: `~/.agentherd/plugins/${p.name}`,
        },
      ]);
    },
    setPlugin: async (id, patch) =>
      setPlugins(
        plugins.map((p) =>
          p.id === id
            ? {
                ...p,
                ...(patch.enabled === undefined
                  ? {}
                  : { enabled: patch.enabled, state: patch.enabled ? "ready" : "off" }),
                ...(patch.herder === undefined ? {} : { herder: patch.herder }),
                ...(patch.keys === undefined
                  ? {}
                  : { keysSet: [...new Set([...p.keysSet, ...Object.keys(patch.keys)])] }),
              }
            : p,
        ),
      ),
    removePlugin: async (id) => setPlugins(plugins.filter((p) => p.id !== id)),
    connectDanjuan: async (accepted) => {
      if (!accepted && !danjuan.accepted) {
        throw new Error("连接雪球基金前需先确认只读风险提示");
      }
      setDanjuan({
        available: true,
        accepted: true,
        enabled: true,
        state: "signing-in",
      });
      await new Promise((r) => setTimeout(r, 350));
      setDanjuan({
        available: true,
        accepted: true,
        enabled: true,
        state: "ready",
        account: "默认账户",
        checkedAt: new Date().toISOString(),
      });
      return structuredClone(danjuan);
    },
    cancelDanjuanLogin: () => {
      setDanjuan({
        available: true,
        accepted: danjuan.accepted,
        enabled: false,
        state: "off",
      });
      return delay(structuredClone(danjuan));
    },
    testDanjuan: (): Promise<DanjuanTest> =>
      delay({
        ok: danjuan.state === "ready",
        message:
          danjuan.state === "ready"
            ? "连接正常：共 3 只持仓基金，总资产 128450.20元"
            : "还没连接雪球基金",
        ...(danjuan.state === "ready"
          ? {
              sample:
                "雪球基金账户概览：总资产 128450.20元 · 最新日收益 (2026-11-18) +1120.40元 · 持有收益 +9420.15元\n近 5 个交易日估算汇总：+2.18% (+2741.80元，按当前持仓静态回算)\n持仓明细（按市值降序）：\n- 华泰柏瑞沪深300ETF联接C (006131) | 市值 62400.00元 (占比 48.6%) | 日收益 +590.10元 | 近5日 +2.35%\n  每日净值涨跌: 11-12 -0.30% · 11-13 +0.85% · 11-16 +0.42% · 11-17 +0.44% · 11-18 +0.92%\nSource: 雪球基金 (danjuanfunds.com) 本机登录态 · 近几日区间涨跌按当前持仓市值回算（未计期间申赎），仅供参考，不构成投资建议。",
            }
          : {}),
        danjuan: structuredClone(danjuan),
      }),
    logoutDanjuan: () => {
      setDanjuan({
        available: true,
        accepted: danjuan.accepted,
        enabled: false,
        state: "off",
      });
      return delay(structuredClone(danjuan));
    },
    socials: () => delay(socials),
    enableSocial: (platform) => {
      setSocial(platform, { enabled: true, accepted: true, state: "starting" });
      setTimeout(() => setSocial(platform, { state: "signed-out" }), 1500);
      return delay(socials);
    },
    disableSocial: (platform) => {
      setSocial(platform, { enabled: false, state: "off" });
      return delay(socials);
    },
    socialLoginCode: (platform) => {
      // The preview "scans" by itself after a few seconds.
      setTimeout(() => setSocial(platform, { state: "ready", account: "预览账号" }), 4000);
      return delay({ image: PLACEHOLDER_QR, signedIn: false }, 600);
    },
    socialLogout: (platform) => {
      socials = socials.map((s) => {
        if (s.platform !== platform) return s;
        const { account: _, ...rest } = s;
        return { ...rest, state: "signed-out" as const };
      });
      return delay(socials);
    },
    testSocial: (platform) => {
      const s = socials.find((x) => x.platform === platform);
      const ok = s?.state === "ready";
      return delay(
        {
          ok,
          message: ok ? `连接正常，账号「${s?.account ?? ""}」` : "登录已失效，点「重连」扫码",
          socials,
        },
        800,
      );
    },
    setSocialWatch: (platform, kind, on) => {
      socials = socials.map((s) =>
        s.platform === platform ? { ...s, watch: { ...s.watch, [kind]: on } } : s,
      );
      return delay(socials);
    },
    watches: () => delay(watches),
    setWatchPaused: (id, paused) => {
      watches = watches.map((w) => (w.id === id ? { ...w, paused } : w));
      return delay(watches);
    },
    removeWatch: (id) => {
      watches = watches.filter((w) => w.id !== id || !w.removable);
      return delay(watches);
    },
    connectApp: (slug) => {
      apps = {
        ...apps,
        apps: apps.apps.map((a) => (a.slug === slug ? { ...a, connecting: true } : a)),
      };
      appsChanged();
      setTimeout(() => {
        apps = {
          ...apps,
          apps: apps.apps.map((a) =>
            a.slug === slug ? { ...a, connecting: false, connected: true } : a,
          ),
        };
        appsChanged();
      }, 3000);
      return delay({ url: "https://example.com/" });
    },
    disconnectApp: (slug) => {
      apps = {
        ...apps,
        apps: apps.apps.map((a) => (a.slug === slug ? { ...a, connected: false } : a)),
      };
      return delay(apps);
    },
    agents: () => delay(agents),
    installAgent: (id) => {
      const total = 87 * 1024 * 1024;
      let received = 0;
      const tick = setInterval(() => {
        received += total / 8;
        if (agents.find((a) => a.id === id)?.state !== "installing") return clearInterval(tick);
        if (received < total) {
          patch(id, { progress: { received, total } });
          return;
        }
        clearInterval(tick);
        patch(id, {
          state: "ready",
          source: "managed",
          version: "0.107.2",
          path: `~/.agentherd/runtimes/${id}/0.107.2`,
          progress: undefined,
          canInstall: false,
          canRemove: true,
        });
      }, 400);
      return delay(patch(id, { state: "installing", progress: { received: 0, total } }));
    },
    cancelInstall: (id) => delay(setAgents(agents.map((a) => (a.id === id ? reset(a) : a)))),
    removeAgent: (id) => delay(setAgents(agents.map((a) => (a.id === id ? reset(a) : a)))),
    verifyAgent: (id) => {
      const loginNeeded = false;
      const agent = agents.find((a) => a.id === id);
      return delay(
        loginNeeded
          ? {
              id,
              ok: false,
              needsLogin: true,
              authMethods: ["Log in with your account"],
              error: "Authentication required",
              ms: 1800,
            }
          : {
              id,
              ok: true,
              needsLogin: false,
              agentName: agent?.name ?? id,
              agentVersion: agent?.version ?? "0.2.1-rc.2",
              authMethods: [],
              ms: 1200,
            },
        1200,
      );
    },
    status: () => delay(status),
    reconnect: () => {
      // The second try connects.
      if (status.channel.bound) {
        status = {
          ...status,
          channel: { bound: true, appId: status.channel.appId, connected: true },
        };
        emit({ topic: "status", data: structuredClone(status) });
      }
      return delay(status, 900);
    },
    tasks: () => delay(tasks),
    transcript: (taskId) => delay(sampleTranscript(taskId)),
    herderActivity: () => delay(sampleHerderActivity()),
    herderContext: (known?: string) =>
      delay(
        known === `sample-${status.herderWindow}`
          ? { key: known, unchanged: true as const }
          : sampleHerderContext(status.herderWindow),
      ),
    herderMessages: (from: number, to: number) => delay(sampleHerderMessages(from, to)),
    herderContextFold: (blockId: string) =>
      delay(
        `${blockId} 原文\n\n[Owner's message]\n帮我看看别人的搜索方案\n\n主管：Codex 和 Claude Code 都只有一个 web_search……`,
      ),
    memories: () => delay(memory),
    editMemory: (id, text) => {
      memory = {
        ...memory,
        entries: memory.entries.map((e) =>
          e.id === id ? { ...e, abstract: text, source: "owner_edit" as const, rev: e.rev + 1 } : e,
        ),
      };
      return delay(memory);
    },
    forgetMemory: (id) => {
      const gone = memory.entries.find((e) => e.id === id);
      memory = {
        ...memory,
        entries: memory.entries.filter((e) => e.id !== id),
        deleted:
          gone === undefined ? memory.deleted : [{ ...gone, status: "deleted" }, ...memory.deleted],
      };
      return delay(memory);
    },
    ownerProfile: () => delay(fakeProfile(memory)),
    setProfile: (field, value) => {
      const text = value.trim();
      const rest = memory.entries.filter(
        (e) => !(e.kind === "profile" && profileFieldOf(e.abstract) === field),
      );
      const added = {
        ...(memory.entries.find((e) => e.kind === "profile") ?? memory.entries[0]),
        id: `p-${field}-${Date.now()}`,
        kind: "profile" as const,
        abstract: `${field}：${text}`,
        source: "owner_edit" as const,
        rev: 1,
      };
      const { evidence: _, ...entry } = added;
      memory = { ...memory, entries: text === "" ? rest : [entry, ...rest] };
      return delay(fakeProfile(memory));
    },
    restoreMemory: (id) => {
      const back = memory.deleted.find((e) => e.id === id);
      memory = {
        ...memory,
        deleted: memory.deleted.filter((e) => e.id !== id),
        entries:
          back === undefined ? memory.entries : [{ ...back, status: "active" }, ...memory.entries],
      };
      return delay(memory);
    },
    providers: () => delay(providers),
    models: () => delay(models),
    putService: (service, key) => {
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(service.id)) {
        return Promise.reject(new Error(`service id "${service.id}" is invalid`));
      }
      if (service.models.length === 0) {
        return Promise.reject(new Error(`service "${service.id}" has no models`));
      }
      if (key === "") keys.delete(service.id);
      else if (key !== undefined) keys.set(service.id, key);
      const others = models.services.filter((s) => s.id !== service.id);
      models = {
        ...models,
        services: [...others, { ...service, hasKey: keys.has(service.id) }],
      };
      return delay(modelsChanged());
    },
    removeService: (serviceId) => {
      keys.delete(serviceId);
      models = { ...models, services: models.services.filter((s) => s.id !== serviceId) };
      return delay(modelsChanged());
    },
    setKey: (serviceId, key) => {
      if (key === "") keys.delete(serviceId);
      else keys.set(serviceId, key);
      models = {
        ...models,
        services: models.services.map((s) =>
          s.id === serviceId ? { ...s, hasKey: keys.has(serviceId) } : s,
        ),
      };
      return delay(modelsChanged());
    },
    chooseModel: (role, ref) => {
      const roles = { ...models.roles };
      if (ref === null) delete roles[role];
      else roles[role] = ref;
      models = { ...models, roles };
      return delay(modelsChanged());
    },
    testModel: (ref) => {
      const s = models.services.find((x) => x.id === ref.serviceId);
      if (s === undefined) return delay({ ok: false, message: `no service "${ref.serviceId}"` });
      if (!keys.has(s.id) && s.kind === "builtin") {
        return delay({ ok: false, message: "401 Unauthorized: missing API key" }, 700);
      }
      return delay({ ok: true, reply: `你好，我是 ${ref.model}。` }, 900);
    },
    subscriptions: () => delay(SAMPLE_SUBSCRIPTIONS),
    startLogin: (provider, serviceId) => {
      const vendor = SAMPLE_SUBSCRIPTIONS.find((v) => v.provider === provider);
      if (vendor === undefined) return Promise.reject(new Error(`cannot sign in to "${provider}"`));
      login = {
        id: `login-${Date.now()}`,
        provider,
        serviceId,
        status: "running",
        ...(provider === "github-copilot"
          ? { userCode: "8F2A-61C4", url: "https://github.com/login/device" }
          : {
              url: "https://auth.example.com/authorize",
              instructions: "在浏览器里登录；如果没有自动跳回来，把地址栏里的代码贴到下面。",
              prompt: { type: "manual_code", message: "粘贴登录后的代码", placeholder: "code" },
            }),
      };
      const id = login.id;
      if (provider === "github-copilot") {
        setTimeout(() => {
          if (login?.id === id && login.status === "running") finishLogin(vendor);
        }, 4000);
      }
      return delay(structuredClone(login));
    },
    answerLogin: (id) => {
      if (login?.id !== id) return Promise.reject(new Error("no such sign-in"));
      const vendor = SAMPLE_SUBSCRIPTIONS.find((v) => v.provider === login?.provider);
      login = { ...login, prompt: undefined, progress: "正在换取令牌…" };
      emit({ topic: "login", data: structuredClone(login) });
      setTimeout(() => {
        if (vendor !== undefined) finishLogin(vendor);
      }, 800);
      return delay(structuredClone(login));
    },
    cancelLogin: (id) => {
      if (login?.id !== id) return Promise.reject(new Error("no such sign-in"));
      login = { ...login, status: "cancelled", prompt: undefined };
      emit({ topic: "login", data: structuredClone(login) });
      return delay(structuredClone(login));
    },
    probeModels: (target) => {
      const saved = models.services.find((x) => x.id === target.serviceId);
      const base = (target.baseUrl ?? saved?.baseUrl ?? "").replace(/\/+$/, "");
      if (base.includes("down")) {
        return delay({ ok: false, message: `GET ${base}/models: connect ECONNREFUSED` }, 600);
      }
      const ids = ["deepseek-v4-flash", "glm-5", "gpt-5.5", "kimi-k2.6", "qwen3-coder-plus"];
      return delay(
        {
          ok: true,
          models: ids.map((id) => ({ id, name: id })),
          ...(/\/v1$/.test(base) ? {} : { baseUrl: `${base}/v1` }),
        },
        700,
      );
    },
    setupFeishu: () => {
      for (const t of setupTimers) clearTimeout(t);
      setupTimers = [];
      setSetup({
        phase: "waiting-scan",
        qrDataUrl: PLACEHOLDER_QR,
        url: "https://open.feishu.cn/example",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      setupTimers.push(
        setTimeout(() => setSetup({ phase: "waiting-confirm" }), 5000),
        setTimeout(() => setSetup({ phase: "verifying" }), 8000),
        setTimeout(() => {
          status = {
            ...status,
            channel: { bound: true, appId: "cli_fake123", connected: true },
          };
          setSetup({ phase: "connected" });
          emit({ topic: "status", data: structuredClone(status) });
        }, 10000),
      );
      return delay(setup);
    },
    cancelSetup: () => {
      for (const t of setupTimers) clearTimeout(t);
      setupTimers = [];
      setup = { phase: "idle" };
      return delay(setup);
    },
    setupState: () => delay(setup),
    modelTiers: () => delay(tiersView()),
    setModelTiers: (tiers) => {
      placed = tiers;
      return delay(tiersView());
    },
    updateSettings: (patch) => {
      const { obsidianVault, ...rest } = patch;
      if (obsidianVault !== undefined) {
        // The preview has no file system: paths with "missing" in them do not exist.
        if (obsidianVault.includes("missing")) {
          return Promise.reject(new Error(`没有这个文件夹：${obsidianVault}`));
        }
        const { obsidianVault: _, ...kept } = status;
        status = obsidianVault === "" ? kept : { ...kept, obsidianVault };
      }
      const { pet: petPatch, ...others } = rest;
      status = { ...status, ...others, pet: { ...status.pet, ...petPatch } };
      emit({ topic: "status", data: structuredClone(status) });
      return delay(status);
    },
  };

  const fakeBridge: Bridge = {
    host: fake,
    // The pet window's own calls do nothing here, but pictures (ADR 0075) are drawn: a made-up
    // code for any png path, and nothing for a path with "missing" in it.
    pet: {
      dragStart: () => {},
      dragMove: () => {},
      dragEnd: async () => false,
      resize: () => {},
      interacting: () => {},
      onMouseLeave: () => () => {},
      openApp: () => {},
      openFile: (path) => console.info("[AgentHerd] open", path),
      readImage: async (path) => (path.includes("missing") ? undefined : fakePicture()),
      pathOf: (file) => `/Users/me/Desktop/${file.name}`,
      onArm: (listener) => {
        if (new URLSearchParams(location.search).get("arm") !== "1") return () => {};
        const timer = setTimeout(
          () =>
            listener({
              kind: "arm",
              approval: {
                target: "item-1",
                title: "运行 rm -rf ./logs/*",
                task: "清理旧日志",
                ref: "fake:m9",
              },
              until: Date.now() + 600_000,
              key: "⌘⇧Y",
            }),
          800,
        );
        return () => clearTimeout(timer);
      },
      disarm: () => {},
      peek: () => {},
      float: () => {},
    },
    shortcuts: {
      state: async () => ({ talk: "ok", approve: "ok" }),
      onState: () => () => {},
      pause: () => {},
    },
    // The browser cannot change prefers-color-scheme; the choice is only kept here.
    theme: {
      get: async () => devTheme,
      set: async (theme) => {
        devTheme = theme;
      },
    },
    onEvent: (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onConnection: (listener) => {
      connectionListeners.add(listener);
      setTimeout(() => listener(true), 0);
      if (sim === "offline") setTimeout(() => listener(false), 1000);
      return () => connectionListeners.delete(listener);
    },
  };
  window.agentherd = fakeBridge;
  console.info("[AgentHerd] window.agentherd not found; using the in-memory dev bridge.");
}

/** A made-up QR-like picture, for the pet's pictures in the dev bridge. */
function fakePicture(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 210;
  canvas.height = 210;
  const g = canvas.getContext("2d");
  if (g === null) return "";
  g.fillStyle = "#fff";
  g.fillRect(0, 0, 210, 210);
  g.fillStyle = "#111";
  let seed = 7;
  for (let y = 0; y < 21; y++) {
    for (let x = 0; x < 21; x++) {
      seed = (seed * 9301 + 49297) % 233280;
      const corner = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
      const ring = corner && (x % 14 === 0 || x % 14 === 6 || y % 14 === 0 || y % 14 === 6);
      const eye = corner && x % 14 >= 2 && x % 14 <= 4 && y % 14 >= 2 && y % 14 <= 4;
      if (corner ? ring || eye : seed / 233280 > 0.5) g.fillRect(x * 10, y * 10, 10, 10);
    }
  }
  return canvas.toDataURL("image/png");
}

let fakeInstalled = false;
if ((window as Partial<Window>).agentherd === undefined) {
  installFakeBridge();
  fakeInstalled = true;
}

/** The dialog named by `?open=`; only with the fake bridge, so never in the real app. */
export function devOpen(): string | null {
  return fakeInstalled ? new URLSearchParams(window.location.search).get("open") : null;
}
