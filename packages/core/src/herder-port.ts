import type { SocialKind, SocialPlatform } from "./social-watch.ts";
import type { SourceState } from "./source-health.ts";
// What the Herd and the Herder know about each other (docs/spec/04-herder.md §1). The core does
// not import the Herder or any model library: the CLI or the app passes a factory.

import type { HerderStyle, Locale, ReportResult } from "@agentherd/protocol";
import type { OutboundStep } from "@agentherd/rules";
import type { IntakeRequest } from "./intake.ts";
import type { HerdReport } from "./mcp-gateway.ts";
import type { Completer, Embedder, MemoryStore } from "./memory-store.ts";
import type { NoticeKind, NoticeLevel } from "./notices.ts";
import type { Schedule, ScheduleInput, SchedulePatch } from "./schedules.ts";
import type { DecisionRow, IntakeWatch, MailWatch, TranscriptEntry } from "./store.ts";
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
export interface HerderHost {
  readonly locale: Locale;
  readonly texts: CoreTexts;
  readonly userHome: string;
  profiles(): { id: string; name: string }[];
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
  ask(text: string, options: string[]): Promise<void>;
  /** Names of the owner's connected apps; agents use them (docs/spec/09-agent-tools.md §3). */
  apps?(): string[];
  /** Mail the owner asked to hear about (ADR 0048); absent without connected apps. */
  mailWatches?(): MailWatch[];
  /** Starts telling the owner about mail matching a Gmail search; throws when Gmail cannot be read. */
  watchMail?(about: string, query: string): Promise<MailWatch>;
  unwatchMail?(id: string): boolean;
  /** Turned-on 小红书 / 知乎 accounts and what each tells the owner about (ADR 0058). */
  socialWatches?(): {
    platform: SocialPlatform;
    name: string;
    ready: boolean;
    watch: Record<SocialKind, boolean>;
  }[];
  setSocialWatch?(platform: SocialPlatform, kind: SocialKind, on: boolean): void;
  /** Turned-on news sources (ADR 0059). */
  feeds?(): readonly FeedSource[];
  /** Reads one; `mark` records the items as told to the owner. */
  readFeed?(source: FeedSource, query: FeedQuery, mark: boolean): Promise<FeedItem[]>;
  /** Lines every new task gets: tools on this Mac the agent can use (lark-cli, Obsidian, ADR 0059). */
  toolNotes?(): string[];
  /** New-work watches (ADR 0052), when GitHub is set up. */
  intakeWatches?(): IntakeWatch[];
  watchIntake?(request: IntakeRequest): Promise<IntakeWatch>;
  unwatchIntake?(id: string): boolean;
  /** What the Herder does at set times (ADR 0055). */
  schedules?(): Schedule[];
  addSchedule?(input: ScheduleInput): Schedule;
  changeSchedule?(id: string, patch: SchedulePatch): Schedule;
  removeSchedule?(id: string): boolean;
  /** Watched sources that are failing now (ADR 0050). */
  sources?(): SourceState[];
  /** How the Herder talks (ADR 0053); absent → the default style. */
  style?(): HerderStyle;
  /** Changes it when the owner asks in chat. */
  setStyle?(style: HerderStyle): void;
  /** How each informational notice reaches the owner (ADR 0061). */
  noticeLevels?(): Record<NoticeKind, NoticeLevel>;
  /** Changes one when the owner asks (「合并了不用告诉我」); throws on an unknown kind or level. */
  setNoticeLevel?(kind: NoticeKind, level: NoticeLevel): void;
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
}

/** Card action target of the 「重试」 button on a held Herder message. */
export const HERDER_RETRY_TARGET = "herder";

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
