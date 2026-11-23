// The local API of the AgentHerd host (docs/spec/02-architecture.md §4). The desktop app and the
// CLI use it; agents do not. Items are decided in the channel, or through the desktop pet, which
// passes the owner's press on as if made in the channel (ADR 0070).
// These types have no runtime imports, so the renderer can import them too.

import type {
  CustomApi,
  HerderContextItem,
  HerderContextParts,
  HerderFoldBy,
  HerderFoldState,
  Letter,
  LetterFate,
  MailboxKind,
  MailboxSource,
  MemoryRow,
  ModelRef,
  ModelRole,
  ModelService,
  ModelSettings,
  ScheduleWhen,
  Task,
  TranscriptEntry,
} from "@agentherd/core";
import type {
  AskView,
  ItemView,
  Locale,
  Mode,
  ReportResult,
  ReportView,
  Risk,
  TextView,
} from "@agentherd/protocol";

export type {
  HerderContextItem,
  HerderContextPart,
  HerderContextParts,
  HerderFoldBy,
  HerderFoldState,
  Letter,
  LetterFate,
  MailboxAct,
  MailboxKind,
  MailboxSource,
  ScheduleWhen,
} from "@agentherd/core";

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
  /** The owner's Obsidian vault folder, if set (ADR 0059). */
  obsidianVault?: string;
  /** Agent profile ids the owner can start with /run. */
  profiles: string[];
  /** The desktop pet (ADR 0070). */
  pet: PetSettings;
  /**
   * The Herder's working window in tokens (ADR 0097): it folds old talk before this fills up.
   * 0 is the model's whole window.
   */
  herderWindow: number;
}

/**
 * Where an agent's CLI comes from: inside the app (ADR 0067), a download on this computer (Claude
 * Code on request, ADR 0069, or an older app's copy), a CLI the owner installed, or a profile in
 * config.json.
 */
export type AgentSource = "bundled" | "managed" | "system" | "config";

export interface AgentView {
  id: string;
  name: string;
  /** ready: can run tasks. missing: not in this app and not installed on the computer. */
  state: "ready" | "missing" | "installing";
  source?: AgentSource;
  path?: string;
  /** Version of the copy in use, when it ships with the app or an older app downloaded it. */
  version?: string;
  /** The version AgentHerd is adapted to and ships (ADR 0067). */
  adapted?: string;
  /** Not in the app; the owner can download it (ADR 0069). */
  onRequest?: boolean;
  /** The owner's own CLI the adapter runs (Claude Code's `claude`). */
  ownCli?: string;
  /** Bytes, while downloading. */
  progress?: { received: number; total: number };
  /** Last download error. */
  error?: string;
  /** The app can download it now (only when missing and not in the app; never an update). */
  canInstall: boolean;
  /** A download the owner can remove. */
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

/** One tool call the Herder made in a turn (主管 › 行动记录). */
export interface HerderActivityStep {
  tool: string;
  args: Record<string, unknown>;
  /** The tool's answer as the Herder saw it, cut when long. */
  result: string;
  error: boolean;
  ms?: number;
}

/** One Herder turn, read back from its saved conversation. */
export interface HerderActivityTurn {
  at: string;
  /** What started it. notice: only task reports or other news (turns from before 2026-11). */
  trigger: "owner" | "answer" | "task" | "scheduled" | "intake" | "notice" | "other";
  /** The owner's words, their answer, the task's name, the schedule's name, the GitHub item. */
  text: string;
  /** The question an answer answered. */
  question?: string;
  /** News that came along with the turn, one entry each. */
  events: string[];
  /** It came before AgentHerd restarted. */
  resumed: boolean;
  steps: HerderActivityStep[];
  /** What the Herder said last; "" when it said nothing. */
  reply: string;
  /** It chose to say nothing. */
  quiet: boolean;
  model?: string;
}

/** Something that happened to the Herder outside its conversation: an error, a retry, a guard hit. */
export interface HerderIncident {
  at: string;
  /** The audit kind, e.g. "herder.error". */
  kind: string;
  data: Record<string, unknown>;
}

/** Token counts of a span of the Herder's requests (ADR 0093). */
export interface HerderUsage {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Share of the input the provider read from its cache, 0–1; 0 without requests. */
  hitRate: number;
  /** Dollars, as the providers said; 0 when they did not say. */
  cost: number;
}

export interface HerderUsageDay extends HerderUsage {
  /** Local day, YYYY-MM-DD. */
  day: string;
}

/** One request the Herder made (ADR 0095). */
export interface HerderRequestView {
  at: string;
  model: string;
  /** Size of the prompt as the provider counted it (else our estimate). */
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Where its reply sits, and the round it belongs to. */
  seq?: number;
  round?: number;
  /** Our estimate of its parts; only for requests since ADR 0093. */
  parts?: HerderContextParts;
  failed?: boolean;
}

/** What the next request would send, rebuilt from herd.db (ADR 0095). */
export interface HerderContextNow {
  tokens: number;
  /**
   * The working window (the owner's pick, never more than the model's, ADR 0097) and where
   * AgentHerd folds by itself.
   */
  window: number;
  foldAt: number;
  /** The owner's pick (one of HERDER_WINDOWS) and the model's own window, when known. */
  choice: number;
  modelWindow?: number;
  parts: HerderContextParts;
  /** Each piece, its text cut short; `herderMessages` gives the whole of a message. */
  items: (HerderContextItem & { seq?: number })[];
  /** No system prompt kept yet (before the Herder's first request on this version). */
  noPrompt?: boolean;
}

/** A stretch of the conversation as the model sees it: one fold, or messages as they were. */
export type HerderContextSegment =
  | {
      kind: "fold";
      blockId: string;
      startSeq: number;
      endSeq: number;
      messages: number;
      tokensBefore: number;
      tokensAfter: number;
    }
  | { kind: "raw"; startSeq: number; endSeq: number; messages: number; tokens: number };

/** A fold with what the tab needs to place it (ADR 0095). */
export interface HerderFoldView {
  blockId: string;
  parent?: string;
  /** Folds directly inside it. */
  children: string[];
  level: number;
  state: HerderFoldState;
  by: HerderFoldBy;
  topic?: string;
  summary: string;
  startSeq: number;
  endSeq: number;
  messages: number;
  rounds: number;
  /** Messages of each kind (owner, task, reply, call, result…). */
  kinds: Record<string, number>;
  /** Times of its first and last message. */
  startAt: string;
  endAt: string;
  callSeq?: number;
  /**
   * Where the model reads its summary: in its compress call (still in view), as a note in its
   * place, inside the fold that took it in, or nowhere (opened).
   */
  summaryAt: "call" | "note" | "parent" | "none";
  tokensBefore: number;
  tokensAfter: number;
  createdAt: string;
  /** Not made yet: the next request would fold this by itself (90 % full). */
  pending?: boolean;
}

/** A round: the Herder woken once, by the owner, a task, an event or a schedule. */
export interface HerderRoundView {
  seq: number;
  endSeq: number;
  at: string;
  kind: string;
  title: string;
  messages: number;
  tokens: number;
  /** The innermost fold it sits in; none when the model reads it as it was. */
  fold?: string;
}

/** One message of the conversation, for the tree and the browser. */
export interface HerderMessageView {
  seq: number;
  at: string;
  role: string;
  kind: string;
  tool?: string;
  round: number;
  tokens: number;
  /** Its text, cut to 2,000 characters; `more` says how much was left out. */
  text: string;
  more: number;
}

export interface HerderEventView {
  at: string;
  kind: string;
  round?: number;
  data: Record<string, unknown>;
}

/** The 上下文 tab of the 主管 page, read from herd.db alone (ADR 0093, ADR 0095). */
export interface HerderContextView {
  /** Changes whenever anything shown changes; pass it back to get `unchanged`. */
  key: string;
  /** Whether a Herder is running now. */
  on: boolean;
  now?: HerderContextNow;
  /** Why `now` could not be rebuilt. */
  problem?: string;
  facts: {
    messages: number;
    /** Size of every message as it was. */
    tokens: number;
    rounds: number;
    activeFolds: number;
    folds: number;
    /** Tokens the active folds save. */
    saved: number;
    /** Messages the model reads as they were. */
    shown: number;
    /** Cache hits of the last request, 0–1. */
    lastHitRate?: number;
  };
  /** The model's view in order: folds and stretches of messages as they were. */
  segments: HerderContextSegment[];
  /** Every fold ever made, oldest first. */
  folds: HerderFoldView[];
  /** The newest rounds, oldest first. */
  rounds: HerderRoundView[];
  /** The newest requests, oldest first. */
  requests: HerderRequestView[];
  /** Days with requests, oldest first. */
  days: HerderUsageDay[];
  total: HerderUsage;
  /** The newest events, oldest first. */
  events: HerderEventView[];
}

/** Returned instead of the view when nothing changed since `known`. */
export interface HerderContextSame {
  key: string;
  unchanged: true;
}

/** 主管 › 行动记录: the Herder's turns and incidents, newest first. */
export interface HerderActivityView {
  turns: HerderActivityTurn[];
  incidents: HerderIncident[];
  /** Turns there are in all; `turns` holds the newest of them. */
  total: number;
}

/**
 * Fields of the owner's profile card (ADR 0091), in the order the app shows them. The same list as
 * PROFILE_FIELDS in @agentherd/core; kept here because this file has no runtime imports.
 */
export const PROFILE_FIELD_NAMES = [
  "称呼",
  "身份",
  "在做",
  "作息",
  "回答方式",
  "喜好",
  "在意",
] as const;
export type ProfileFieldName = (typeof PROFILE_FIELD_NAMES)[number];
/** The owner's profile card: the value of each field it has. */
export type OwnerProfile = Partial<Record<ProfileFieldName, string>>;
/** Characters one profile field may hold. */
export const PROFILE_VALUE_MAX = 60;

/** The Herder's long-term memory for the 记忆 page (ADR 0038). */
export interface MemoryView {
  /** Active entries, newest first, and the last deleted ones (to restore). */
  entries: MemoryRow[];
  deleted: MemoryRow[];
  /** Characters used and allowed of the kinds kept in the Herder's prompt. */
  used: { profile: number; owner: number; decision: number; note: number };
  caps: { profile: number; owner: number; decision: number; note: number };
  /** False while AgentHerd is not following tasks (no herd): nothing to show or change. */
  ready: boolean;
}

export interface ServiceView extends ModelService {
  /** A key is saved, or the subscription is signed in (ADR 0068). */
  hasKey: boolean;
}

/** A vendor the owner can sign in to with an account instead of a key (ADR 0068). */
export interface SubscriptionView {
  provider: string;
  name: string;
  /** Backed by a paid plan (ChatGPT Plus, Claude Max…) rather than a free account. */
  subscription: boolean;
  models: { id: string; name: string }[];
}

export interface LoginPrompt {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}

/** A running or finished sign-in; progress comes as "login" events. */
export interface LoginView {
  id: string;
  provider: string;
  serviceId: string;
  status: "running" | "done" | "failed" | "cancelled";
  /** A page to open: the vendor's sign-in page or where to type `userCode`. */
  url?: string;
  instructions?: string;
  /** Device-code flows: the code to type on `url`. */
  userCode?: string;
  progress?: string;
  /** A question the flow waits on; answer with `answerLogin`. */
  prompt?: LoginPrompt;
  models?: string[];
  error?: string;
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
  /** An Obsidian vault folder; "" clears it. */
  obsidianVault?: string;
  pet?: Partial<PetSettings>;
  /** One of HERDER_WINDOWS. */
  herderWindow?: number;
}

/** The Herder's working windows the owner can pick (ADR 0097); 0 is the model's whole window. */
export const HERDER_WINDOWS = [64_000, 128_000, 256_000, 0] as const;
export const DEFAULT_HERDER_WINDOW = 128_000;

/**
 * The figures that come with the app: two from llm-pet (ADR 0070) and sixteen anime figures from
 * awesome-codex-pet (ADR 0092). Where each comes from is in the desktop's pet/figures.ts.
 */
export const PET_FIGURES = [
  "deepseek",
  "claude",
  "frieren",
  "bocchi",
  "nijika",
  "kita",
  "ryo",
  "emilia",
  "reze",
  "mikoto",
  "miku",
  "chiikawa",
  "hachiware",
  "toothless",
  "luoxiaohei",
  "tushansusu",
  "hanli",
  "wukong",
] as const;
export type PetFigure = (typeof PET_FIGURES)[number];

export interface PetSettings {
  /** Shown on the desktop. */
  on: boolean;
  figure: PetFigure;
  /**
   * System notifications for what waits for the owner and for task results, even when the pet
   * and the chat app are out of sight (ADR 0079).
   */
  notify: boolean;
  /** Those notifications ring; a finished task never does, a failed one and a question do. */
  sound: boolean;
  /** `HH:MM-HH:MM` local hours with no notification, no sound and no panel popping open; "" none. */
  quietHours: string;
  /** Quiet until this ISO time (暂停打扰 from the menu bar or settings); "" when not snoozed. */
  quietUntil: string;
  /**
   * A global shortcut (an Electron accelerator such as `CommandOrControl+Shift+Space`) that opens
   * the pet's conversation with the cursor in the input; "" for none (ADR 0080).
   */
  talkKey: string;
  /**
   * A global shortcut that picks the oldest approval waiting; pressed again within a few seconds
   * it allows that one (ADR 0080). "" for none.
   */
  approveKey: string;
  /**
   * "always": the pet floats above other windows; "busy": only while it has something for the
   * owner (an approval or a question waits, a new line, its panel open), else it sits among the
   * other windows (ADR 0080).
   */
  onTop: PetOnTop;
  /** macOS: also shown over apps in full screen (ADR 0080). Off by default. */
  overFullscreen: boolean;
  /**
   * After a reply the Herder guesses what the owner will say next; the pet shows it in the empty
   * input and Tab takes it (ADR 0084). One small model call per reply.
   */
  suggest: boolean;
}

export const PET_ON_TOP = ["always", "busy"] as const;
export type PetOnTop = (typeof PET_ON_TOP)[number];

/** Files the owner can drop on the pet at once (ADR 0082). */
export const PET_DROP_MAX = 6;

export const DEFAULT_PET: PetSettings = {
  on: true,
  figure: "deepseek",
  notify: true,
  sound: true,
  quietHours: "",
  quietUntil: "",
  talkKey: "CommandOrControl+Shift+Space",
  approveKey: "CommandOrControl+Shift+Y",
  onTop: "always",
  overFullscreen: false,
  suggest: true,
};

/** `HH:MM-HH:MM`, both in 00:00–23:59; the hours may cross midnight (ADR 0079). */
export const QUIET_HOURS = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

/** Modifiers a pet shortcut may use (Electron accelerator words, ADR 0080). */
export const PET_SHORTCUT_MODIFIERS = ["CommandOrControl", "Control", "Alt", "Super", "Shift"];

/**
 * A global shortcut the pet takes (ADR 0080): up to three different modifiers, one of them not
 * Shift, then a letter, digit, Space, an arrow or a punctuation key; a function key needs none.
 */
export function isPetShortcut(value: string): boolean {
  const parts = value.split("+");
  // "+" itself is not offered, so the key is never empty.
  const key = parts.pop() ?? "";
  if (parts.length > 3 || new Set(parts).size !== parts.length) return false;
  if (!parts.every((m) => PET_SHORTCUT_MODIFIERS.includes(m))) return false;
  if (/^F([1-9]|1\d|2[0-4])$/.test(key)) return true;
  const ok = /^([A-Z0-9]|Space|Up|Down|Left|Right|[/.,;'[\]\\`=-])$/.test(key);
  return ok && parts.some((m) => m !== "Shift");
}

/** One thing AgentHerd sent to the owner, as the pet shows it. */
export interface PetLine {
  /** Grows with every new line, so the pet knows when to speak. */
  id: number;
  at: string;
  /**
   * say: the Herder talking; task: a task's progress; report: a task finished; ask: needs the
   * owner; owner: what the owner wrote or answered, in the chat app or to the pet (only in
   * `history`).
   */
  kind: "say" | "task" | "report" | "ask" | "error" | "owner";
  text: string;
  /** Task title or label. */
  task?: string;
  /** Only for reports. */
  result?: ReportResult;
  /** It came as this card (`PetView.cards`), which shows it (ADR 0072). */
  card?: string;
}

/** The views the pet shows as cards, like the chat app (ADR 0072). */
export type PetCardView = ReportView | ItemView | AskView | TextView;

/** A card sent to the owner, in its latest form, kept in herd.db (ADR 0072). */
export interface PetCard {
  /** `channelId:messageId`. */
  ref: string;
  /** When it was first sent. */
  at: string;
  view: PetCardView;
  /** Its buttons work: sent in this run of AgentHerd and not answered yet. */
  open: boolean;
}

/** A card waiting for the owner; its buttons work the same as in the chat app. */
export interface PetPending {
  target: string;
  title: string;
  body: string;
  options: { action: string; label: string }[];
  task?: string;
  /** Open approvals on a combined card. */
  count?: number;
}

export interface PetView {
  /** The chat channel is up, so the owner can talk and press buttons. */
  connected: boolean;
  /** The latest line AgentHerd sent; never the owner's own. */
  last?: PetLine;
  /** Oldest first. */
  pending: PetPending[];
  /**
   * The Herder's conversation with the owner as herd.db keeps it, both ways, the last lines,
   * oldest first (the expanded pet). Ids are those of `herder_turns`. Lines a card shows are
   * left out.
   */
  history: PetLine[];
  /** The cards sent to the owner over the same time, oldest first (ADR 0072). */
  cards: PetCard[];
  /**
   * What the owner might say next, guessed after the Herder's last reply (ADR 0084). Gone once
   * anything new is said or a card waits for them.
   */
  suggestion?: string;
}

/** 飞书 through lark-cli in 应用连接 (ADR 0059). */
export interface LarkView {
  state: "missing" | "installing" | "no-app" | "signed-out" | "ready" | "failed";
  account?: string;
  version?: string;
  problem?: string;
  checkedAt?: string;
}

/** A 飞书 sign-in: scan the image with the 飞书 app, or open the link. */
export interface LarkLogin {
  image: string;
  url: string;
}

export type FeedSource = "github-trending" | "hacker-news" | "arxiv";

/** One news source in 应用连接 (ADR 0059). */
export interface FeedView {
  source: FeedSource;
  name: string;
  on: boolean;
}

/** Official `@tencent-adm/westock-data` CLI install status in 应用连接 (ADR 0076). */
export type WestockCliState = "missing" | "installing" | "ready" | "failed";

/** Tencent WeStock (腾讯自选股) connection state in 设置 › 应用连接 (ADR 0076). */
export interface WestockView {
  /** Whether built-in live stock quotes (`stock_quote` / `WESTOCK_QUOTE`) are enabled. */
  enabled: boolean;
  /** Install status of the official `westock` research CLI (`@tencent-adm/westock-data`). */
  cliState: WestockCliState;
  /** True when the current OS/architecture has an official prebuilt `westock` CLI release. */
  supported: boolean;
  /** Installed `westock` CLI version when ready. */
  version?: string;
  /** True when installed inside AgentHerd's managed `bin` folder. */
  managed?: boolean;
  /** Resolved executable path when ready. */
  path?: string;
  /** Failure reason when `cliState === "failed"`. */
  problem?: string;
}

/** What 腾讯自选股 › 连接测试 found. */
export interface WestockTest {
  ok: boolean;
  message: string;
  sample?: string;
  westock: WestockView;
}

/** 雪球基金 (Danjuan Funds) login & session state (ADR 0077). */
export type DanjuanState = "off" | "signing-in" | "starting" | "ready" | "signed-out" | "failed";

/** 雪球基金 connection state in 设置 › 应用连接 › 行情与投研 (ADR 0077). */
export interface DanjuanView {
  /** True when Chrome or Edge is available on this computer for isolated session calls. */
  available: boolean;
  /** True once the owner accepted the read-only local-session risk notice. */
  accepted: boolean;
  enabled: boolean;
  state: DanjuanState;
  account?: string;
  problem?: string;
  checkedAt?: string;
}

/** What 雪球基金 › 测试连接 found. */
export interface DanjuanTest {
  ok: boolean;
  message: string;
  sample?: string;
  danjuan: DanjuanView;
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
  /** What reaches the Herder: mentions while a social source in the mailbox looks (ADR 0100). */
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

/** A pull request a task opened that AgentHerd keeps an eye on (ADR 0058); the rest is in the mailbox. */
export interface WatchView {
  /** `pr:<repo>#<n>`. */
  id: string;
  kind: "pr";
  /** What it watches, in the owner's words where there are some. */
  title: string;
  /** One line: how, how often. */
  detail: string;
  paused: boolean;
  removable: boolean;
  createdAt?: string;
  /** Last news from it (ISO). */
  activeAt?: string;
}

/** One MCP server of a plugin, as the owner sees it before installing (ADR 0094). */
export interface PluginServerView {
  name: string;
  kind: "stdio" | "http";
  /** The command line it runs, or the address it talks to, as written by the plugin. */
  run: string;
}

export interface PluginSkillView {
  name: string;
  description: string;
}

/** What a plugin would add, shown before the owner installs it. */
export interface PluginPreview {
  /** `official:<name>` or `github:owner/repo[/folder][@ref]`. */
  source: string;
  /** Where its files are on GitHub. */
  link: string;
  name: string;
  description: string;
  version?: string;
  author?: string;
  format: "claude" | "gemini";
  servers: PluginServerView[];
  /** Keys its servers read (`${GITHUB_TOKEN}`). */
  keys: string[];
  skills: PluginSkillView[];
  /** Parts only Claude Code or Gemini CLI can use, in words: 「3 个斜杠命令」. */
  ignored: string[];
  /** Servers that cannot run here, in words. */
  problems: string[];
  /** Set when a plugin from this source is installed already. */
  installedId?: string;
}

/**
 * off: turned off; idle: on, its servers start when an agent first needs them; starting;
 * ready: tools listed; failed: a server did not start or answer (see problem).
 */
export type PluginState = "off" | "idle" | "starting" | "ready" | "failed";

/** An installed plugin. */
export interface PluginView extends Omit<PluginPreview, "installedId"> {
  id: string;
  /** Task agents get its tools and skills. */
  enabled: boolean;
  /** The Herder also gets its read-only tools and its skills (off unless the owner turns it on). */
  herder: boolean;
  installedAt: string;
  state: PluginState;
  /** Tools its servers listed, and how many of them only read. */
  tools: number;
  readTools: number;
  problem?: string;
  /** Keys the owner filled in (the values stay in secrets.json). */
  keysSet: string[];
  /** The folder AgentHerd keeps it in. */
  dir: string;
}

/** One plugin of the official Claude Code plugin library. */
export interface PluginCatalogEntry {
  name: string;
  title: string;
  description: string;
  category?: string;
  author?: string;
  homepage?: string;
  /** What to pass to previewPlugin; missing when AgentHerd cannot install it (see why). */
  source?: string;
  why?: string;
  installed: boolean;
}

export interface PluginPatch {
  enabled?: boolean;
  herder?: boolean;
  /** Keys to save; "" removes one. */
  keys?: Record<string, string>;
}

// --- 信箱 (ADR 0099, 0100) ---------------------------------------------------------------------

/** What the owner fills in for a source; the host turns it into the source's config. */
export interface MailboxFields {
  /** github and work: owner/name or the repository's address. */
  repo?: string;
  /** github: what to look at (default issues and releases); work: assigned and/or reviews. */
  what?: ("issues" | "prs" | "releases" | "assigned" | "reviews")[];
  /** rss: the feed's address. */
  url?: string;
  /** github and rss: keep only items with one of these words; hn: the words to search. */
  words?: string;
  /** hn: only stories with at least this many points. */
  points?: number;
  /** script: the command line and the folder it runs in. */
  command?: string;
  cwd?: string;
  /** work: only items with this label. */
  label?: string;
  /** mail: a Gmail search. */
  query?: string;
  /** social: whose notices. */
  platform?: SocialPlatform;
  /** timer: when it runs. */
  when?: ScheduleWhen;
}

/** What a source does with a new letter: the Herder sorts it, it is offered, or work starts. */
export type MailboxActChoice = "sort" | "offer" | "auto";

export interface MailboxDraft extends MailboxFields {
  kind: MailboxKind;
  name: string;
  /** One sentence for the Herder: what the owner cares about here. A timer's job. */
  note?: string;
  everyMinutes?: number;
  act?: MailboxActChoice;
}

export interface MailboxSourcePatch {
  name?: string;
  note?: string;
  everyMinutes?: number;
  paused?: boolean;
  act?: MailboxActChoice;
  /** false ends an automatic source's trial run. */
  trial?: boolean;
  /** New fields: the source starts over with a first look that only remembers what is there. */
  fields?: MailboxFields;
}

/** A letter as the 信箱 page shows it: where it came from and what the Herder made of it. */
export interface MailboxLetterView {
  id: number;
  sourceId: string;
  /** The source's own id for it (issue:901, a feed's guid…): the same id never comes twice. */
  letterId: string;
  source: string;
  kind: MailboxKind;
  at: string;
  title: string;
  body: string;
  link?: string;
  /** Handed to the Herder; until then it waits (the Herder is busy or not running). */
  sentAt?: string;
  fate?: LetterFate;
  why?: string;
  filedAt?: string;
  digestedAt?: string;
}

/** A source as the 信箱 page shows it; a timer also says when it runs next. */
export type MailboxSourceView = MailboxSource & { nextAt?: string };

export interface MailboxView {
  /** False while AgentHerd is not running: nothing can be added or looked at. */
  on: boolean;
  sources: MailboxSourceView[];
  letters: MailboxLetterView[];
  /** How often each kind is looked at: the least and the default, in minutes. */
  every: Record<MailboxKind, { min: number; default: number }>;
  /** The hour the morning digest goes out. */
  digestHour: number;
}

export interface HostApi {
  status(): HostStatus;
  tasks(): TasksView;
  /** The conversation of one task: prompts, replies and tool calls. */
  transcript(taskId: string): TranscriptView;
  /** What the Herder did, newest turn first: at most `limit` turns (default 200). */
  herderActivity(limit?: number): HerderActivityView;
  /**
   * What the Herder's next request is made of, how its folds nest, its rounds, requests and token
   * use, all from herd.db (ADR 0093, ADR 0095). With the `key` of the last answer: only whether
   * it changed.
   */
  herderContext(known?: string): HerderContextView | HerderContextSame;
  /** Messages `from`–`to` of the Herder's conversation, at most 200, each cut to 2,000 characters. */
  herderMessages(from: number, to: number): HerderMessageView[];
  /** The original messages of one fold, as text. */
  herderContextFold(blockId: string): string;
  memories(): MemoryView;
  /** Changes an entry's text; the old text stays in its history. */
  editMemory(id: string, text: string): MemoryView;
  forgetMemory(id: string): MemoryView;
  restoreMemory(id: string): MemoryView;
  /** The owner's profile card (ADR 0091), with fields set before AgentHerd first ran. */
  ownerProfile(): OwnerProfile;
  /**
   * Sets one field of the owner's profile card; "" clears it. While AgentHerd is not running (the
   * first-run guide), the value waits in config.json and is written when it starts.
   */
  setProfile(field: ProfileFieldName, value: string): OwnerProfile;
  providers(): ProviderView[];
  models(): ModelsView;
  /** Adds or replaces a service. `key`: undefined keeps the saved key, "" removes it. */
  putService(service: ModelService, key?: string): Promise<ModelsView>;
  removeService(serviceId: string): Promise<ModelsView>;
  setKey(serviceId: string, key: string): Promise<ModelsView>;
  chooseModel(role: ModelRole, ref: ModelRef | null): Promise<ModelsView>;
  testModel(ref: ModelRef): Promise<ModelTest>;
  /** Vendors pi-ai can sign in to (ADR 0068). */
  subscriptions(): SubscriptionView[];
  /**
   * Starts signing in to `provider`. On success the service `serviceId` (new, or replaced) is
   * saved with the account's models. Cancels a sign-in still running.
   */
  startLogin(provider: string, serviceId: string, name?: string): LoginView;
  answerLogin(id: string, value: string): LoginView;
  cancelLogin(id: string): LoginView;
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
  /** Starts downloading an agent that is not in the app (ADR 0069); progress as "agents" events. */
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
  /** 飞书 through lark-cli (ADR 0059). Checks again on every call. */
  lark(): Promise<LarkView>;
  /** Installs and sets up lark-cli if needed and starts a QR sign-in; a "lark" event comes when done. */
  connectLark(): Promise<LarkLogin>;
  testLark(): Promise<{ ok: boolean; message: string; lark: LarkView }>;
  logoutLark(): Promise<LarkView>;
  feeds(): FeedView[];
  setFeed(source: FeedSource, on: boolean): FeedView[];
  westock(): Promise<WestockView>;
  setWestockEnabled(on: boolean): Promise<WestockView>;
  installWestock(): Promise<WestockView>;
  removeWestock(): Promise<WestockView>;
  testWestock(query?: string): Promise<WestockTest>;
  danjuan(): Promise<DanjuanView>;
  connectDanjuan(accepted: boolean): Promise<DanjuanView>;
  cancelDanjuanLogin(): Promise<DanjuanView>;
  testDanjuan(): Promise<DanjuanTest>;
  logoutDanjuan(): Promise<DanjuanView>;
  /** What the desktop pet shows (ADR 0070). */
  pet(): PetView;
  /**
   * The owner typed this to the pet: it reaches AgentHerd as a chat message. `paths` are files
   * dropped on the pet (ADR 0082): pictures go in as images, the rest as lines with their paths.
   */
  petSay(text: string, paths?: string[]): Promise<PetView>;
  /** The owner pressed a button on a card in the pet's bubble. */
  petPress(target: string, action: string): Promise<PetView>;
  /** The owner stopped a task (the pet's task card): its agent stops, the task stays (ADR 0072). */
  stopTask(taskId: string): Promise<void>;
  /** The official Claude Code plugin library (ADR 0094). */
  pluginCatalog(): Promise<PluginCatalogEntry[]>;
  plugins(): PluginView[];
  /** Downloads a plugin and says what it would add; nothing is installed yet. */
  previewPlugin(source: string): Promise<PluginPreview>;
  /** Installs a plugin the owner looked at, with the keys they filled in. */
  installPlugin(source: string, keys: Record<string, string>): Promise<PluginView[]>;
  setPlugin(id: string, patch: PluginPatch): Promise<PluginView[]>;
  removePlugin(id: string): Promise<PluginView[]>;
  /** The single WeCom office account, not a control channel. */
  wecom(): Promise<WecomView>;
  startWecomLogin(): Promise<WecomView>;
  cancelWecomLogin(): Promise<WecomView>;
  disconnectWecom(): Promise<WecomView>;
  /** 信箱 (ADR 0099): the sources and the newest letters with what the Herder made of them. */
  mailbox(): MailboxView;
  mailboxAdd(draft: MailboxDraft): Promise<MailboxView>;
  mailboxSet(id: string, patch: MailboxSourcePatch): Promise<MailboxView>;
  mailboxRemove(id: string): Promise<MailboxView>;
  /** Looks at a source now and hands what came to the Herder. */
  mailboxRun(id: string): Promise<MailboxView>;
  /** One look without keeping anything: what the source would bring now. */
  mailboxTry(draft: MailboxDraft): Promise<Letter[]>;
}

export type HostMethod = keyof HostApi;

export interface WecomView {
  state: "disconnected" | "connecting" | "connected" | "failed";
  qr?: string;
  error?: string;
  capabilities: { id: string; name: string; toolCount: number }[];
}

export const HOST_METHODS: readonly HostMethod[] = [
  "status",
  "tasks",
  "transcript",
  "herderActivity",
  "herderContext",
  "herderMessages",
  "herderContextFold",
  "memories",
  "editMemory",
  "ownerProfile",
  "setProfile",
  "forgetMemory",
  "restoreMemory",
  "providers",
  "models",
  "putService",
  "removeService",
  "setKey",
  "chooseModel",
  "testModel",
  "subscriptions",
  "startLogin",
  "answerLogin",
  "cancelLogin",
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
  "lark",
  "connectLark",
  "testLark",
  "logoutLark",
  "feeds",
  "setFeed",
  "westock",
  "setWestockEnabled",
  "installWestock",
  "removeWestock",
  "testWestock",
  "danjuan",
  "connectDanjuan",
  "cancelDanjuanLogin",
  "testDanjuan",
  "logoutDanjuan",
  "pet",
  "petSay",
  "petPress",
  "stopTask",
  "pluginCatalog",
  "plugins",
  "previewPlugin",
  "installPlugin",
  "setPlugin",
  "removePlugin",
  "wecom",
  "startWecomLogin",
  "cancelWecomLogin",
  "disconnectWecom",
  "mailbox",
  "mailboxAdd",
  "mailboxSet",
  "mailboxRemove",
  "mailboxRun",
  "mailboxTry",
];

export type HostEvent =
  | { topic: "status"; data: HostStatus }
  | { topic: "tasks"; data: TasksView }
  | { topic: "models"; data: ModelsView }
  | { topic: "setup"; data: SetupState }
  | { topic: "agents"; data: AgentView[] }
  | { topic: "apps"; data: AppsView }
  | { topic: "socials"; data: SocialView[] }
  | { topic: "watches"; data: WatchView[] }
  | { topic: "lark"; data: LarkView }
  | { topic: "westock"; data: WestockView }
  | { topic: "danjuan"; data: DanjuanView }
  | { topic: "login"; data: LoginView }
  | { topic: "pet"; data: PetView }
  | { topic: "plugins"; data: PluginView[] }
  | { topic: "mailbox"; data: MailboxView };

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
