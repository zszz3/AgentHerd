import type { SocialPlatform } from "./social-watch.ts";
import type { SourceState } from "./source-health.ts";
// What the Herd and the Herder know about each other (docs/spec/04-herder.md §1). The core does
// not import the Herder or any model library: the CLI or the app passes a factory.

import type { Locale, ReportResult, View } from "@agentherd/protocol";
import type { OutboundStep } from "@agentherd/rules";
import type {
  Letter,
  LetterDelivery,
  LetterFate,
  MailboxPatch,
  MailboxSource,
  MailboxSourceInput,
} from "./mailbox.ts";
import type { HerdReport } from "./mcp-gateway.ts";
import type { Completer, Embedder, MemoryStore } from "./memory-store.ts";
import type { NoticeKind, NoticeLevel } from "./notices.ts";
import type { Schedule } from "./schedules.ts";
import type { DecisionRow, TranscriptEntry } from "./store.ts";
import type { Task } from "./tasks.ts";
import type { CoreTexts } from "./texts.ts";

/** Public news sources the host reads (ADR 0059). */
export const FEED_SOURCES = ["github-trending", "hacker-news", "arxiv"] as const;
export type FeedSource = (typeof FEED_SOURCES)[number];
export interface FeedQuery {
  since?: "daily" | "weekly" | "monthly";
  language?: string;
  /** Search words (Hacker News, arXiv). */
  query?: string;
  limit?: number;
}
export interface FeedItem {
  id: string;
  title: string;
  url: string;
  about: string;
  /** Already told to the owner in an earlier digest. */
  seen: boolean;
}

/** An image the owner sent, saved under `<home>/attachments`. */
export interface OwnerImage {
  mimeType: string;
  /** Base64. */
  data: string;
  /** Where the image is saved, for agents and models that cannot take images. */
  path: string;
}

/** Who said a line of the Herder's conversation: `owner` typed, `answer` is a button pick. */
export type HerderTurnRole = "owner" | "answer" | "herder" | "ask" | "event";

export interface HerderEvent {
  /**
   * `ask-closed`: one of the Herder's own questions closed without a pick (ADR 0056). `approval`:
   * how the owner answered an approval card, so the Herder can offer to keep it (ADR 0057).
   * `unread`: a message for a task that ended before it read it (ADR 0061).
   */
  kind:
    | "task-reported"
    | "watchdog"
    | "github"
    | "mail"
    | "intake"
    | "ask-closed"
    | "approval"
    | "social"
    | "unread";
  /** The task it is about; mail is about no task. */
  taskId?: string;
  /** The task's title, or for mail what the owner asked to hear about. */
  title: string;
  /** Text that came from an agent. Untrusted. */
  text: string;
  /** `approval` only: how the card was answered. */
  outcome?: "allowed" | "refused" | "skipped" | "timed out";
  /** `unread` only: why the task ended. */
  why?: string;
  /**
   * Set when the owner's phone did not ring for it (ADR 0061): `board`, only the task's row on
   * the board changed; `none`, the owner was not shown it at all. Unset: it was sent.
   */
  shown?: "board" | "none";
}

/**
 * A task's result for the Herder to tell the owner in its own words (ADR 0053). `report` is the end
 * of a turn; `notice` is a herd_report that needs the owner now (waiting, blocked, failed).
 */
export interface VoiceRequest {
  kind: "report" | "notice";
  taskId: string;
  title: string;
  /** How the turn ended (report), or the herd_report state (notice). */
  result: ReportResult | "waiting" | "blocked" | "failed";
  /** The agent's last reply, verbatim. Untrusted. */
  reply: string;
  /** The agent's own herd_report of this turn, if any. Untrusted. */
  report?: HerdReport;
}

/** Everything the Herder can do. There is deliberately nothing here that answers an item. */
/** Where the Herder's guess at the owner's next message goes (ADR 0084). */
export interface HerderSuggestion {
  on(): boolean;
  show(text: string): void;
}

/**
 * Plugins the owner let the Herder use (ADR 0094): their read-only tools and their skills.
 * `list` is what is known now (it changes when a plugin is turned on or off).
 */
export interface HerderPlugins {
  list(): {
    tools: { name: string; description: string }[];
    skills: { name: string; description: string }[];
  };
  call(name: string, args: unknown): Promise<unknown>;
  skill(name: string): string;
}

export interface HerderHost {
  readonly locale: Locale;
  readonly texts: CoreTexts;
  readonly userHome: string;
  readonly protectedPaths?: readonly string[] | undefined;
  readonly protectedLocationFiles?: readonly string[] | undefined;
  /** ownModels: the agent brings its own sign-in and models (ADR 0104). */
  profiles(): { id: string; name: string; ownModels?: boolean }[];
  tasks(): Task[];
  openTasks(): Task[];
  /** A task's conversation with its agent, oldest first: for reading its replies whole (ADR 0062). */
  transcript?(taskId: string): readonly TranscriptEntry[];
  relayTaskId(): string | undefined;
  decisions(limit: number): DecisionRow[];
  /** Models in the owner's list ("service/model") and the profile ids that can run each. */
  models(): { ref: string; agents: string[] }[];
  /** Whether a model answers now; true when there is nothing to check with. */
  checkModel(ref: string): Promise<{ ok: true } | { ok: false; message: string }>;
  /**
   * `title` is the task's short name, chosen by the Herder; `prompt` is what the agent receives. `model` ("service/model")
   * runs the agent with that model; without it the agent uses its own settings.
   */
  startTask(
    profileId: string,
    /** The owner's project folder; undefined for a task that needs none (a scratch folder). */
    cwd: string | undefined,
    title: string,
    prompt: string,
    model?: string,
    images?: OwnerImage[],
    /** Steps leaving the Mac the owner allowed for this task in their request (ADR 0056). */
    allowed?: readonly OutboundStep[],
  ): Promise<string>;
  promptTask(taskId: string, text: string, images?: OwnerImage[]): void;
  /** A new short name for a task, when its work changed. */
  renameTask(taskId: string, name: string): void;
  cancelTurn(taskId: string): Promise<void>;
  /** Closes a task for good because the owner said it is finished. */
  endTask(taskId: string): Promise<void>;
  startRelay(taskId: string): Promise<void>;
  endRelay(): Promise<void>;
  say(text: string): Promise<void>;
  /** A red card from the Herder (ADR 0037); `retry` adds a 「重试」 button that calls {@link HerderPort.retry}. */
  alert(text: string, retry: boolean): Promise<void>;
  /**
   * Closes the 「重试」 cards (ADR 0037): `done` when what they held ran after all, `stale` when
   * nothing waits on them. Unsent ones are dropped; sent ones lose their button.
   */
  closeAlerts?(why: "done" | "stale"): Promise<void>;
  ask(text: string, options: string[]): Promise<void>;
  /** Names of the owner's connected apps; agents use them (docs/spec/09-agent-tools.md §3). */
  apps?(): string[];
  /** The owner's mailbox sources (ADR 0099). */
  mailboxSources?(): MailboxSource[];
  addMailboxSource?(input: MailboxSourceInput): MailboxSource;
  changeMailboxSource?(id: string, patch: MailboxPatch): MailboxSource;
  removeMailboxSource?(id: string): boolean;
  /** One look without keeping anything. */
  tryMailboxSource?(input: MailboxSourceInput): Promise<Letter[]>;
  /** What the Herder made of letters; returns ids that are not letters. */
  fileLetters?(items: { id: number; fate: LetterFate; why: string }[]): number[];
  /**
   * Turned-on 小红书 / 知乎 accounts (ADR 0058): whether each is signed in, and whether a mailbox
   * source tells the owner about its comments and mentions (ADR 0100).
   */
  socialWatches?(): {
    platform: SocialPlatform;
    name: string;
    ready: boolean;
    watch: { mentions: boolean };
  }[];
  /** Turned-on news sources (ADR 0059). */
  feeds?(): readonly FeedSource[];
  /** Reads one; `mark` records the items as told to the owner. */
  readFeed?(source: FeedSource, query: FeedQuery, mark: boolean): Promise<FeedItem[]>;
  /** Whether Tencent WeStock quote lookup and local research CLI are ready (ADR 0076). */
  westock?(): { enabled: boolean; cliReady: boolean };
  /** Reads live market quotes (indices, A-shares, HK, US) from Tencent Finance (ADR 0076). */
  stockQuote?(query: string): Promise<string>;
  /** Whether 雪球基金 (Danjuan Funds) is connected for reading personal fund holdings (ADR 0077). */
  danjuan?(): { enabled: boolean; ready: boolean; state: string };
  /** Reads the owner's 雪球基金 holdings and recent N-day NAV gains/losses (ADR 0077). */
  fundHoldings?(query?: { days?: number; account?: string }): Promise<string>;
  /** Lines every new task gets: tools on this computer the agent can use (ADR 0059, ADR 0076, ADR 0077). */
  toolNotes?(): string[];
  /** Watched sources that are failing now (ADR 0050). */
  sources?(): SourceState[];
  /** How each informational notice reaches the owner (ADR 0061). */
  noticeLevels?(): Record<NoticeKind, NoticeLevel>;
  /** Changes one when the owner asks (「合并了不用告诉我」); throws on an unknown kind or level. */
  setNoticeLevel?(kind: NoticeKind, level: NoticeLevel): void;
  /**
   * What the owner might say next, for the desktop pet's input (ADR 0084): whether to work one out
   * now, and where to put it. Absent → none.
   */
  suggestion?: HerderSuggestion;
  /** Plugins the owner let the Herder use (ADR 0094); absent → none. */
  plugins?: HerderPlugins;
  audit(type: string, data: Record<string, unknown>): void;
  /** Keeps a line of the Herder's conversation with the owner (`herder_turns`). */
  recordTurn(role: HerderTurnRole, text: string, taskId?: string): void;
  /** The Herder's long-term memory (ADR 0038); absent in tests that do not use it. */
  readonly memory?: MemoryStore;
  /** Vectors for memory search; absent or not ready → keyword search alone. */
  readonly embedder?: Embedder;
  /** A cheap model for small judgements such as ranking past cases; absent → skip them. */
  readonly memoryComplete?: Completer;
  getState<T>(key: string): T | undefined;
  setState(key: string, value: unknown): void;
  /** The Herder's whole conversation as the model saw it, oldest first (ADR 0045). */
  herderLog(): unknown[];
  /** Replaces the saved conversation from position `from` on with `messages`. */
  writeHerderLog(from: number, messages: unknown[]): void;
  /** Keeps one request's token counts for the 上下文 tab (ADR 0093); absent → not kept. */
  recordRequest?(request: HerderRequestRecord): void;
  /** The folds as last saved, in the order they were made (ADR 0095); absent → none kept. */
  herderFolds?(): HerderFoldRecord[];
  /**
   * Saves the engine's bookkeeping under `key` and the folds that changed, in one go (ADR 0095);
   * absent → the whole state goes to `setState`.
   */
  saveHerderContext?(key: string, state: unknown, folds: HerderFoldRecord[]): void;
  /** Keeps a system prompt and tool list once, by hash (ADR 0095). */
  recordPrompt?(prompt: HerderPromptRecord): void;
  /** Keeps something that happened to the conversation: a fold, a repair, a start (ADR 0095). */
  herderEvent?(kind: string, data: Record<string, unknown>, round?: number): void;
}

/** What the Herder's requests are made of, as the 主管 page's 上下文 tab shows it (ADR 0093). */
export const HERDER_CONTEXT_PARTS = [
  "system",
  "memory",
  "tools",
  "owner",
  "herder",
  "results",
  "folds",
] as const;
export type HerderContextPart = (typeof HERDER_CONTEXT_PARTS)[number];
export type HerderContextParts = Record<HerderContextPart, number>;

/** One piece of a request: a message, a tool's schema, the system prompt. */
export interface HerderContextItem {
  part: HerderContextPart;
  label: string;
  tokens: number;
  /** Its text, cut to {@link HERDER_CONTEXT_ITEM_TEXT_MAX} characters. */
  text: string;
  /** Characters cut off the end of `text`. */
  more: number;
}
export const HERDER_CONTEXT_ITEM_TEXT_MAX = 1500;

/** The Herder's last request, measured before it went out (estimated tokens). */
export interface HerderContextSnapshot {
  at: string;
  tokens: number;
  /** The working window (the model's, at most 128K) and where a forced fold starts. */
  window: number;
  foldAt: number;
  parts: HerderContextParts;
  items: HerderContextItem[];
}

/**
 * One request to the Herder's model: what the provider counted, and what we sent (ADR 0093). The
 * only place usage is kept (ADR 0095); requests from before were filled in from the saved replies.
 */
export interface HerderRequestRecord {
  at: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** What the provider said it cost, in dollars; 0 when it did not say. */
  cost?: number;
  /** Size of the prompt: input, cache read and cache write as counted, else our estimate. */
  tokens: number;
  /** The working window the Herder had then (the model's, at most 128K). */
  window?: number;
  /** Our estimate of the parts; absent for requests kept from before ADR 0095. */
  parts?: HerderContextParts;
  /** Where the reply it made sits in the conversation; absent when the try was taken back. */
  seq?: number;
  /** The round it belongs to: position of the message that started the round. */
  round?: number;
  /** Hash of the system prompt and tools it went with (`herder_prompts`). */
  prompt?: string;
  /** The provider answered with an error. */
  failed?: boolean;
}

/** A system prompt with its tools, kept once per change (`herder_prompts`, ADR 0095). */
export interface HerderPromptRecord {
  hash: string;
  /** The system message's text, the resident memory at its end. */
  system: string;
  /** The tool definitions it declared. */
  tools: unknown[];
  tokens: number;
}

/** How a fold came about (ADR 0095). */
export type HerderFoldBy = "herder" | "forced" | "overflow";
/** active: in what the model sees; merged: inside a bigger fold; opened: unfolded. */
export type HerderFoldState = "active" | "merged" | "opened";

/**
 * A fold as kept in `herder_folds` (ADR 0095): never deleted, so the 上下文 tab can show every
 * fold and how they nest. Positions are `seq`s of the conversation.
 */
export interface HerderFoldRecord {
  blockId: string;
  /** The fold that took this one in; absent at the top. */
  parent?: string;
  /** 1 for a fold of messages, one more for each fold of folds. */
  level: number;
  state: HerderFoldState;
  by: HerderFoldBy;
  topic?: string;
  summary: string;
  /** First and last message it covers, folds inside included. */
  startSeq: number;
  endSeq: number;
  /** The messages it folded itself, without the folds it took in. */
  directStart?: number;
  directEnd?: number;
  messages: number;
  /** Where the Herder's compress call is: its summary is read there. Absent for AgentHerd's folds. */
  callSeq?: number;
  tokensBefore: number;
  tokensAfter: number;
  createdAt: string;
  updatedAt: string;
  /** The engine's own record, read back on start. */
  block: unknown;
}

/** Something that happened to the Herder's conversation (`herder_events`, ADR 0095). */
export interface HerderEventRecord {
  id: number;
  at: string;
  kind: string;
  round?: number;
  data: Record<string, unknown>;
}

/** Card action target of the 「重试」 button on a held Herder message. */
export const HERDER_RETRY_TARGET = "herder";

/** A card with the Herder's 「重试」 button that still works (ADR 0037). */
export function isHerderAlert(view: View): boolean {
  return (
    view.kind === "text" && view.target === HERDER_RETRY_TARGET && (view.options?.length ?? 0) > 0
  );
}

/** Calls return at once; the Herder works through them one at a time. */
export interface HerderPort {
  /** `text` may be empty when the owner sent only images. */
  ownerMessage(text: string, images?: OwnerImage[]): void;
  ownerAnswer(question: string, answer: string): void;
  event(event: HerderEvent): void;
  /**
   * New work the owner tapped 「开任务」 on, or a watch they made automatic found (ADR 0052): a
   * turn that may start a task for it. `text` names the item; its title is not the owner's.
   * With `trial` the watch is on its trial run: the turn decides as it would, but starts
   * nothing and tells the owner what it would have started (ADR 0064).
   */
  intake?(text: string, auto: boolean, trial?: boolean): void;
  /** A schedule is due (ADR 0055): its words come back as a turn of their own. */
  scheduled?(schedule: Schedule): void;
  /**
   * Letters the owner's mailbox sources brought (ADR 0099), or the ones kept for the morning
   * digest: a turn that files each and tells the owner only what matters now.
   */
  letters?(delivery: LetterDelivery): void;
  /**
   * Tells the owner a task's result in the Herder's words. Resolves with the message to send ("" to
   * send nothing: the owner already heard it), or undefined when the Herder could not speak.
   */
  voice?(request: VoiceRequest): Promise<string | undefined>;
  /** Runs a message held after every model failed (the owner tapped 「重试」). */
  retry?(): void;
  /**
   * Takes up the owner's messages and answers the last run received but did not finish (ADR 0062).
   * Called once AgentHerd is up, and after the Herder is replaced.
   */
  resume?(): void;
  stop(): Promise<void>;
}

export type HerderFactory = (host: HerderHost) => HerderPort;
