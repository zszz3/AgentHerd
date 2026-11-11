// The local API of the AgentHerd host (docs/spec/02-architecture.md §4). The desktop app and the
// CLI use it; agents do not. Items are read-only here: the owner decides in the channel.
// These types have no runtime imports, so the renderer can import them too.

import type {
  CustomApi,
  MemoryRow,
  ModelRef,
  ModelRole,
  ModelService,
  ModelSettings,
  Schedule,
  Task,
  TranscriptEntry,
} from "@agentherd/core";
import type { HerderStyle, Locale, Mode, Risk } from "@agentherd/protocol";

export const API_VERSION = 1;

export interface ChannelStatus {
  bound: boolean;
  appId?: string;
  /** Connected to the chat app and following tasks. */
  connected: boolean;
  error?: string;
}

export interface HerderStatus {
  on: boolean;
  /** "service/model" when on. */
  ref?: string;
  /** Why it is off. */
  reason?: string;
}

export interface HostStatus {
  version: string;
  home: string;
  channel: ChannelStatus;
  herder: HerderStatus;
  mode: Mode;
  locale: Locale;
  keepAwake: boolean;
  /** How the Herder talks to the owner (ADR 0053). */
  herderStyle: HerderStyle;
  /** Agent profile ids the owner can start with /run. */
  profiles: string[];
}

/** Where an agent's CLI comes from. */
export type AgentSource = "managed" | "system" | "app" | "config";

export interface AgentView {
  id: string;
  name: string;
  /** ready: can run tasks. missing: not found and can be downloaded or needs its app. */
  state: "ready" | "missing" | "installing" | "unsupported";
  source?: AgentSource;
  path?: string;
  /** Version the app downloads. */
  version?: string;
  /** Bytes, while installing. */
  progress?: { received: number; total: number };
  /** Last install error. */
  error?: string;
  /** The app can download it. */
  canInstall: boolean;
  /** A downloaded copy the owner can remove. */
  canRemove: boolean;
  /** Model passed to it ("service/model"), when it uses one from the model list. */
  modelRef?: string;
}

/** Result of starting an agent once to check it works (the 验证 button). */
export interface AgentCheck {
  id: string;
  ok: boolean;
  /** It started but wants the owner to sign in first (ACP authMethods, or an auth error). */
  needsLogin: boolean;
  /** Name and version the agent reported. */
  agentName?: string;
  agentVersion?: string;
  /** Sign-in methods it offers. */
  authMethods: string[];
  /** Why it failed, from the error and the last stderr lines. */
  error?: string;
  ms: number;
}

export interface ItemSummary {
  id: string;
  sessionId: string;
  title: string;
  body: string;
  risk: Risk;
  createdAt: string;
  cwd: string;
  profileId: string;
  taskTitle?: string;
}

export interface TasksView {
  tasks: Task[];
  /** Open items, waiting for the owner in the channel. */
  items: ItemSummary[];
}

/** What was said in one task; the app polls it while the task is open. */
export interface TranscriptView {
  entries: TranscriptEntry[];
  /** Reply text the agent is still writing. */
  live: string;
}

/** The Herder's long-term memory for the 记忆 page (ADR 0038). */
export interface MemoryView {
  /** Active entries, newest first, and the last deleted ones (to restore). */
  entries: MemoryRow[];
  deleted: MemoryRow[];
  /** Characters used and allowed of the kinds kept in the Herder's prompt. */
  used: { owner: number; decision: number; note: number };
  caps: { owner: number; decision: number; note: number };
  /** False while AgentHerd is not following tasks (no herd): nothing to show or change. */
  ready: boolean;
}

export interface ServiceView extends ModelService {
  hasKey: boolean;
}

export interface ModelsView {
  services: ServiceView[];
  roles: ModelSettings["roles"];
}

export interface ProviderView {
  provider: string;
  models: { id: string; name: string }[];
}

export type SetupPhase =
  | "idle"
  | "starting"
  | "waiting-scan"
  | "waiting-confirm"
  | "verifying"
  | "connected"
  | "failed";

export interface SetupState {
  phase: SetupPhase;
  /** The QR code as a data: URL, while waiting for the scan. */
  qrDataUrl?: string;
  url?: string;
  expiresAt?: string;
  error?: string;
}

export type ModelTest = { ok: true; reply: string } | { ok: false; message: string };

/** What to ask for a model list: a saved service, or the fields of one not saved yet. */
export interface ProbeTarget {
  /** A saved service: its address, API and key are the defaults for the fields below. */
  serviceId?: string;
  baseUrl?: string;
  api?: CustomApi;
  /** Empty or missing: the saved key of `serviceId`, if any. */
  key?: string;
}

/**
 * The models a service lists. `baseUrl` is set when the list was found under a different
 * address than the one given (a missing `/v1`), so the form can fix the address.
 */
export type ModelProbe =
  | { ok: true; models: { id: string; name: string }[]; baseUrl?: string }
  | { ok: false; message: string };

export interface SettingsPatch {
  mode?: Mode;
  keepAwake?: boolean;
  herderStyle?: HerderStyle;
}

/** Everything the host offers. Each method is one request on the socket. */
export type Tier = "strong" | "balanced" | "fast";

/** One model in the tier board; a model several services offer is one entry. */
export interface TierModelView {
  model: string;
  /** Names of the services offering it, in the order AgentHerd tries them. */
  services: string[];
  /** True when placed by AgentHerd's name rules, not by the owner. */
  auto: boolean;
}

/** The owner's models in three tiers (ADR 0028). */
export interface ModelTiersView {
  tiers: Record<Tier, TierModelView[]>;
  /** True when the owner has placed any model. */
  custom: boolean;
}

/** One app in 设置 → 应用连接 (docs/spec/09-agent-tools.md §3). */
export interface AppView {
  slug: string;
  name: string;
  logo?: string;
  connected: boolean;
  /** Waiting for the owner to finish signing in. */
  connecting: boolean;
}

/** The owner's apps through their own Composio key. The key itself never leaves the host. */
export interface AppsView {
  hasKey: boolean;
  /** Something the owner should know (bad key, failed sign-in), in Chinese. */
  problem?: string;
  /** Connected apps first. */
  apps: AppView[];
}

/** What the Herder does at set times, for the 定时任务 page (ADR 0055). */
export interface SchedulesView {
  schedules: Schedule[];
  /** False while AgentHerd is not following tasks (no herd): nothing to show or change. */
  ready: boolean;
}

/** Chinese platforms AgentHerd can use with the owner's own account (ADR 0058). */
export type SocialPlatform = "xiaohongshu" | "zhihu";

/** What a platform watch can tell the owner about. */
export type SocialKind = "mentions" | "likes" | "follows";

/** What 测试连接 found. */
export interface SocialTest {
  ok: boolean;
  message: string;
  socials: SocialView[];
}

/**
 * One platform in 应用连接 (ADR 0058). Turning it on needs the owner to accept the account-risk
 * notice once; signing in is a QR code scanned with the platform's phone app.
 */
export interface SocialView {
  platform: SocialPlatform;
  /** 小红书 / 知乎 */
  name: string;
  /** False while AgentHerd cannot connect it yet (知乎, ADR 0058). */
  available: boolean;
  /** The owner accepted the account-risk notice once; connecting again does not show it. */
  accepted: boolean;
  /** The owner accepted the notice and turned the platform on. */
  enabled: boolean;
  /**
   * off: not turned on. starting: AgentHerd is getting its helper ready. signed-out: needs a scan.
   * ready: signed in, agents and watches can use it. failed: see `problem`.
   */
  state: "off" | "starting" | "signed-out" | "ready" | "failed";
  /** The signed-in account's name, when known. */
  account?: string;
  /** Something the owner should know, in Chinese. */
  problem?: string;
  /** What the watch tells the owner about (ADR 0058 defaults: mentions on, the rest off). */
  watch: Record<SocialKind, boolean>;
  /** The last look for new notices (ISO). */
  checkedAt?: string;
}

/** A QR code to scan with the platform's app. */
export interface SocialLoginCode {
  /** data:image/png;base64,… */
  image: string;
  /** True when the account turned out to be signed in already (no code). */
  signedIn: boolean;
}

/** One thing AgentHerd watches, for the 应用连接 page (ADR 0058). */
export interface WatchView {
  /** `pr:<repo>#<n>`, `mail:<id>`, `intake:<id>`, `social:<platform>:<kind>`. */
  id: string;
  kind: "pr" | "mail" | "intake" | "social";
  /** What it watches, in the owner's words where there are some. */
  title: string;
  /** One line: how, how often. */
  detail: string;
  paused: boolean;
  /** Social watches are switched, not removed. */
  removable: boolean;
  createdAt?: string;
  /** Last news from it (ISO). */
  activeAt?: string;
}

export interface HostApi {
  status(): HostStatus;
  tasks(): TasksView;
  /** The conversation of one task: prompts, replies and tool calls. */
  transcript(taskId: string): TranscriptView;
  memories(): MemoryView;
  /** Changes an entry's text; the old text stays in its history. */
  editMemory(id: string, text: string): MemoryView;
  forgetMemory(id: string): MemoryView;
  restoreMemory(id: string): MemoryView;
  /** Schedules are made in chat; the app shows them and can pause or remove one. */
  schedules(): SchedulesView;
  setSchedulePaused(id: string, paused: boolean): SchedulesView;
  removeSchedule(id: string): SchedulesView;
  providers(): ProviderView[];
  models(): ModelsView;
  /** Adds or replaces a service. `key`: undefined keeps the saved key, "" removes it. */
  putService(service: ModelService, key?: string): Promise<ModelsView>;
  removeService(serviceId: string): Promise<ModelsView>;
  setKey(serviceId: string, key: string): Promise<ModelsView>;
  chooseModel(role: ModelRole, ref: ModelRef | null): Promise<ModelsView>;
  testModel(ref: ModelRef): Promise<ModelTest>;
  /** Asks an OpenAI- or Anthropic-compatible service which models it offers (GET /models). */
  probeModels(target: ProbeTarget): Promise<ModelProbe>;
  /** Starts the one-scan Feishu setup; progress comes as "setup" events. */
  setupFeishu(): SetupState;
  cancelSetup(): SetupState;
  setupState(): SetupState;
  updateSettings(patch: SettingsPatch): HostStatus;
  /** The owner's models in tiers; the Herder reads them to pick a task's model (ADR 0028). */
  modelTiers(): ModelTiersView;
  /** Saves where the owner put each model (by name); null forgets it and uses the name rules. */
  setModelTiers(tiers: Record<Tier, string[]> | null): ModelTiersView;
  /** Connects the channel again, e.g. after a network failure. */
  reconnect(): Promise<HostStatus>;
  agents(): AgentView[];
  /** Starts downloading an agent's CLI; progress comes as "agents" events. */
  installAgent(id: string): AgentView[];
  cancelInstall(id: string): AgentView[];
  /** Removes a downloaded CLI. */
  removeAgent(id: string): AgentView[];
  /** Starts the agent in an empty folder, opens a session and closes it. */
  verifyAgent(id: string): Promise<AgentCheck>;
  /** The owner's apps; `search` looks in all of Composio's apps. */
  apps(search?: string): Promise<AppsView>;
  /** Checks and saves the Composio API key; "" removes it. A bad key is not saved. */
  setComposioKey(key: string): Promise<AppsView>;
  /** A sign-in link for the app; when it is done an "apps" event comes. */
  connectApp(slug: string): Promise<{ url: string }>;
  disconnectApp(slug: string): Promise<AppsView>;
  /** 小红书 and 知乎 (ADR 0058). */
  socials(): SocialView[];
  /** Turns a platform on; `accepted` must be true: the owner read the account-risk notice. */
  enableSocial(platform: SocialPlatform, accepted: boolean): Promise<SocialView[]>;
  /** Turns a platform off: agents lose its tools and its watches stop. The sign-in is kept
   * unless the owner disconnects (socialLogout first). */
  disableSocial(platform: SocialPlatform): Promise<SocialView[]>;
  /** A QR code to sign in; when the scan is done a "socials" event comes. */
  socialLoginCode(platform: SocialPlatform): Promise<SocialLoginCode>;
  /** Forgets the sign-in on this Mac. */
  socialLogout(platform: SocialPlatform): Promise<SocialView[]>;
  /** Checks now whether the platform is reachable and signed in; says what it found, in Chinese. */
  testSocial(platform: SocialPlatform): Promise<SocialTest>;
  setSocialWatch(platform: SocialPlatform, kind: SocialKind, on: boolean): SocialView[];
  /** Everything AgentHerd watches: pull requests, mail, new GitHub work, platforms. */
  watches(): WatchView[];
  setWatchPaused(id: string, paused: boolean): WatchView[];
  removeWatch(id: string): WatchView[];
}

export type HostMethod = keyof HostApi;

export const HOST_METHODS: readonly HostMethod[] = [
  "status",
  "tasks",
  "transcript",
  "memories",
  "editMemory",
  "forgetMemory",
  "restoreMemory",
  "schedules",
  "setSchedulePaused",
  "removeSchedule",
  "providers",
  "models",
  "putService",
  "removeService",
  "setKey",
  "chooseModel",
  "testModel",
  "probeModels",
  "setupFeishu",
  "cancelSetup",
  "setupState",
  "updateSettings",
  "modelTiers",
  "setModelTiers",
  "reconnect",
  "agents",
  "installAgent",
  "cancelInstall",
  "removeAgent",
  "verifyAgent",
  "apps",
  "setComposioKey",
  "connectApp",
  "disconnectApp",
  "socials",
  "enableSocial",
  "disableSocial",
  "socialLoginCode",
  "socialLogout",
  "testSocial",
  "setSocialWatch",
  "watches",
  "setWatchPaused",
  "removeWatch",
];

export type HostEvent =
  | { topic: "status"; data: HostStatus }
  | { topic: "tasks"; data: TasksView }
  | { topic: "models"; data: ModelsView }
  | { topic: "setup"; data: SetupState }
  | { topic: "agents"; data: AgentView[] }
  | { topic: "apps"; data: AppsView }
  | { topic: "socials"; data: SocialView[] }
  | { topic: "watches"; data: WatchView[] };

/** The same API, asynchronous, as seen by a client. */
export type RemoteHost = {
  [K in HostMethod]: (...args: Parameters<HostApi[K]>) => Promise<Awaited<ReturnType<HostApi[K]>>>;
};

// Wire format: one JSON object per line.
export interface CallMessage {
  v: number;
  id: number;
  type: "call";
  method: HostMethod;
  params: unknown[];
}

export interface ResultMessage {
  v: number;
  id: number;
  type: "result";
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface EventMessage {
  v: number;
  type: "event";
  event: HostEvent;
}
