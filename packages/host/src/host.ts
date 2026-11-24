// The AgentHerd host: owns the config, the Herd, the Herder and the channel, and answers the local
// API (./api.ts). `agentherd start` and the desktop app both run one host; only one per home.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, posix, win32 } from "node:path";
import {
  chooseModel,
  DIGEST_HOUR,
  emptyModelSettings,
  FEED_SOURCES,
  type GhRun,
  Herd,
  isSubscription,
  type JsonRpcMessage,
  MAILBOX_EVERY_DEFAULT,
  MAILBOX_EVERY_MIN,
  MAILBOX_KINDS,
  type Mailbox,
  type MailboxKind,
  type MemoryStore,
  type ModelRef,
  type ModelRole,
  type ModelService,
  type ModelSettings,
  modelFor,
  modelKeyAccount,
  profileField,
  putService,
  RESIDENT_CAPS,
  removeService,
  runGh,
  type SecretStore,
  UnknownTokenError,
} from "@agentherd/core";
import {
  actFrom,
  activityTurns,
  agentForModel,
  builtinProviders,
  fallbackOrder,
  herderFromSettings,
  LOGIN_FIELD,
  loginsFor,
  MemoryModelChain,
  MemoryWorker,
  memoryModels,
  modelChoices,
  modelLaunchFor,
  PI_MODEL_ENV,
  piModelEnv,
  placeModels,
  requestStream,
  resolveModel,
  serviceKey,
  serviceReady,
  sourceConfig,
  subscriptionProviders,
  TIERS,
  type TierPlacement,
  testModel,
} from "@agentherd/herder";
import type { AgentProfile, Channel, Locale, Mode, SetupUI } from "@agentherd/protocol";
import { DEFAULT_LOCALE } from "@agentherd/protocol";
import QRCode from "qrcode";
import { Agents } from "./agents.ts";
import { writeAntigravitySettings } from "./antigravity-home.ts";
import type {
  AgentCheck,
  AgentView,
  AppsView,
  DanjuanTest,
  DanjuanView,
  DingTalkView,
  FeedSource,
  FeedView,
  HerderActivityView,
  HerderContextSame,
  HerderContextView,
  HerderMessageView,
  HostApi,
  HostEvent,
  HostStatus,
  ItemSummary,
  LarkLogin,
  LarkView,
  Letter,
  LoginView,
  MailboxDraft,
  MailboxLetterView,
  MailboxSource,
  MailboxSourcePatch,
  MailboxSourceView,
  MailboxView,
  MemoryView,
  ModelProbe,
  ModelsView,
  ModelTest,
  ModelTiersView,
  OwnerProfile,
  PetFigure,
  PetOnTop,
  PetSettings,
  PetView,
  PluginCatalogEntry,
  PluginPatch,
  PluginPreview,
  PluginView,
  ProbeTarget,
  ProfileFieldName,
  ProviderView,
  SettingsPatch,
  SetupState,
  SocialKind,
  SocialLoginCode,
  SocialPlatform,
  SocialTest,
  SocialView,
  SubscriptionView,
  TasksView,
  Tier,
  TranscriptView,
  WatchView,
  WecomView,
  WestockTest,
  WestockView,
} from "./api.ts";
import {
  DEFAULT_HERDER_WINDOW,
  DEFAULT_PET,
  HERDER_WINDOWS,
  isPetShortcut,
  PET_FIGURES,
  PET_ON_TOP,
  PROFILE_FIELD_NAMES,
  PROFILE_VALUE_MAX,
  QUIET_HOURS,
} from "./api.ts";
import { Apps, newComposioUserId } from "./apps.ts";
import type { AgentDef, Fetchers } from "./catalog.ts";
import { withClaudeHome } from "./claude-home.ts";
import { withCodexHome } from "./codex-home.ts";
import { type CliConfig, readConfig, secretFile, writeConfig } from "./config.ts";
import { Danjuan, type DanjuanBrowser } from "./danjuan.ts";
import { hostDataPaths } from "./data-home-paths.ts";
import { DingTalkAccount } from "./dingtalk-account.ts";
import { type DingTalkCliPort, dingtalkCli } from "./dingtalk-cli.ts";
import { dingtalkCapabilities, dingtalkTools } from "./dingtalk-tools.ts";
import { LocalEmbedder } from "./embedder.ts";
import { FEED_NAMES, Feeds } from "./feeds.ts";
import { foldText, herderContextView, herderMessages } from "./herder-context-view.ts";
import { Lark } from "./lark.ts";
import { mailboxCheck, type ScriptRun } from "./mailbox-sources.ts";
import { mcpServerFor } from "./mcp-socket.ts";
import { LoginRun } from "./model-logins.ts";
import { PET_CARDS_MAX, PET_HISTORY_MAX, PetFeed, petConversation } from "./pet.ts";
import { droppedFiles } from "./pet-drop.ts";
import type { McpClient } from "./plugin-mcp.ts";
import { PluginStore, type RunningServer } from "./plugins.ts";
import { probeModels } from "./probe.ts";
import { availableProfiles } from "./profiles.ts";
import { withSystemProxy } from "./proxy.ts";
import { RuntimeStore } from "./runtimes.ts";
import { combineApps, Socials } from "./socials.ts";
import { type VerifyOptions, verifyProfile } from "./verify.ts";
import { deleteWatch, pauseWatch, watchViews } from "./watches.ts";
import { WecomAccount, type WecomCliPort } from "./wecom-account.ts";
import { WecomCli } from "./wecom-cli.ts";
import { Westock, type WestockRun } from "./westock.ts";

export const HOST_VERSION = "0.0.0";

/** Deleted memory entries the 记忆 page offers to restore. */
const MEMORY_DELETED_SHOWN = 20;

/**
 * An agent that could not start a task (Codex killed on this Mac) sits out new tasks this long, so
 * each new task does not try it again and post another 「换成 Pi」 card.
 */
export const AGENT_DOWN_MS = 30 * 60_000;

export interface HostOptions {
  home: string;
  protectedPaths?: readonly string[] | undefined;
  protectedLocationFiles?: readonly string[] | undefined;
  /** Run background memory jobs (task cases, reviews) with a cheap model. Off in tests. */
  memoryJobs?: boolean;
  userHome?: string;
  /** Model keys (and anything else under account names). */
  secrets: SecretStore;
  /** Builds the chat channel. The desktop app and the CLI pass the Feishu channel. */
  createChannel: (locale: Locale) => Channel;
  env?: Record<string, string>;
  /** Also offer the mock profile with this script. */
  script?: string;
  /** Profiles override (tests). Default: availableProfiles(). */
  profiles?: () => AgentProfile[];
  log?: (line: string) => void;
  /** The agents that ship with the app (ADR 0067), in RuntimeStore layout. */
  agentsDir?: string;
  /** Agent copies an older app downloaded. Default: <home>/runtimes. */
  runtimes?: RuntimeStore;
  /** Agent definitions (tests). Default: catalog.ts. */
  catalog?: AgentDef[];
  /** Release lookups for agents downloaded on request (tests). Default: catalog.ts. */
  fetchers?: Fetchers;
  /** HTTP for probeModels (tests). Default: global fetch. */
  fetch?: typeof fetch;
  /** Plugins (ADR 0094): how a downloaded .tar.gz is unpacked and how a server is reached; tests fake them. */
  pluginExtract?: (file: string, dir: string) => Promise<void>;
  pluginClient?: (server: RunningServer) => McpClient;
  /** WeCom auth and office commands (tests replace the CLI). */
  wecomCli?: WecomCliPort;
  /** DingTalk auth and office commands (tests replace the pinned CLI). */
  dingTalkCli?: DingTalkCliPort;
  /** Runs `gh` for following pull requests tasks open (tests replace it). */
  gh?: GhRun;
  /** Runs mailbox scripts; tests pass a fake (ADR 0099). */
  mailboxScript?: ScriptRun;
  /** How often the mailbox looks for due sources; tests make it short. */
  mailboxTickMs?: number;
  target?: string;
  exists?: (path: string) => boolean;
  /** Options for verifyAgent (tests). */
  verify?: VerifyOptions;
  /** The MCP socket agents reach the gateway on (mcp-socket.ts). Without it, agents get none. */
  mcpSocket?: string;
  /** Command runner for checking the `westock` CLI binary (tests). */
  westockRun?: WestockRun;
  /** Interactive/headless browser driver for 雪球基金 (tests). */
  danjuanBrowser?: DanjuanBrowser;
}

/** Turns 主管 › 行动记录 shows by default. */
const HERDER_ACTIVITY_TURNS = 200;
/** Herder audit rows looked at for incidents. */
const HERDER_INCIDENTS_MAX = 2000;
/** Herder audit kinds the turns already show. */
const HERDER_ROUTINE = new Set(["herder.turn", "herder.tool", "herder.answer"]);

/** The JSON-RPC method Pi's login extension calls (packages/pi-acp/extension/login.ts). */
const MODEL_AUTH_METHOD = "agentherd/modelAuth";
const PI_AUTH_SOCKET_ENV = "AGENTHERD_PI_AUTH_SOCKET";
const PI_AUTH_TOKEN_ENV = "AGENTHERD_PI_AUTH_TOKEN";

export class Host implements HostApi {
  private readonly opts: HostOptions;
  private readonly listeners = new Set<(event: HostEvent) => void>();
  private herd: Herd | undefined;
  /** The 上下文 tab as last built, by its key (ADR 0095). */
  private contextView: HerderContextView | undefined;
  /** Background memory jobs of the running herd (ADR 0038). */
  private memoryWorker: MemoryWorker | undefined;
  /** Local vector model for memory search, made once and kept across herd restarts. */
  private embedder: LocalEmbedder | undefined;
  private connected = false;
  private channelError: string | undefined;
  private herderReason: string | undefined;
  private herderRef: string | undefined;
  /** The running or last subscription sign-in (ADR 0068). */
  private loginRun: LoginRun | undefined;
  /** Socket tokens Pi uses to ask for a subscription token, by the service they may ask for. */
  private readonly modelGrants = new Map<string, string>();
  private readonly modelChecks = new Map<
    string,
    { result: { ok: true } | { ok: false; message: string }; until: number }
  >();
  private setup: SetupState = { phase: "idle" };
  private setupRun = 0;
  private profileList: AgentProfile[] = [];
  /** Agents sitting out new tasks after failing to start one, until this time. */
  private readonly agentDownUntil = new Map<string, number>();
  private stopped = false;

  private readonly agentList: Agents;
  private readonly appList: Apps;
  /** 小红书 and 知乎 (ADR 0058). */
  private readonly socialList: Socials;
  /** 飞书 through lark-cli, and the news sources (ADR 0059). */
  private readonly larkCli: Lark;
  private readonly feedList: Feeds;
  /** 腾讯自选股 live quotes + official westock CLI (ADR 0076). */
  private readonly westockCli: Westock;
  /** 雪球基金 (Danjuan Funds) local browser session & holdings (ADR 0077). */
  private readonly danjuanCli: Danjuan;
  /** What the desktop pet sees of the chat (ADR 0070). */
  private readonly petFeed: PetFeed;
  /** Installed plugins (ADR 0094). */
  private readonly pluginList: PluginStore;
  private readonly wecomApps: WecomAccount;
  private readonly dingTalkAccount: DingTalkAccount | undefined;
  /** The Herder's guess at the owner's next message, and when it came (ADR 0084). */
  private petSuggestion: { text: string; at: string } | undefined;

  constructor(opts: HostOptions) {
    this.opts = opts;
    this.agentList = new Agents({
      ...(opts.agentsDir === undefined ? {} : { bundled: new RuntimeStore(opts.agentsDir) }),
      downloaded:
        opts.runtimes ?? new RuntimeStore(join(opts.home, hostDataPaths.runtimes.relative)),
      ...(opts.env === undefined ? {} : { env: { ...process.env, ...opts.env } }),
      ...(opts.catalog === undefined ? {} : { catalog: opts.catalog }),
      ...(opts.exists === undefined ? {} : { exists: opts.exists }),
      ...(opts.fetchers === undefined ? {} : { fetchers: opts.fetchers }),
      ...(opts.target === undefined ? {} : { target: opts.target }),
      ...(opts.userHome === undefined ? {} : { userHome: opts.userHome }),
      onChange: () => this.agentsChanged(),
      log: (line) => this.log(line),
    });
    this.appList = new Apps({
      secrets: opts.secrets,
      userId: () => this.composioUserId(),
      emit: (data) => this.emit({ topic: "apps", data }),
      log: (line) => this.log(line),
    });
    this.petFeed = new PetFeed({
      changed: () => this.emit({ topic: "pet", data: this.pet() }),
      echo: (text) =>
        (this.config().locale ?? DEFAULT_LOCALE) === "en"
          ? `(said to the desktop pet) ${text}`
          : `（在桌宠里说）${text}`,
      keep: (ref, view) =>
        this.herd?.store.putOwnerCard(ref, view, view.kind === "report" ? view.taskId : undefined),
    });
    this.socialList = new Socials({
      home: opts.home,
      changed: () => this.socialsChanged(),
      log: (line) => this.log(line),
      watch: (platform) => this.socialWatch(platform),
    });
    this.larkCli = new Lark({
      changed: () => this.emit({ topic: "lark", data: this.larkCli.current() }),
      log: (line) => this.log(line),
      qr: (url) => QRCode.toDataURL(url, { width: 320, margin: 1 }),
      app: async () => {
        const data = this.config().channel?.data;
        if (data?.appId === undefined) return undefined;
        const secret = secretFile(this.opts.home).get(`feishu:${data.appId}`);
        if (secret === undefined) return undefined;
        return { appId: data.appId, secret, brand: data.brand ?? "feishu" };
      },
    });
    this.feedList = new Feeds({ home: opts.home, off: () => this.config().feedsOff ?? [] });
    this.pluginList = new PluginStore({
      home: opts.home,
      secrets: opts.secrets,
      config: () => this.config(),
      save: (change) => writeConfig(this.opts.home, change(this.config())),
      changed: () => this.emit({ topic: "plugins", data: this.plugins() }),
      env: () => this.toolEnv(),
      ...(opts.fetch === undefined ? {} : { fetchFn: opts.fetch }),
      ...(opts.pluginExtract === undefined ? {} : { extract: opts.pluginExtract }),
      ...(opts.pluginClient === undefined ? {} : { client: opts.pluginClient }),
      log: (line) => this.log(line),
    });
    this.wecomApps = new WecomAccount(
      opts.wecomCli ?? new WecomCli(join(opts.home, hostDataPaths.wecomCli.relative)),
    );
    const dws = opts.env?.AGENTHERD_DWS ?? process.env.AGENTHERD_DWS;
    const cli =
      opts.dingTalkCli ??
      (dws !== undefined && isAbsolute(dws) && existsSync(dws)
        ? dingtalkCli({
            executable: dws,
            stateDir: join(opts.home, hostDataPaths.dingTalkDws.relative),
          })
        : undefined);
    this.dingTalkAccount = cli === undefined ? undefined : new DingTalkAccount(cli);
    this.westockCli = new Westock({
      home: opts.home,
      enabled: () => !(this.config().westockOff ?? false),
      ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
      ...(opts.westockRun === undefined ? {} : { run: opts.westockRun }),
      ...(opts.exists === undefined ? {} : { exists: opts.exists }),
      ...(opts.target === undefined ? {} : { target: opts.target }),
      ...(opts.env === undefined ? {} : { env: opts.env }),
      changed: () => {
        this.emit({ topic: "westock", data: this.westockCli.current() });
        if (this.herd !== undefined) {
          this.profileList = this.buildProfiles();
          this.herd.setProfiles(this.herdProfiles());
        }
      },
      log: (line) => this.log(line),
    });
    this.danjuanCli = new Danjuan({
      home: opts.home,
      settings: () => this.config().danjuan ?? {},
      save: (patch) => {
        const cur = this.config();
        writeConfig(this.opts.home, {
          ...cur,
          danjuan: { ...cur.danjuan, ...patch },
        });
      },
      changed: () => this.emit({ topic: "danjuan", data: this.danjuanCli.current() }),
      ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
      ...(opts.danjuanBrowser === undefined ? {} : { browser: opts.danjuanBrowser }),
      log: (line) => this.log(line),
    });
  }

  lark(): Promise<LarkView> {
    return this.larkCli.check();
  }

  connectLark(): Promise<LarkLogin> {
    return this.larkCli.connect();
  }

  async testLark(): Promise<{ ok: boolean; message: string; lark: LarkView }> {
    const found = await this.larkCli.test();
    return { ...found, lark: this.larkCli.current() };
  }

  logoutLark(): Promise<LarkView> {
    return this.larkCli.logout().then(() => this.larkCli.current());
  }

  feeds(): FeedView[] {
    return FEED_SOURCES.map((source) => ({
      source,
      name: FEED_NAMES[source],
      on: this.feedList.on(source),
    }));
  }

  setFeed(source: FeedSource, on: boolean): FeedView[] {
    if (!FEED_SOURCES.includes(source)) throw new Error(`no news source ${source}`);
    const off = new Set(this.config().feedsOff ?? []);
    if (on) off.delete(source);
    else off.add(source);
    writeConfig(this.opts.home, { ...this.config(), feedsOff: [...off] });
    return this.feeds();
  }

  westock(): Promise<WestockView> {
    return this.westockCli.check();
  }

  setWestockEnabled(on: boolean): Promise<WestockView> {
    writeConfig(this.opts.home, { ...this.config(), westockOff: !on });
    return Promise.resolve(this.westockCli.syncEnabled());
  }

  installWestock(): Promise<WestockView> {
    return this.westockCli.install();
  }

  removeWestock(): Promise<WestockView> {
    return this.westockCli.remove();
  }

  testWestock(query?: string): Promise<WestockTest> {
    return this.westockCli.test(query);
  }

  danjuan(): Promise<DanjuanView> {
    return this.danjuanCli.check();
  }

  connectDanjuan(accepted: boolean): Promise<DanjuanView> {
    return this.danjuanCli.connect(accepted);
  }

  cancelDanjuanLogin(): Promise<DanjuanView> {
    return this.danjuanCli.cancelLogin();
  }

  testDanjuan(): Promise<DanjuanTest> {
    return this.danjuanCli.test();
  }

  logoutDanjuan(): Promise<DanjuanView> {
    return this.danjuanCli.logout();
  }

  /** What every new task is told about this Mac's tools (ADR 0059). */
  private toolNotes(): string[] {
    const notes: string[] = [];
    const lark = this.larkCli.note();
    if (lark !== undefined) notes.push(lark);
    const westock = this.westockCli.note();
    if (westock !== undefined) notes.push(westock);
    const danjuan = this.danjuanCli.note();
    if (danjuan !== undefined) notes.push(danjuan);
    const plugins = this.pluginList.note();
    if (plugins !== undefined) notes.push(plugins);
    const vault = this.config().obsidianVault;
    if (vault !== undefined && vault !== "") {
      notes.push(
        `Obsidian: the owner's vault is ${vault} (Markdown files; keep its folders, front matter and [[links]] style). Write notes there only when the owner asks for a note.`,
      );
    }
    return notes;
  }

  private socialsChanged(): void {
    // A platform that just signed in is looked at now, not at its next turn (ADR 0100).
    const box = this.herd?.mailbox;
    for (const s of box?.list() ?? []) {
      if (s.kind === "social" && !s.paused && !s.started) {
        void box?.runNow(s.id).catch(() => {});
      }
    }
    this.emit({ topic: "socials", data: this.socials() });
  }

  /** What reaches the Herder from a platform: mentions while its social source looks (ADR 0100). */
  private socialWatch(platform: SocialPlatform): Record<SocialKind, boolean> | undefined {
    const box = this.herd?.mailbox;
    if (box === undefined) return undefined;
    const on = box.list().some((s) => this.isSocialSource(s, platform) && !s.paused);
    return { mentions: on, likes: false, follows: false };
  }

  private isSocialSource(s: MailboxSource, platform: SocialPlatform): boolean {
    return s.kind === "social" && s.config.platform === platform;
  }

  /** Turns a platform's comments and @ on or off: its social source in the mailbox (ADR 0100). */
  private setSocialMentions(platform: SocialPlatform, on: boolean, addMissing: boolean): void {
    const box = this.herd?.mailbox;
    if (box === undefined) return;
    const found = box.list().filter((s) => this.isSocialSource(s, platform));
    if (found.length === 0) {
      if (!on || !addMissing) return;
      const name = this.socialList.views().find((v) => v.platform === platform)?.name ?? platform;
      box.add({
        kind: "social",
        name: `${name}的评论和@`,
        note: "有人评论或 @ 我就告诉我",
        config: { platform },
        by: "owner",
      });
    } else {
      for (const s of found) if (s.paused === on) box.set(s.id, { paused: !on });
    }
    this.emit({ topic: "mailbox", data: this.mailbox() });
  }

  // ---- Plugins (ADR 0094) ----

  pluginCatalog(): Promise<PluginCatalogEntry[]> {
    return this.pluginList.catalog();
  }

  plugins(): PluginView[] {
    return this.pluginList.views();
  }

  previewPlugin(source: string): Promise<PluginPreview> {
    return this.pluginList.preview(source);
  }

  installPlugin(source: string, keys: Record<string, string> = {}): Promise<PluginView[]> {
    return this.pluginList.install(source, keys);
  }

  setPlugin(id: string, patch: PluginPatch): Promise<PluginView[]> {
    return this.pluginList.set(id, patch);
  }

  removePlugin(id: string): Promise<PluginView[]> {
    return this.pluginList.remove(id);
  }

  async wecom(): Promise<WecomView> {
    return this.wecomApps.view();
  }

  startWecomLogin(): Promise<WecomView> {
    return this.wecomApps.startLogin();
  }

  cancelWecomLogin(): Promise<WecomView> {
    return this.wecomApps.cancelLogin();
  }

  disconnectWecom(): Promise<WecomView> {
    return this.wecomApps.disconnect();
  }

  private async dingTalkView(view?: Promise<DingTalkView>): Promise<DingTalkView> {
    const state = await view;
    if (state === undefined) return { state: "unavailable", capabilities: [] };
    return state.state === "connected" ? { ...state, capabilities: dingtalkCapabilities() } : state;
  }

  dingtalk(): Promise<DingTalkView> {
    return this.dingTalkView(this.dingTalkAccount?.view());
  }

  startDingTalkLogin(): Promise<DingTalkView> {
    return this.dingTalkView(this.dingTalkAccount?.startLogin());
  }

  cancelDingTalkLogin(): Promise<DingTalkView> {
    return this.dingTalkView(this.dingTalkAccount?.cancelLogin());
  }

  disconnectDingTalk(): Promise<DingTalkView> {
    return this.dingTalkView(this.dingTalkAccount?.disconnect());
  }

  mailbox(): MailboxView {
    return mailboxView(this.herd?.mailbox);
  }

  async mailboxAdd(draft: MailboxDraft): Promise<MailboxView> {
    const act = actFrom(draft.kind, draft.act, undefined);
    this.needMailbox().add({
      kind: draft.kind,
      name: draft.name,
      note: draft.note ?? "",
      config: sourceConfig(draft.kind, draft),
      by: "owner",
      ...(draft.everyMinutes === undefined || draft.kind === "timer"
        ? {}
        : { everyMinutes: draft.everyMinutes }),
      ...(act === undefined ? {} : { act }),
    });
    return this.mailbox();
  }

  async mailboxSet(id: string, patch: MailboxSourcePatch): Promise<MailboxView> {
    const box = this.needMailbox();
    const source = box.list().find((s) => s.id === id);
    if (source === undefined) throw new Error(`no source ${id}`);
    const act =
      patch.act === undefined && patch.trial === undefined
        ? undefined
        : actFrom(source.kind, patch.act, patch.trial, source.act);
    box.set(id, {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.note === undefined ? {} : { note: patch.note }),
      ...(patch.everyMinutes === undefined ? {} : { everyMinutes: patch.everyMinutes }),
      ...(patch.paused === undefined ? {} : { paused: patch.paused }),
      ...(patch.fields === undefined ? {} : { config: sourceConfig(source.kind, patch.fields) }),
      ...(act === undefined ? {} : { act }),
    });
    return this.mailbox();
  }

  async mailboxRemove(id: string): Promise<MailboxView> {
    this.needMailbox().remove(id);
    return this.mailbox();
  }

  async mailboxRun(id: string): Promise<MailboxView> {
    await this.needMailbox().runNow(id);
    return this.mailbox();
  }

  mailboxTry(draft: MailboxDraft): Promise<Letter[]> {
    return this.needMailbox().tryOut({
      kind: draft.kind,
      name: draft.name,
      note: draft.note ?? "",
      config: sourceConfig(draft.kind, draft),
    });
  }

  private needMailbox(): Mailbox {
    const box = this.herd?.mailbox;
    if (box === undefined) throw new Error("AgentHerd is not running yet");
    return box;
  }

  socials(): SocialView[] {
    return this.socialList.views();
  }

  async enableSocial(platform: SocialPlatform, accepted: boolean): Promise<SocialView[]> {
    await this.socialList.enable(platform, accepted);
    // Comments and @ are told by default (ADR 0058), now as a mailbox source (ADR 0100).
    this.setSocialMentions(platform, true, true);
    return this.socials();
  }

  async disableSocial(platform: SocialPlatform): Promise<SocialView[]> {
    this.socialList.disable(platform);
    return this.socials();
  }

  socialLoginCode(platform: SocialPlatform): Promise<SocialLoginCode> {
    return this.socialList.loginCode(platform);
  }

  async socialLogout(platform: SocialPlatform): Promise<SocialView[]> {
    await this.socialList.logout(platform);
    return this.socials();
  }

  async testSocial(platform: SocialPlatform): Promise<SocialTest> {
    const found = await this.socialList.test(platform);
    return { ...found, socials: this.socials() };
  }

  setSocialWatch(platform: SocialPlatform, kind: SocialKind, on: boolean): SocialView[] {
    if (this.herd?.mailbox === undefined) {
      throw new Error("AgentHerd is not running; connect Feishu first");
    }
    if (kind !== "mentions") throw new Error("only comments and @ are told");
    this.setSocialMentions(platform, on, true);
    return this.socials();
  }

  watches(): WatchView[] {
    const herd = this.herd;
    if (herd === undefined) return [];
    return watchViews(herd);
  }

  setWatchPaused(id: string, paused: boolean): WatchView[] {
    const herd = this.herd;
    if (herd === undefined) throw new Error("AgentHerd is not running; connect Feishu first");
    pauseWatch(herd, id, paused);
    return this.watches();
  }

  removeWatch(id: string): WatchView[] {
    const herd = this.herd;
    if (herd === undefined) throw new Error("AgentHerd is not running; connect Feishu first");
    deleteWatch(herd, id);
    return this.watches();
  }

  /** This AgentHerd's Composio user id, made the first time it is needed. */
  private composioUserId(): string {
    const config = this.config();
    const known = config.apps?.composioUserId;
    if (known !== undefined) return known;
    const id = newComposioUserId();
    writeConfig(this.opts.home, { ...config, apps: { ...config.apps, composioUserId: id } });
    return id;
  }

  apps(search?: string): Promise<AppsView> {
    return this.appList.view(search);
  }

  setComposioKey(key: string): Promise<AppsView> {
    return this.appList.setKey(key);
  }

  connectApp(slug: string): Promise<{ url: string }> {
    return this.appList.connect(slug);
  }

  disconnectApp(slug: string): Promise<AppsView> {
    return this.appList.disconnect(slug);
  }

  onEvent(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: HostEvent): void {
    for (const l of this.listeners) l(event);
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }

  private config(): CliConfig {
    return readConfig(this.opts.home);
  }

  private settings(): ModelSettings {
    return this.config().models ?? emptyModelSettings();
  }

  private saveSettings(models: ModelSettings): void {
    writeConfig(this.opts.home, { ...this.config(), models });
  }

  /** Starts following tasks if a channel is bound. */
  async start(): Promise<void> {
    void this.appList.load();
    if (this.opts.mcpSocket !== undefined) void this.wecomApps.restore();
    this.socialList.start();
    void this.westockCli.check();
    if (this.danjuanCli.enabled()) void this.danjuanCli.check();
    await this.restartHerd();
  }

  /** One message from an agent's `agentherd` MCP server, for the running herd. */
  mcp(token: string, msg: JsonRpcMessage): Promise<JsonRpcMessage | undefined> {
    const granted = this.modelGrants.get(token);
    if (granted !== undefined) return this.modelAuth(granted, msg);
    if (this.herd === undefined) throw new UnknownTokenError();
    return this.herd.mcp(token, msg);
  }

  /**
   * A short-lived token for Pi's next request to a subscription model (ADR 0068). The grant
   * names one service; Pi never gets the refresh token.
   */
  private async modelAuth(
    serviceId: string,
    msg: JsonRpcMessage,
  ): Promise<JsonRpcMessage | undefined> {
    if (msg.method === "notifications/hello") return undefined;
    const id = msg.id ?? null;
    const params = (msg.params ?? {}) as { service?: unknown };
    if (msg.method !== MODEL_AUTH_METHOD || params.service !== serviceId) {
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "not allowed" } };
    }
    const service = this.settings().services.find((s) => s.id === serviceId);
    if (service === undefined) {
      return { jsonrpc: "2.0", id, error: { code: -32000, message: `no service "${serviceId}"` } };
    }
    try {
      const auth = await loginsFor(this.opts.secrets).auth(service);
      return { jsonrpc: "2.0", id, result: auth };
    } catch (error) {
      return { jsonrpc: "2.0", id, error: { code: -32000, message: (error as Error).message } };
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.agentList.stop();
    this.socialList.stop();
    this.westockCli.stop();
    this.danjuanCli.stop();
    this.pluginList.stopAll();
    this.wecomApps.close();
    this.setupRun++;
    await this.dingTalkAccount?.stop();
    await this.stopHerd();
  }

  private async stopHerd(): Promise<void> {
    const herd = this.herd;
    this.herd = undefined;
    this.connected = false;
    const worker = this.memoryWorker;
    this.memoryWorker = undefined;
    await worker?.stop();
    if (herd !== undefined) await herd.stop();
  }

  async reconnect(): Promise<HostStatus> {
    await this.restartHerd();
    return this.status();
  }

  private async restartHerd(): Promise<void> {
    await this.stopHerd();
    const config = this.config();
    this.profileList = this.buildProfiles(config);
    this.refreshHerderChoice();
    if (config.channel === undefined || this.stopped) {
      this.emitStatus();
      return;
    }
    const locale = config.locale ?? DEFAULT_LOCALE;
    const herder = this.herderFactory();
    const herd = new Herd({
      home: this.opts.home,
      userHome: this.opts.userHome ?? homedir(),
      protectedPaths: this.opts.protectedPaths,
      protectedLocationFiles: this.opts.protectedLocationFiles,
      channel: this.petFeed.wrap(this.opts.createChannel(locale)),
      binding: config.channel,
      mode: config.mode ?? "assist",
      locale,
      profiles: this.herdProfiles(),
      github: { run: this.opts.gh ?? runGh(withSystemProxy()) },
      socials: () => this.socialList.sources(),
      feeds: {
        on: () => FEED_SOURCES.filter((f) => this.feedList.on(f)),
        read: (source, query, mark) => this.feedList.read(source, query, mark),
      },
      westock: {
        state: () => ({
          enabled: this.westockCli.current().enabled,
          cliReady: this.westockCli.cliReady(),
        }),
        quote: (query) => this.westockCli.quote(query),
      },
      danjuan: {
        state: () => ({
          enabled: this.danjuanCli.enabled(),
          ready: this.danjuanCli.ready(),
          state: this.danjuanCli.current().state,
        }),
        holdings: (query) => this.danjuanCli.holdings(query),
      },
      toolNotes: () => this.toolNotes(),
      herderTurnAdded: () => {
        // Anything said makes the last guess stale (ADR 0084).
        this.petSuggestion = undefined;
        this.emit({ topic: "pet", data: this.pet() });
      },
      suggestion: {
        on: () => {
          const pet = petSettings(this.config());
          return pet.on && pet.suggest;
        },
        show: (text) => {
          this.petSuggestion = { text, at: new Date().toISOString() };
          this.emit({ topic: "pet", data: this.pet() });
        },
      },
      mailbox: {
        check: mailboxCheck({
          gh: this.opts.gh ?? runGh(withSystemProxy()),
          home: this.opts.userHome ?? homedir(),
          env: () => this.toolEnv(),
          apps: () => this.appList.appTools(),
          socials: () => this.socialList.sources(),
          ...(this.opts.fetch === undefined ? {} : { fetchFn: this.opts.fetch }),
          ...(this.opts.mailboxScript === undefined ? {} : { script: this.opts.mailboxScript }),
        }),
        ...(this.opts.mailboxTickMs === undefined ? {} : { tickMs: this.opts.mailboxTickMs }),
      },
      mailboxChanged: () => this.emit({ topic: "mailbox", data: this.mailbox() }),
      plugins: {
        list: () => this.pluginList.herderList(),
        call: (name, args) => this.pluginList.herderCall(name, args),
        skill: (name) => this.pluginList.skillText(name),
      },
      ...(herder === undefined ? {} : { herder }),
      ...(this.opts.mcpSocket === undefined
        ? {}
        : {
            mcpServer: (token: string) => mcpServerFor(this.opts.mcpSocket as string, token),
            apps: () =>
              combineApps([
                this.socialList.tools(this.appList.appTools()),
                this.feedList.tools(),
                this.westockCli.tools(),
                this.danjuanCli.tools(),
                this.pluginList.tools(),
                this.wecomApps.apps(),
                this.dingTalkAccount === undefined
                  ? undefined
                  : dingtalkTools(this.dingTalkAccount),
              ]),
            appNames: () => [...this.appList.connectedNames(), ...this.wecomApps.connectedNames()],
          }),
      agentModels: {
        list: () =>
          modelChoices(
            this.settings(),
            this.profileList.map((p) => p.id),
          ),
        launchFor: (profileId, ref) => {
          const launch = modelLaunchFor(
            this.settings(),
            this.opts.secrets,
            profileId,
            ref,
            this.opts.env,
          );
          const withPath = this.withToolPath(launch.env);
          if (profileId === "codex") return { env: withCodexHome(this.opts.home, withPath) };
          if (profileId === "claude") return { env: withClaudeHome(this.opts.home, withPath) };
          return { env: this.withModelGrant(withPath) };
        },
        check: (ref) => this.checkModel(ref),
        next: (profileId, failed, tried) => this.nextModel(profileId, failed, tried),
      },
      ...(this.opts.memoryJobs === true
        ? {
            embedder: this.memoryEmbedder(),
            memoryComplete: (system: string, user: string, signal: AbortSignal) =>
              this.memoryComplete(system, user, signal),
          }
        : {}),
    });
    herd.registry.onChange(() => this.emitTasks());
    try {
      await herd.start();
      this.herd = herd;
      this.writeWaitingProfile();
      this.startMemoryWorker(herd);
      this.connected = true;
      this.channelError = undefined;
      this.log(
        `[herd] connected; agents: ${this.profileList.map((p) => p.id).join(", ") || "none"}`,
      );
    } catch (error) {
      this.channelError = (error as Error).message;
      this.log(`[herd] could not connect: ${this.channelError}`);
      await herd.stop().catch(() => {});
    }
    this.emitStatus();
    this.emitTasks();
    this.socialsChanged();
  }

  private memoryEmbedder(): LocalEmbedder {
    if (this.embedder === undefined) {
      this.embedder = new LocalEmbedder(this.opts.home, (line) => this.log(line));
      this.embedder.warm();
    }
    return this.embedder;
  }

  /** Memory jobs try the cheap models in turn, then the Herder's (ADR 0090). */
  private readonly memoryChain = new MemoryModelChain(
    () => memoryModels(this.settings(), this.opts.secrets, this.placement(), this.opts.env),
    (line) => this.log(line),
  );

  private memoryComplete(system: string, user: string, signal: AbortSignal): Promise<string> {
    return this.memoryChain.complete(system, user, signal);
  }

  private startMemoryWorker(herd: Herd): void {
    if (this.opts.memoryJobs !== true) return;
    const worker = new MemoryWorker({
      memory: herd.store.memory,
      transcript: (taskId) => herd.store.transcript(taskId),
      herderTurnsAfter: (afterId, limit) => herd.store.herderTurnsAfter(afterId, limit),
      complete: (system, user, signal) => this.memoryComplete(system, user, signal),
      embedder: this.memoryEmbedder(),
      log: (line) => this.log(line),
    });
    worker.start();
    this.memoryWorker = worker;
  }

  /** Antigravity runs with settings that ask before acting (ADR 0104); a failure is logged. */
  private antigravitySettings(): void {
    try {
      writeAntigravitySettings(this.opts.userHome ?? homedir());
    } catch (error) {
      console.error(
        `[agents] could not write Antigravity's settings: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private buildProfiles(config: CliConfig = this.config()): AgentProfile[] {
    if (this.opts.profiles !== undefined) return this.opts.profiles();
    const pi = piModelEnv(this.settings(), this.opts.secrets, this.opts.env);
    const profiles = availableProfiles({
      script: this.opts.script,
      configured: config.profiles ?? [],
      find: (id) => this.agentList.find(id)?.path,
      agentEnv: (id) => this.agentList.extraEnv(id),
      ...("env" in pi ? { piModelEnv: pi.env } : {}),
    });
    // Pi keeps its sessions here so an old task can be continued after a restart (ADR 0039).
    const sessionDir = join(this.opts.home, hostDataPaths.piSessions.relative);
    return profiles.map((p) => {
      if (p.id === "antigravity") this.antigravitySettings();
      const base =
        p.id === "pi" ? { ...p, env: { ...p.env, AGENTHERD_PI_SESSION_DIR: sessionDir } } : p;
      return { ...base, env: this.withToolPath(base.env) };
    });
  }

  /** Installed agents minus the ones sitting out after a failed start. */
  private herdProfiles(): AgentProfile[] {
    const now = Date.now();
    return this.profileList.filter((p) => (this.agentDownUntil.get(p.id) ?? 0) <= now);
  }

  private agentDown(id: string): void {
    this.agentDownUntil.set(id, Date.now() + AGENT_DOWN_MS);
    this.log(
      `[agents] ${id} could not start a task; new tasks skip it for ${AGENT_DOWN_MS / 60_000} min`,
    );
    this.herd?.setProfiles(this.herdProfiles());
    setTimeout(() => this.herd?.setProfiles(this.herdProfiles()), AGENT_DOWN_MS + 1000).unref();
  }

  private agentsChanged(): void {
    const before = this.profileList.map((p) => p.id).join(",");
    this.profileList = this.buildProfiles();
    this.herd?.setProfiles(this.herdProfiles());
    this.emit({ topic: "agents", data: this.agents() });
    if (this.profileList.map((p) => p.id).join(",") !== before) this.emitStatus();
  }

  agents(): AgentView[] {
    const pi = piModelEnv(this.settings(), this.opts.secrets, this.opts.env);
    return this.agentList.views(this.config().profiles ?? [], "ref" in pi ? { pi: pi.ref } : {});
  }

  installAgent(id: string): AgentView[] {
    this.agentList.install(id);
    return this.agents();
  }

  cancelInstall(id: string): AgentView[] {
    this.agentList.cancel(id);
    return this.agents();
  }

  /** Waits for agent downloads (tests). */
  agentsIdle(): Promise<void> {
    return this.agentList.idle();
  }

  removeAgent(id: string): AgentView[] {
    this.agentList.remove(id);
    return this.agents();
  }

  async verifyAgent(id: string): Promise<AgentCheck> {
    const profile = this.profileList.find((p) => p.id === id);
    if (profile === undefined) {
      return { id, ok: false, needsLogin: false, authMethods: [], error: "not installed", ms: 0 };
    }
    const check = await verifyProfile(profile, this.opts.verify ?? {});
    this.log(`[agents] check ${id}: ${check.ok ? "ok" : check.error}`);
    return check;
  }

  private herderFactory() {
    const gh = this.opts.gh ?? runGh(withSystemProxy());
    const choice = herderFromSettings(
      this.settings(),
      this.opts.secrets,
      this.opts.env,
      () => this.placement(),
      // The owner's own GitHub sign-in, when there is one, lifts GitHub's limit (ADR 0071).
      { githubToken: () => gh(["auth", "token"]) },
      () => this.herderWindow(),
    );
    return "factory" in choice ? choice.factory : undefined;
  }

  private refreshHerderChoice(): void {
    const choice = herderFromSettings(this.settings(), this.opts.secrets, this.opts.env, () =>
      this.placement(),
    );
    if ("reason" in choice) {
      this.herderReason = choice.reason;
      this.herderRef = undefined;
    } else {
      this.herderReason = undefined;
      this.herderRef = choice.ref;
    }
  }

  /** After a model change: rebuild the Herder in place; running tasks keep going. */
  private async applyModels(): Promise<void> {
    const before = this.herderRef;
    this.refreshHerderChoice();
    if (this.herd !== undefined && before !== this.herderRef) {
      await this.herd.setHerder(this.herderFactory());
    }
    this.profileList = this.buildProfiles();
    this.herd?.setProfiles(this.herdProfiles());
    this.log(`[herder] ${this.herderRef ?? `off: ${this.herderReason}`}`);
    this.emit({ topic: "models", data: this.models() });
    this.emit({ topic: "agents", data: this.agents() });
    this.emitStatus();
  }

  private emitStatus(): void {
    this.emit({ topic: "status", data: this.status() });
  }

  private emitTasks(): void {
    this.emit({ topic: "tasks", data: this.tasks() });
  }

  status(): HostStatus {
    const config = this.config();
    return {
      version: HOST_VERSION,
      home: this.opts.home,
      channel: {
        bound: config.channel !== undefined,
        ...(config.channel?.data.appId === undefined ? {} : { appId: config.channel.data.appId }),
        connected: this.connected,
        ...(this.channelError === undefined ? {} : { error: this.channelError }),
      },
      herder: {
        on: this.herderRef !== undefined,
        ...(this.herderRef === undefined ? {} : { ref: this.herderRef }),
        ...(this.herderReason === undefined ? {} : { reason: this.herderReason }),
      },
      mode: this.herd?.getMode() ?? config.mode ?? "assist",
      locale: config.locale ?? DEFAULT_LOCALE,
      keepAwake: config.keepAwake ?? false,
      ...(config.obsidianVault ? { obsidianVault: config.obsidianVault } : {}),
      profiles: this.profileList.map((p) => p.id),
      pet: petSettings(config),
      herderWindow: this.herderWindow(),
    };
  }

  /** The Herder's working window the owner picked (ADR 0097); 0 is the model's whole window. */
  private herderWindow(): number {
    const w = this.config().herderWindow;
    return (HERDER_WINDOWS as readonly number[]).includes(w ?? -1)
      ? (w as number)
      : DEFAULT_HERDER_WINDOW;
  }

  /** The Herder's model's own context window, 0 when unknown. */
  private herderModelWindow(): number {
    const choice = modelFor(this.settings(), "herder");
    if (choice === undefined) return 0;
    try {
      return resolveModel(choice.service, choice.model).contextWindow ?? 0;
    } catch {
      return 0;
    }
  }

  pet(): PetView {
    const last = this.petFeed.last;
    const conversation = this.petConversation();
    const guess = this.petSuggestion;
    // A card that came after it waits for the owner: answering it comes first.
    const suggestion =
      guess === undefined || conversation.cards.some((c) => c.open && c.at > guess.at)
        ? undefined
        : guess.text;
    return {
      connected: this.petFeed.connected,
      ...(last === undefined ? {} : { last }),
      pending: this.petFeed.pending(),
      ...conversation,
      ...(suggestion === undefined ? {} : { suggestion }),
    };
  }

  /**
   * The Herder's conversation and the cards sent to the owner, as herd.db keeps them: they reach
   * back past restarts (ADR 0072).
   */
  private petConversation(): Pick<PetView, "history" | "cards"> {
    const store = this.herd?.store;
    if (store === undefined) return { history: [], cards: [] };
    return petConversation(
      store.herderTurns(PET_HISTORY_MAX),
      store.ownerCards(PET_CARDS_MAX),
      (id) => store.task(id)?.task.title,
      (ref) => this.petFeed.isOpen(ref),
    );
  }

  async petSay(text: string, paths: string[] = []): Promise<PetView> {
    const locale = this.config().locale ?? DEFAULT_LOCALE;
    await this.petFeed.say(text, droppedFiles(paths, locale));
    return this.pet();
  }

  async petPress(target: string, action: string): Promise<PetView> {
    await this.petFeed.press(target, action);
    return this.pet();
  }

  async stopTask(taskId: string): Promise<void> {
    const herd = this.herd;
    if (herd === undefined) throw new Error("AgentHerd is not running");
    await herd.stopTask(taskId);
  }

  tasks(): TasksView {
    const herd = this.herd;
    if (herd === undefined) return { tasks: [], items: [] };
    const tasks = herd.tasks();
    const titles = new Map(tasks.map((t) => [t.id, t.title]));
    const items: ItemSummary[] = herd.store.openItems().map((i) => {
      const taskTitle = titles.get(i.sessionId);
      return {
        id: i.id,
        sessionId: i.sessionId,
        title: i.title,
        body: i.body,
        risk: i.risk,
        createdAt: i.createdAt,
        cwd: i.cwd,
        profileId: i.profileId,
        ...(taskTitle === undefined ? {} : { taskTitle }),
      };
    });
    return { tasks, items };
  }

  transcript(taskId: string): TranscriptView {
    return this.herd?.transcript(taskId) ?? { entries: [], live: "" };
  }

  herderActivity(limit = HERDER_ACTIVITY_TURNS): HerderActivityView {
    const store = this.herd?.store;
    if (store === undefined) return { turns: [], incidents: [], total: 0 };
    const all = activityTurns(store.herderLog());
    const turns = all.slice(-Math.max(1, limit)).reverse();
    // Incidents since the oldest turn shown; tool calls are already in the turns.
    const since = turns.at(-1)?.at ?? "";
    const incidents = store
      .auditRowsLike("herder.", HERDER_INCIDENTS_MAX)
      .filter((r) => !HERDER_ROUTINE.has(r.kind) && r.at >= since)
      .reverse()
      .map((r) => ({ at: r.at, kind: r.kind, data: r.data }));
    return { turns, incidents, total: all.length };
  }

  herderContext(known?: string): HerderContextView | HerderContextSame {
    const store = this.herd?.store;
    if (store === undefined) throw new Error("AgentHerd is not running yet");
    const on = this.herd?.herderPort() !== undefined;
    const windows = { model: this.herderModelWindow(), choice: this.herderWindow() };
    const key = `${on ? 1 : 0}|${windows.model}|${windows.choice}|${store.herder.version()}`;
    if (known === key) return { key, unchanged: true };
    if (this.contextView?.key !== key) {
      this.contextView = herderContextView(store, on, key, windows);
    }
    return this.contextView;
  }

  herderMessages(from: number, to: number): HerderMessageView[] {
    const store = this.herd?.store;
    if (store === undefined) throw new Error("AgentHerd is not running yet");
    return herderMessages(store, from, to);
  }

  herderContextFold(blockId: string): string {
    const store = this.herd?.store;
    if (store === undefined) throw new Error("AgentHerd is not running yet");
    return foldText(store, blockId);
  }

  memories(): MemoryView {
    const memory = this.herd?.store.memory;
    if (memory === undefined) {
      return {
        entries: [],
        deleted: [],
        used: { profile: 0, owner: 0, decision: 0, note: 0 },
        caps: { ...RESIDENT_CAPS },
        ready: false,
      };
    }
    return {
      entries: memory.list(),
      deleted: memory.list({ status: "deleted" }).slice(0, MEMORY_DELETED_SHOWN),
      used: {
        profile: memory.used("profile"),
        owner: memory.used("owner"),
        decision: memory.used("decision"),
        note: memory.used("note"),
      },
      caps: { ...RESIDENT_CAPS },
      ready: true,
    };
  }

  editMemory(id: string, text: string): MemoryView {
    const memory = this.ownMemory();
    const abstract = text.trim();
    if (abstract === "") throw new Error("the text is empty");
    memory.write([{ op: "replace", id, abstract }], { actor: "owner", source: "owner_edit" });
    return this.memories();
  }

  forgetMemory(id: string): MemoryView {
    const memory = this.ownMemory();
    memory.setStatus(id, "deleted");
    memory.log("owner.forgot", memory.get(id)?.abstract ?? "", id);
    return this.memories();
  }

  restoreMemory(id: string): MemoryView {
    const memory = this.ownMemory();
    memory.setStatus(id, "active");
    memory.log("owner.restored", memory.get(id)?.abstract ?? "", id);
    return this.memories();
  }

  ownerProfile(): OwnerProfile {
    const out: OwnerProfile = {};
    for (const r of this.herd?.store.memory.list({ kinds: ["profile"] }) ?? []) {
      const field = profileField(r.abstract);
      if (field !== undefined) out[field] = profileValue(r.abstract);
    }
    for (const [field, value] of Object.entries(this.config().profileWaiting ?? {})) {
      if (!isProfileField(field) || value === undefined) continue;
      if (value === "") delete out[field];
      else out[field] = value;
    }
    return out;
  }

  setProfile(field: ProfileFieldName, value: string): OwnerProfile {
    if (!isProfileField(field)) {
      throw new Error(`field must be one of ${PROFILE_FIELD_NAMES.join(", ")}`);
    }
    const text = value.replace(/\s+/g, " ").trim();
    if (text.length > PROFILE_VALUE_MAX) {
      throw new Error(`${field} must be at most ${PROFILE_VALUE_MAX} characters`);
    }
    const memory = this.herd?.store.memory;
    if (memory === undefined) {
      const config = this.config();
      writeConfig(this.opts.home, {
        ...config,
        profileWaiting: { ...config.profileWaiting, [field]: text },
      });
      return this.ownerProfile();
    }
    writeProfileField(memory, field, text);
    return this.ownerProfile();
  }

  /** Writes the profile fields set while AgentHerd was not running (ADR 0091). */
  private writeWaitingProfile(): void {
    const memory = this.herd?.store.memory;
    const config = this.config();
    const waiting = config.profileWaiting;
    if (memory === undefined || waiting === undefined) return;
    try {
      for (const [field, value] of Object.entries(waiting)) {
        if (isProfileField(field) && value !== undefined) writeProfileField(memory, field, value);
      }
      const { profileWaiting: _written, ...rest } = config;
      writeConfig(this.opts.home, rest);
    } catch (error) {
      this.log(`[memory] could not write the profile: ${(error as Error).message}`);
    }
  }

  private ownMemory() {
    const memory = this.herd?.store.memory;
    if (memory === undefined) throw new Error("AgentHerd is not running; connect Feishu first");
    return memory;
  }

  providers(): ProviderView[] {
    return builtinProviders();
  }

  /** The environment tools run in: ours, with `<home>/bin` on the path. */
  private toolEnv(): Record<string, string> {
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.opts.env ?? process.env)) {
      if (v !== undefined) base[k] = v;
    }
    return this.withToolPath(base);
  }

  /** Prepends `<home>/bin` (`westock`, etc.) to `PATH` when present without duplicating `Path`/`PATH` (ADR 0076). */
  private withToolPath(env: Record<string, string>): Record<string, string> {
    const dir = this.westockCli.binDir();
    if (dir === undefined) return env;
    const plat = this.opts.target?.startsWith("win32-") ? "win32" : process.platform;
    const sep = plat === "win32" ? win32.delimiter : posix.delimiter;
    const base = this.opts.env ?? process.env;
    const pathKey =
      Object.keys(env).find((k) => k.toUpperCase() === "PATH") ??
      Object.keys(base).find((k) => k.toUpperCase() === "PATH") ??
      "PATH";
    const current = env[pathKey] ?? base[pathKey] ?? "";
    const parts = current.split(sep).filter((p) => p !== "");
    if (parts.includes(dir)) return env;
    return { ...env, [pathKey]: current === "" ? dir : `${dir}${sep}${current}` };
  }

  /** Pi with a subscription model gets a socket and a token to ask for its tokens on. */
  private withModelGrant(env: Record<string, string>): Record<string, string> {
    const raw = env[PI_MODEL_ENV];
    if (raw === undefined || this.opts.mcpSocket === undefined) return env;
    let service: unknown;
    try {
      service = (JSON.parse(raw) as Record<string, unknown>)[LOGIN_FIELD];
    } catch {
      return env;
    }
    if (typeof service !== "string") return env;
    const token = randomBytes(24).toString("hex");
    this.modelGrants.set(token, service);
    return { ...env, [PI_AUTH_SOCKET_ENV]: this.opts.mcpSocket, [PI_AUTH_TOKEN_ENV]: token };
  }

  models(): ModelsView {
    const settings = this.settings();
    return {
      services: settings.services.map((s) => ({
        ...s,
        hasKey: serviceReady(s, this.opts.secrets, this.opts.env),
      })),
      roles: settings.roles,
    };
  }

  async putService(service: ModelService, key?: string): Promise<ModelsView> {
    const next = putService(this.settings(), cleanService(service));
    if (typeof key === "string") this.writeKey(service.id, key);
    this.saveSettings(next);
    await this.applyModels();
    return this.models();
  }

  async removeService(serviceId: string): Promise<ModelsView> {
    this.saveSettings(removeService(this.settings(), serviceId));
    this.opts.secrets.delete(modelKeyAccount(serviceId));
    loginsFor(this.opts.secrets).logout(serviceId);
    await this.applyModels();
    return this.models();
  }

  async setKey(serviceId: string, key: string): Promise<ModelsView> {
    if (!this.settings().services.some((s) => s.id === serviceId)) {
      throw new Error(`no service "${serviceId}"`);
    }
    this.writeKey(serviceId, key);
    // Same model, new key: the Herder must be rebuilt to use it.
    this.herderRef = undefined;
    await this.applyModels();
    return this.models();
  }

  async chooseModel(role: ModelRole, ref: ModelRef | null): Promise<ModelsView> {
    this.saveSettings(chooseModel(this.settings(), role, ref ?? undefined));
    await this.applyModels();
    return this.models();
  }

  async testModel(ref: ModelRef): Promise<ModelTest> {
    const service = this.settings().services.find((s) => s.id === ref.serviceId);
    if (service === undefined) return { ok: false, message: `no service "${ref.serviceId}"` };
    try {
      if (!serviceReady(service, this.opts.secrets, this.opts.env) && isSubscription(service)) {
        return { ok: false, message: `service "${service.id}" is not signed in` };
      }
      return await testModel(
        resolveModel(service, ref.model),
        serviceKey(service, this.opts.secrets, this.opts.env),
        undefined,
        requestStream(this.opts.secrets, () => this.settings().services),
      );
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  subscriptions(): SubscriptionView[] {
    return subscriptionProviders();
  }

  startLogin(provider: string, serviceId: string, name?: string): LoginView {
    const vendor = subscriptionProviders().find((p) => p.provider === provider);
    if (vendor === undefined) throw new Error(`cannot sign in to "${provider}"`);
    const id = serviceId.trim();
    if (id === "") throw new Error("service id is empty");
    const other = this.settings().services.find((s) => s.id === id);
    if (other !== undefined && (!isSubscription(other) || other.provider !== provider)) {
      throw new Error(`service "${id}" already exists`);
    }
    this.loginRun?.cancel();
    const run = new LoginRun({
      serviceId: id,
      provider,
      run: (interaction) => loginsFor(this.opts.secrets).login(id, provider, interaction),
      done: async (models) => {
        const keep = other?.models.filter((m) => models.includes(m)) ?? [];
        await this.putService({
          id,
          name: name?.trim() || other?.name || vendor.name,
          kind: "builtin",
          provider,
          auth: "subscription",
          models: keep.length > 0 ? keep : models,
        });
        // Same service, new account: the Herder must ask with the new sign-in.
        this.herderRef = undefined;
        await this.applyModels();
      },
      changed: (data) => this.emit({ topic: "login", data }),
    });
    this.loginRun = run;
    run.start();
    return run.view();
  }

  answerLogin(id: string, value: string): LoginView {
    const run = this.currentLogin(id);
    run.answer(value);
    return run.view();
  }

  cancelLogin(id: string): LoginView {
    const run = this.currentLogin(id);
    run.cancel();
    return run.view();
  }

  private currentLogin(id: string): LoginRun {
    if (this.loginRun?.id !== id) throw new Error("no such sign-in");
    return this.loginRun;
  }

  async probeModels(target: ProbeTarget): Promise<ModelProbe> {
    let saved: ModelService | undefined;
    if (target.serviceId !== undefined) {
      saved = this.settings().services.find((s) => s.id === target.serviceId);
      if (saved === undefined) return { ok: false, message: `no service "${target.serviceId}"` };
      if (saved.kind !== "openai-compatible") {
        return { ok: false, message: `service "${saved.id}" has a built-in model list` };
      }
    }
    const baseUrl = target.baseUrl ?? saved?.baseUrl;
    if (baseUrl === undefined || baseUrl.trim() === "") return { ok: false, message: "no address" };
    const typed = target.key?.trim();
    const key =
      typed !== undefined && typed !== ""
        ? typed
        : saved === undefined
          ? undefined
          : serviceKey(saved, this.opts.secrets, this.opts.env);
    const api = target.api ?? saved?.api;
    return probeModels({
      baseUrl,
      ...(api === undefined ? {} : { api }),
      ...(key === undefined ? {} : { key }),
      ...(this.opts.fetch === undefined ? {} : { fetch: this.opts.fetch }),
    });
  }

  private writeKey(serviceId: string, key: string): void {
    const account = modelKeyAccount(serviceId);
    if (key.trim() === "") this.opts.secrets.delete(account);
    else this.opts.secrets.set(account, key.trim());
  }

  setupState(): SetupState {
    return this.setup;
  }

  setupFeishu(): SetupState {
    const run = ++this.setupRun;
    this.setSetup({ phase: "starting" });
    const config = this.config();
    const channel = this.opts.createChannel(config.locale ?? DEFAULT_LOCALE);
    const ui: SetupUI = {
      showQrCode: (url, expiresInSeconds) => {
        void QRCode.toDataURL(url, { width: 320, margin: 1 }).then((qrDataUrl) => {
          if (run !== this.setupRun) return;
          this.setSetup({
            phase: "waiting-scan",
            qrDataUrl,
            url,
            expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
          });
        });
      },
      showStatus: (status) => {
        if (run !== this.setupRun) return;
        if (status === "waiting-confirm" || status === "verifying") {
          this.setSetup({ ...this.setup, phase: status });
        }
      },
    };
    void channel
      .setup(ui)
      .then(async (binding) => {
        if (run !== this.setupRun) return;
        writeConfig(this.opts.home, { ...this.config(), channel: binding });
        this.log(`[setup] bound to ${binding.data.appId ?? binding.channelId}`);
        this.setSetup({ phase: "connected" });
        await this.restartHerd();
      })
      .catch((error: Error) => {
        if (run !== this.setupRun) return;
        this.setSetup({ phase: "failed", error: error.message });
      });
    return this.setup;
  }

  cancelSetup(): SetupState {
    this.setupRun++;
    this.setSetup({ phase: "idle" });
    return this.setup;
  }

  private setSetup(state: SetupState): void {
    this.setup = state;
    this.emit({ topic: "setup", data: state });
  }

  updateSettings(patch: SettingsPatch): HostStatus {
    const config = this.config();
    const next: CliConfig = { ...config };
    if (patch.mode !== undefined) {
      if (patch.mode !== "observe" && patch.mode !== "assist") {
        throw new Error(`mode must be observe or assist, not "${patch.mode}"`);
      }
      next.mode = patch.mode as Mode;
      this.herd?.setMode(patch.mode);
    }
    if (patch.keepAwake !== undefined) next.keepAwake = patch.keepAwake;
    if (patch.herderWindow !== undefined) {
      if (!(HERDER_WINDOWS as readonly number[]).includes(patch.herderWindow)) {
        throw new Error(`herderWindow must be one of ${HERDER_WINDOWS.join(", ")}`);
      }
      next.herderWindow = patch.herderWindow;
    }
    if (patch.pet !== undefined) {
      const pet: PetSettings = { ...petSettings(config), ...patch.pet };
      for (const key of ["on", "notify", "sound", "overFullscreen", "suggest"] as const) {
        if (typeof pet[key] !== "boolean") throw new Error(`pet.${key} must be true or false`);
      }
      if (!PET_FIGURES.includes(pet.figure)) {
        throw new Error(`pet.figure must be one of ${PET_FIGURES.join(", ")}`);
      }
      if (
        typeof pet.quietHours !== "string" ||
        !(pet.quietHours === "" || QUIET_HOURS.test(pet.quietHours))
      ) {
        throw new Error('pet.quietHours must be "HH:MM-HH:MM" or ""');
      }
      if (
        typeof pet.quietUntil !== "string" ||
        !(pet.quietUntil === "" || !Number.isNaN(Date.parse(pet.quietUntil)))
      ) {
        throw new Error('pet.quietUntil must be a time or ""');
      }
      for (const key of ["talkKey", "approveKey"] as const) {
        const value = pet[key];
        if (typeof value !== "string" || !(value === "" || isPetShortcut(value))) {
          throw new Error(`pet.${key} must be a shortcut like CommandOrControl+Shift+Y, or ""`);
        }
      }
      if (pet.talkKey !== "" && pet.talkKey === pet.approveKey) {
        throw new Error("pet.talkKey and pet.approveKey must be different shortcuts");
      }
      if (!PET_ON_TOP.includes(pet.onTop)) {
        throw new Error(`pet.onTop must be one of ${PET_ON_TOP.join(", ")}`);
      }
      next.pet = pet;
    }
    if (patch.obsidianVault !== undefined) {
      const vault = patch.obsidianVault.trim().replace(/^~(?=[/\\]|$)/, homedir());
      if (vault === "") delete next.obsidianVault;
      else if (!existsSync(vault)) throw new Error(`没有这个文件夹：${vault}`);
      else next.obsidianVault = vault;
    }
    writeConfig(this.opts.home, next);
    this.emitStatus();
    return this.status();
  }

  private placement(): TierPlacement {
    const services = this.settings().services;
    const names = [...new Set(services.flatMap((s) => s.models))];
    const saved = this.config().modelTiers;
    // Plan 018 saved `service/model` refs; read those as the model name.
    const ids = new Set(services.map((s) => s.id));
    const asName = (entry: string) => {
      if (names.includes(entry)) return entry;
      const slash = entry.indexOf("/");
      return slash > 0 && ids.has(entry.slice(0, slash)) ? entry.slice(slash + 1) : entry;
    };
    const normalized =
      saved === undefined
        ? undefined
        : Object.fromEntries(TIERS.map((t) => [t, (saved[t] ?? []).map(asName)]));
    return placeModels(names, normalized);
  }

  modelTiers(): ModelTiersView {
    const services = this.settings().services;
    const placement = this.placement();
    const tiers = {} as ModelTiersView["tiers"];
    for (const tier of TIERS) {
      tiers[tier] = placement[tier].map(({ model, auto }) => ({
        model,
        services: services.filter((s) => s.models.includes(model)).map((s) => s.name),
        auto,
      }));
    }
    return { tiers, custom: this.config().modelTiers !== undefined };
  }

  /**
   * After `failed` broke a task before it acted: Codex and Claude Code hand the same model to Pi
   * (ADR 0031, 0069);
   * otherwise the next model in fallback order that answers (ADR 0030), in the agent that model
   * gets.
   */
  private async nextModel(
    profileId: string,
    failed: string,
    tried: readonly string[],
  ): Promise<{ profileId: string; model: string } | undefined> {
    const ids = this.profileList.map((p) => p.id);
    if ((profileId === "codex" || profileId === "claude") && ids.includes("pi")) {
      this.agentDown(profileId);
      return { profileId: "pi", model: failed };
    }
    this.modelChecks.set(failed, {
      result: { ok: false, message: "failed in a task" },
      until: Date.now() + 120_000,
    });
    const choices = modelChoices(this.settings(), ids);
    const auto = profileId === "pi" || profileId === "codex" || profileId === "claude";
    for (const ref of fallbackOrder(
      choices,
      failed,
      auto ? undefined : profileId,
      this.placement(),
    )) {
      if (tried.includes(ref)) continue;
      if ((await this.checkModel(ref)).ok) {
        const runners = choices.find((c) => c.ref === ref)?.agents;
        return {
          profileId: auto ? agentForModel(ref, ids, profileId === "claude", runners) : profileId,
          model: ref,
        };
      }
    }
    return undefined;
  }

  /** Test calls by ref: a working model is trusted for 10 minutes, a failing one for 2. */
  private async checkModel(ref: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const now = Date.now();
    const cached = this.modelChecks.get(ref);
    if (cached !== undefined && cached.until > now) return cached.result;
    const slash = ref.indexOf("/");
    const r = await this.testModel({ serviceId: ref.slice(0, slash), model: ref.slice(slash + 1) });
    const result = r.ok ? ({ ok: true } as const) : { ok: false as const, message: r.message };
    this.modelChecks.set(ref, { result, until: now + (r.ok ? 600_000 : 120_000) });
    return result;
  }

  setModelTiers(tiers: Record<Tier, string[]> | null): ModelTiersView {
    const next: CliConfig = { ...this.config() };
    if (tiers === null) delete next.modelTiers;
    else {
      const clean: Record<Tier, string[]> = { strong: [], balanced: [], fast: [] };
      for (const tier of TIERS) {
        const list = tiers[tier];
        if (!Array.isArray(list)) throw new Error(`tier "${tier}" must be a list of models`);
        clean[tier] = list.filter((r): r is string => typeof r === "string");
      }
      next.modelTiers = clean;
    }
    writeConfig(this.opts.home, next);
    return this.modelTiers();
  }
}

function cleanService(s: ModelService): ModelService {
  const base: ModelService = {
    id: s.id.trim(),
    name: s.name.trim(),
    kind: s.kind,
    models: s.models.map((m) => m.trim()).filter((m) => m !== ""),
  };
  if (s.kind === "builtin" && s.provider !== undefined) base.provider = s.provider;
  if (s.kind === "builtin" && s.auth === "subscription") base.auth = "subscription";
  if (s.kind === "openai-compatible" && s.baseUrl !== undefined) base.baseUrl = s.baseUrl.trim();
  if (s.kind === "openai-compatible" && s.api === "anthropic-messages") base.api = s.api;
  return base;
}

/** The pet settings with defaults filled in; an unknown figure falls back to the default. */
function isProfileField(field: string): field is ProfileFieldName {
  return (PROFILE_FIELD_NAMES as readonly string[]).includes(field);
}

/** 「称呼：火哥」 → 「火哥」. */
function profileValue(abstract: string): string {
  return abstract.slice(abstract.search(/[：:]/) + 1).trim();
}

/** Sets or clears one field of the owner's profile card as the owner's own edit (ADR 0091). */
function writeProfileField(memory: MemoryStore, field: ProfileFieldName, value: string): void {
  const meta = { actor: "owner", source: "owner_edit" } as const;
  if (value === "") {
    const old = memory.list({ kinds: ["profile"] }).find((r) => profileField(r.abstract) === field);
    if (old !== undefined) memory.write([{ op: "remove", id: old.id }], meta);
    return;
  }
  memory.write([{ op: "add", kind: "profile", abstract: `${field}：${value}` }], meta);
}

function petSettings(config: CliConfig): PetSettings {
  const saved = config.pet ?? {};
  const figure: PetFigure = PET_FIGURES.includes(saved.figure as PetFigure)
    ? (saved.figure as PetFigure)
    : DEFAULT_PET.figure;
  const flag = (key: "on" | "notify" | "sound" | "overFullscreen" | "suggest") =>
    typeof saved[key] === "boolean" ? (saved[key] as boolean) : DEFAULT_PET[key];
  const quietHours =
    typeof saved.quietHours === "string" && QUIET_HOURS.test(saved.quietHours)
      ? saved.quietHours
      : DEFAULT_PET.quietHours;
  const quietUntil =
    typeof saved.quietUntil === "string" && !Number.isNaN(Date.parse(saved.quietUntil))
      ? saved.quietUntil
      : DEFAULT_PET.quietUntil;
  const key = (name: "talkKey" | "approveKey") => {
    const value = saved[name];
    return typeof value === "string" && (value === "" || isPetShortcut(value))
      ? value
      : DEFAULT_PET[name];
  };
  return {
    on: flag("on"),
    figure,
    notify: flag("notify"),
    sound: flag("sound"),
    quietHours,
    quietUntil,
    talkKey: key("talkKey"),
    approveKey: key("approveKey"),
    onTop: PET_ON_TOP.includes(saved.onTop as PetOnTop)
      ? (saved.onTop as PetOnTop)
      : DEFAULT_PET.onTop,
    overFullscreen: flag("overFullscreen"),
    suggest: flag("suggest"),
  };
}

/** Letters shown on the 信箱 page. */
export const MAILBOX_LETTERS_SHOWN = 300;

/** The 信箱 page: sources and the newest letters, each with its source's name (ADR 0099). */
export function mailboxView(box: Mailbox | undefined): MailboxView {
  const every = Object.fromEntries(
    MAILBOX_KINDS.map((k) => [k, { min: MAILBOX_EVERY_MIN[k], default: MAILBOX_EVERY_DEFAULT[k] }]),
  ) as Record<MailboxKind, { min: number; default: number }>;
  if (box === undefined)
    return { on: false, sources: [], letters: [], every, digestHour: DIGEST_HOUR };
  const sources: MailboxSourceView[] = box.list().map((s) => {
    const nextAt = s.kind === "timer" ? box.nextAt(s) : undefined;
    return nextAt === undefined ? s : { ...s, nextAt };
  });
  const byId = new Map(sources.map((s) => [s.id, s]));
  const letters: MailboxLetterView[] = [];
  for (const l of box.letters(MAILBOX_LETTERS_SHOWN)) {
    const s = byId.get(l.sourceId);
    if (s === undefined) continue;
    letters.push({ ...l, source: s.name, kind: s.kind });
  }
  return { on: true, sources, letters, every, digestHour: DIGEST_HOUR };
}
