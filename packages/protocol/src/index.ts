// Shared types for AgentHerd. Names follow docs/spec/glossary.md.
// No ACP types here: the core speaks these, adapters translate.

/** docs/spec/03-agents.md, "Session states" */
export type SessionState =
  | "starting"
  | "working"
  | "waiting-approval"
  | "idle"
  | "looping"
  | "error"
  | "ended";

/** docs/spec/04-herder.md §2, "Stages" */
export type Stage = "queued" | "working" | "needs-owner" | "stuck" | "done" | "failed";

/** Language of everything the owner reads in the channel. Commands stay in English. */
export type Locale = "zh-CN" | "en";

export const DEFAULT_LOCALE: Locale = "zh-CN";

/** How a task ended, for the report card's color. */
export type ReportResult = "done" | "failed" | "blocked" | "stopped";

/** docs/spec/04-herder.md §2, `herd_report` states */
export type ReportState = "progress" | "waiting" | "ready" | "blocked" | "failed" | "dropped";

export type Mode = "observe" | "assist" | "auto";

export type Risk = "low" | "medium" | "high";

export interface AgentProfile {
  id: string;
  name: string;
  command: string[];
  env: Record<string, string>;
  exporter: string | null;
  /** `false`: start the agent without the `agentherd` MCP server (docs/spec/09-agent-tools.md). */
  mcp?: boolean;
  /**
   * The agent brings its own sign-in and models (Antigravity, ADR 0104): AgentHerd's model list
   * is not used, and a model the owner names is set in the agent's session by name.
   */
  ownModels?: boolean;
}

/** Channel-neutral description of what an agent wants to do. */
export interface ToolCallInfo {
  kind: string;
  title: string;
  command?: string;
  paths: string[];
  rawInput?: unknown;
  /** Kind "app" (command = the tool slug): the tool's hints from Composio, when it has any. */
  appHints?: AppHints;
}

/** Composio tool hints (tags), docs/spec/09-agent-tools.md §3. */
export interface AppHints {
  readOnly: boolean;
  create: boolean;
  update: boolean;
  destructive: boolean;
}

/** docs/spec/04-herder.md §3, "Output" */
export interface Decision {
  itemId: string;
  action: "allow" | "deny" | "answer" | "escalate";
  text?: string;
  confidence: number;
  risk: Risk;
  source: "rule" | "reviewer" | "human";
  reason: string;
  precedents: string[];
}

export interface Item {
  id: string;
  sessionId: string;
  profileId: string;
  cwd: string;
  kind: "permission" | "notification";
  state: "open" | "decided" | "expired";
  createdAt: string;
  toolCall?: ToolCallInfo;
  title: string;
  body: string;
  risk: Risk;
  decision?: Decision;
}

export type PathScope = { kind: "cwd" } | { kind: "dir"; path: string };

export interface RuleMatch {
  profileId?: string;
  eventType?: "permission";
  toolKind?: string;
  /** Glob on the normalized command. `*` matches any characters; no other syntax. */
  command?: string;
  pathScope?: PathScope;
}

export interface Rule {
  id: string;
  action: "allow" | "deny";
  match: RuleMatch;
  createdAt: string;
  createdBy: "owner" | "always-button";
}

// ---- Channels: docs/spec/05-channels.md §1 ----

export type ChannelCapability =
  | "buttons"
  | "free-text"
  | "update-message"
  | "pin"
  | "table"
  | "files";

/** Holds no secrets. Secrets are looked up by key at `start`. */
export interface ChannelBinding {
  channelId: string;
  ownerId: string;
  data: Record<string, string>;
}

export interface MessageRef {
  channelId: string;
  id: string;
}

export interface ItemOption {
  action: string;
  label: string;
}

export interface ItemView {
  kind: "item";
  itemId: string;
  taskLabel?: string;
  title: string;
  body: string;
  risk: Risk;
  options: ItemOption[];
  reason?: string;
  /** Final state shown after a decision, e.g. "Allowed by you". */
  final?: string;
  /**
   * Several approvals waiting at once, shown on one card (ADR 0056). Each line has its own
   * buttons (target: the line's itemId); `options` then holds the buttons for all of them
   * (target: this view's itemId), and title/body/reason describe the card as a whole.
   */
  lines?: ItemLine[];
}

/** One approval on a card that holds several (ADR 0056). */
export interface ItemLine {
  itemId: string;
  /** 1-based number the owner can answer with ("批 1、3"). */
  n: number;
  taskLabel?: string;
  title: string;
  body: string;
  risk: Risk;
  reason?: string;
  options: ItemOption[];
  final?: string;
}

export interface BoardRow {
  taskId: string;
  task: string;
  stage: Stage;
  project: string;
  agent: string;
  lastReport: string;
  updatedAt: string;
}

export interface BoardView {
  kind: "board";
  rows: BoardRow[];
}

export interface ReportView {
  kind: "report";
  taskId: string;
  result: ReportResult;
  title: string;
  /** Project · agent · duration, under the title. */
  subtitle?: string;
  body: string;
  /** True when the body is the agent's own summary of a longer reply. */
  summarized: boolean;
  fullReply?: string;
  /** Who wrote the full reply: the agent's name, e.g. "Pi" (ADR 0054). */
  fullReplyBy?: string;
  automaticDecisions: string[];
}

export interface RelayView {
  kind: "relay";
  taskId: string;
  taskLabel: string;
  active: boolean;
}

/**
 * How a text message looks (ADR 0036): `progress` a task's message in a relay or mid-task (blue),
 * `alarm` a watchdog alarm or switch (orange), `error` something failed (red). Without a tone and
 * without a task it is the Herder talking: no header.
 */
export type TextTone = "progress" | "alarm" | "error";

export interface TextView {
  kind: "text";
  taskLabel?: string;
  text: string;
  tone?: TextTone;
  /** Header title for an `error` without a task, e.g. "主管出错了". */
  title?: string;
  /** Buttons under the text, e.g. 「重试」. */
  options?: ItemOption[];
  /** Target of the buttons' actions, and of the answers a herd-ui `choices` offers (ADR 0074). */
  target?: string;
  /** The answer the owner picked among the reply's herd-ui choices; then none can be pressed. */
  chosen?: string;
  /** Sent as a reply to this message (an acknowledgement answers the owner's request). */
  replyTo?: MessageRef;
}

/** A question from the Herder with suggested answers. */
export interface AskView {
  kind: "ask";
  askId: string;
  text: string;
  options: ItemOption[];
  /** The answer the owner chose; the card then shows no buttons. */
  final?: string;
}

export type View = ItemView | BoardView | ReportView | RelayView | TextView | AskView;

export type Inbound =
  | { kind: "action"; target: string; action: string; text?: string; from: string }
  | {
      kind: "message";
      /** May be empty when the message is only images. */
      text: string;
      from: string;
      /** This message, so AgentHerd can reply to it. */
      ref?: MessageRef;
      replyTo?: MessageRef;
      images?: InboundImage[];
      files?: InboundFile[];
    };

/** An image the owner sent, already downloaded by the channel. */
export interface InboundImage {
  /** `image/png`, `image/jpeg`, … */
  mimeType: string;
  data: Uint8Array;
}

/** A file the owner sent (document, audio, video), already downloaded by the channel. */
export interface InboundFile {
  /** The name the owner's client gave it, e.g. `report.pdf`. */
  name: string;
  data: Uint8Array;
}

export type InboundSink = (inbound: Inbound) => void | Promise<void>;

export interface SetupUI {
  showQrCode(url: string, expiresInSeconds: number): void;
  showStatus(status: string): void;
}

export interface Channel {
  id: string;
  capabilities: ChannelCapability[];
  setup(ui: SetupUI): Promise<ChannelBinding>;
  start(binding: ChannelBinding, sink: InboundSink): Promise<void>;
  stop(): Promise<void>;
  send(view: View): Promise<MessageRef>;
  /** In place, no new notification. */
  update(ref: MessageRef, view: View): Promise<void>;
  pin(ref: MessageRef): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessageRef(value: unknown): value is MessageRef {
  return isRecord(value) && typeof value.channelId === "string" && typeof value.id === "string";
}

/** Guard for inbound data that crosses the channel boundary. */
export function isInbound(value: unknown): value is Inbound {
  if (!isRecord(value) || typeof value.from !== "string") return false;
  if (value.kind === "action") {
    return (
      typeof value.target === "string" &&
      typeof value.action === "string" &&
      (value.text === undefined || typeof value.text === "string")
    );
  }
  if (value.kind === "message") {
    return (
      typeof value.text === "string" && (value.replyTo === undefined || isMessageRef(value.replyTo))
    );
  }
  return false;
}
