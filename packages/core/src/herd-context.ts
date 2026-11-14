// Shared state and small helpers for the parts of the Herd (see herd.ts).

import type { AgentConnection, StdioMcpServer } from "@agentherd/acp-client";
import type {
  AgentProfile,
  Channel,
  ChannelBinding,
  HerderStyle,
  Locale,
  MessageRef,
  Mode,
  TextTone,
  TextView,
  View,
} from "@agentherd/protocol";
import type { ExtraGuard, OutboundStep } from "@agentherd/rules";
import type { Board } from "./board.ts";
import type { Clock, Timer } from "./clock.ts";
import type { GitHubOptions, GitHubWatch } from "./github-watch.ts";
import type {
  FeedItem,
  FeedQuery,
  FeedSource,
  HerderFactory,
  HerderPort,
  OwnerImage,
} from "./herder-port.ts";
import type { Inbox } from "./inbox.ts";
import type { Intake } from "./intake.ts";
import type { AppTools, HerdReport, McpGateway } from "./mcp-gateway.ts";
import type { Completer, Embedder } from "./memory-store.ts";
import type { Outbox } from "./outbox.ts";
import type { Registry } from "./registry.ts";
import type { SocialSource } from "./social-watch.ts";
import type { SourceHealth } from "./source-health.ts";
import type { Store } from "./store.ts";
import type { Task } from "./tasks.ts";
import type { CoreTexts } from "./texts.ts";
import type { Watchdog } from "./watchdog.ts";
import type { TaskWorkspace, Workspaces } from "./workspace.ts";

export interface HerdOptions {
  /** AgentHerd home (`AGENTHERD_HOME` or `~/.agentherd`). `herd.db` lives here. */
  home: string;
  /** The user's home directory, for `~` in commands and rules. */
  userHome: string;
  channel: Channel;
  binding: ChannelBinding;
  mode: Mode;
  profiles: AgentProfile[];
  clock?: Clock;
  /**
   * On start, end tasks an earlier run left running and tell the owner (docs/spec/03-agents.md
   * "Restarts"). Default true; false for a one-off run that may share herd.db with a host.
   */
  closeStaleTasks?: boolean;
  /**
   * Run each task in a git project in a copy of its own, synced with the project folder every turn
   * (ADR 0043). Default true; false runs agents in the folder itself (`agentherd run`).
   */
  taskCopies?: boolean;
  remindMinutes?: number;
  /** Approvals nobody answers close as not done after this many minutes (ADR 0056; default 60). */
  timeoutMinutes?: number;
  extraGuards?: ExtraGuard[];
  /** Values to redact everywhere (secrets from env). */
  secrets?: Record<string, string>;
  /** Use this store instead of `<home>/herd.db` (tests pass `:memory:`). */
  store?: Store;
  /** Words in a report body (ADR 0049); default OWNER_WORDS_MAX. */
  reportMaxWords?: number;
  replyHintChars?: number;
  watchdogSeconds?: number;
  maxQuietMinutes?: number;
  boardDebounceMs?: number;
  relayIdleMinutes?: number;
  sessionIdleMinutes?: number;
  /** Minutes before an agent with work running in the background is asked about it. */
  backgroundCheckMinutes?: number;
  /** Language of the texts the owner reads. Default: Chinese. */
  locale?: Locale;
  /** How the Herder talks (ADR 0053): read on every Herder turn, set when the owner asks in chat. */
  herderStyle?: { get(): HerderStyle; set(style: HerderStyle): void };
  /** Creates the Herder. Without it, plain messages get the list of commands. */
  herder?: HerderFactory;
  /** Models a task can run with. Without it, agents use their own settings. */
  agentModels?: AgentModels;
  /** Vectors for the Herder's memory search (ADR 0038). */
  embedder?: Embedder;
  /** A cheap model the Herder uses to rank past cases. */
  memoryComplete?: Completer;
  /**
   * The stdio MCP server that reaches this Herd's gateway with the given task token
   * (docs/spec/09-agent-tools.md §1). Without it, agents get no MCP servers.
   */
  mcpServer?: (token: string) => StdioMcpServer;
  /** The owner's connected apps, if any (docs/spec/09-agent-tools.md §3). Read on every call. */
  apps?: () => AppTools | undefined;
  /** Names of the owner's connected apps, for the Herder (e.g. ["Gmail"]). */
  appNames?: () => string[];
  /** Minutes between two looks for new work (ADR 0052). */
  intakePollMinutes?: number;
  /** Minutes between two looks at the owner's mail watches (ADR 0048). */
  mailPollMinutes?: number;
  /** The owner's 小红书 and 知乎 accounts the host has turned on (ADR 0058). Read on every look. */
  socials?: () => readonly SocialSource[];
  /** Public news sources (ADR 0059). */
  feeds?: {
    on(): readonly FeedSource[];
    read(source: FeedSource, query: FeedQuery, mark: boolean): Promise<FeedItem[]>;
  };
  /** Lines every new task gets about tools on this Mac (ADR 0059). Read on every task. */
  toolNotes?: () => string[];
  /** Minutes between two looks at those accounts (default 20, give or take 5). */
  socialPollMinutes?: number;
  /** Called when watched things change, for the app. */
  watchesChanged?: () => void;
  /** A watched source failing this long is told to the owner (default 30, ADR 0050). */
  sourceDownMinutes?: number;
  /**
   * Follows pull requests tasks open on GitHub with `gh` (ADR 0047). Without it,
   * nothing is followed.
   */
  github?: GitHubOptions;
}

/** How an agent's launch changes to run one model: env added, arguments appended. */
export interface ModelLaunch {
  env: Record<string, string>;
  args?: string[];
}

/** The agent's profile with a model's launch applied. */
export function withModel(profile: AgentProfile, launch: ModelLaunch): AgentProfile {
  return {
    ...profile,
    command: [...profile.command, ...(launch.args ?? [])],
    env: { ...profile.env, ...launch.env },
  };
}

/** The owner's models and how an agent runs one (ADR 0025). Supplied by the host. */
export interface AgentModels {
  /** Models in the owner's list ("service/model"), with the profile ids that can run each. */
  list(): { ref: string; agents: string[] }[];
  /** The env and extra arguments that make the agent use the model. Throws when it cannot. */
  launchFor(profileId: string, ref: string): ModelLaunch;
  /** Whether the model answers now (a short test call, may be cached). */
  check?(ref: string): Promise<{ ok: true } | { ok: false; message: string }>;
  /**
   * The agent and model to switch to when `failed` broke a turn (or the agent's start) before it
   * did anything, skipping `tried` models. The same model in another agent counts (ADR 0031: Codex
   * falls back to Pi). Undefined when none answers.
   */
  next?(
    profileId: string,
    failed: string,
    tried: readonly string[],
  ): Promise<{ profileId: string; model: string } | undefined>;
}

/** Per-task state that only the Herd and its listeners use. */
export interface Following {
  task: Task;
  profile: AgentProfile;
  /** Where the agent runs: the task's copy, its folder, or its scratch folder. */
  cwd: string;
  /** Where the task works and how it syncs with the project (ADR 0043). */
  workspace?: TaskWorkspace;
  alarm: boolean;
  finished: boolean;
  /** The session was in `error` at some point; the task stays failed. */
  failed: boolean;
  ended: boolean;
  /** Why the task ended, once it has. */
  endedWhy?: string;
  /** When the task ended, once it has. */
  endedAt?: string;
  /**
   * The agent was restarted on a new session for an old task (ADR 0039); the next prompt carries
   * the earlier conversation.
   */
  needsHistory?: boolean;
  /**
   * AgentHerd went away (a stop or a crash) while the task was in the middle of its work: its next
   * prompt asks it to check what is already done before going on (ADR 0062).
   */
  cutOff?: boolean;
  /** Set while an ended task is being started again. */
  reopening?: Promise<void>;
  /** The agent's last `herd_report` in the current turn. */
  report?: HerdReport;
  /** Tool calls of the turn when `report` came: later calls mean the agent went on working. */
  reportAt?: number;
  /** The report already sent to the owner when it came (waiting, blocked, failed). */
  notified?: HerdReport;
  /** The agent sent its `herd_ack` line in this turn. */
  acked?: boolean;
  /** The owner's message that asked for the current turn; the ack replies to it. */
  trigger?: MessageRef;
  /**
   * Who asked for the current turn (or the first one, before it runs). It decides whether the
   * turn's lines reach the owner's phone or only the task board (ADR 0061).
   */
  turnFrom?: PromptFrom;
  /** The current turn is AgentHerd's own check on background work. */
  waking?: boolean;
  /** The turn ended with work still running in the background: checks so far, the next one. */
  background?: { checks: number; timer?: Timer };
  /** Text and tool calls of the current turn. */
  turn: { text: string; toolCalls: number };
  /** Reply text since the last tool call, not yet in the transcript. */
  pending?: string;
  /** Turns that ended normally; a model switch only happens before the first. */
  turnsEnded?: number;
  /** Models this task already ran into an error with. */
  triedModels?: string[];
  /** Agent or model switches so far. */
  switches?: number;
  /** Turns the owner asked for (not AgentHerd's background checks); more than one may mean a correction. */
  ownerTurns?: number;
  connection?: AgentConnection;
  agentSessionId?: string;
  offs: (() => void)[];
  /** Prompts waiting for the current turn to end. */
  queue: QueuedPrompt[];
  /** Messages the current turn read while it ran (ADR 0063); they settle when it ends. */
  steered?: QueuedPrompt[];
  busy: boolean;
  idleTimer?: Timer;
}

/**
 * Who a prompt for a task comes from (ADR 0061): the owner writing to the task, the Herder (for
 * the owner), or AgentHerd waking the task about its pull request.
 */
export type PromptFrom = "owner" | "herder" | "pull-request";

export interface QueuedPrompt {
  text: string;
  images: OwnerImage[];
  /** Who sent it; the owner when not set. */
  from?: PromptFrom;
  /** AgentHerd's own prompt asking about background work, not the owner's. */
  wake?: boolean;
  /** The owner's message this prompt answers. */
  trigger?: MessageRef;
  /**
   * It was given to a running turn that ended before reading it (ADR 0063); it goes before the
   * prompts that came after it.
   */
  late?: boolean;
  resolve: (result: RunResult) => void;
  reject: (error: Error) => void;
}

/**
 * Whether a prompt goes into the task's running turn instead of waiting for it to end (ADR 0063):
 * the owner's or the Herder's, while a turn that is not AgentHerd's own check runs on an agent
 * that takes messages during a turn.
 */
export function steerable(f: Following, from: PromptFrom): boolean {
  return (
    from !== "pull-request" &&
    f.busy &&
    f.waking !== true &&
    !f.ended &&
    f.reopening === undefined &&
    f.connection?.steers === true &&
    f.agentSessionId !== undefined
  );
}

export interface RunResult {
  sessionId: string;
  stopReason: string;
}

/** What the parts of the Herd share. The Herd owns it; the parts only read the fields. */
export interface HerdContext {
  readonly opts: HerdOptions;
  readonly store: Store;
  readonly registry: Registry;
  readonly board: Board;
  readonly inbox: Inbox;
  readonly watchdog: Watchdog;
  readonly clock: Clock;
  readonly texts: CoreTexts;
  readonly following: Map<string, Following>;
  /** Task tokens and answers for the agents' `agentherd` MCP server. */
  readonly mcp: McpGateway;
  /** Messages for the owner, stored until the channel took them. */
  readonly outbox: Outbox;
  readonly workspaces: Workspaces;
  /** Whether the watched sources (GitHub, Gmail) still answer. */
  readonly sources: SourceHealth;
  /** Pull requests tasks opened, when `github` is set. */
  github(): GitHubWatch | undefined;
  /** New work the owner asked to be offered, when `github` is set (ADR 0052). */
  intake(): Intake | undefined;
  /** The current Herder, if any. It can change at runtime. */
  herder(): HerderPort | undefined;
  /** The current mode. It can change at runtime. */
  mode(): Mode;
  /** The owner's latest message, until a task's prompt takes it as its trigger. */
  ownerMessage?: { ref: MessageRef; at: number };
}

/**
 * The task methods of the Herd. The parts call them through the Herd, not directly, so the
 * Herd stays the one entry point (tests and callers may wrap its methods).
 */
export interface TaskOps {
  startTask(
    profileId: string,
    cwd: string | undefined,
    ownerText: string,
    prompt?: string,
    model?: string,
    images?: OwnerImage[],
    allowed?: readonly OutboundStep[],
    from?: PromptFrom,
  ): Promise<{ taskId: string; turn: Promise<RunResult> }>;
  promptTask(
    taskId: string,
    text: string,
    images?: OwnerImage[],
    from?: PromptFrom,
  ): Promise<RunResult>;
  interruptTask(
    taskId: string,
    text: string,
    images?: OwnerImage[],
    from?: PromptFrom,
  ): Promise<RunResult>;
  endTask(taskId: string, why: string): Promise<void>;
  /** Puts the task's version of the files both it and the owner changed into the project. */
  takeTaskVersion(taskId: string): Promise<void>;
}

/** All tasks the Herd follows or followed, as copies. */
export function allTasks(ctx: HerdContext): Task[] {
  return [...ctx.following.values()].map((f) => ({
    ...f.task,
    automaticDecisions: [...f.task.automaticDecisions],
  }));
}

/** Saves a task to herd.db so it outlives a restart (ADR 0039). A failure is audited. */
export function saveTask(ctx: HerdContext, f: Following): void {
  try {
    ctx.store.saveTask({
      task: f.task,
      cwd: f.cwd,
      profileId: f.profile.id,
      failed: f.failed,
      ...(f.endedAt === undefined ? {} : { endedAt: f.endedAt }),
      ...(f.endedWhy === undefined ? {} : { endedWhy: f.endedWhy }),
      ...(f.agentSessionId === undefined ? {} : { agentSessionId: f.agentSessionId }),
      ...(f.workspace === undefined ? {} : { workspace: f.workspace }),
    });
  } catch (error) {
    ctx.store.audit("task.save-error", { taskId: f.task.id, message: (error as Error).message });
  }
}

/** Tasks whose agent is still running. */
export function openTasks(ctx: HerdContext): Task[] {
  return allTasks(ctx).filter((t) => ctx.following.get(t.id)?.ended === false);
}

export async function say(
  ctx: HerdContext,
  text: string,
  taskLabel?: string,
  tone?: TextTone,
  taskId?: string,
  replyTo?: MessageRef,
): Promise<void> {
  const view: TextView = { kind: "text", text };
  if (taskLabel !== undefined) view.taskLabel = taskLabel;
  if (tone !== undefined) view.tone = tone;
  if (replyTo !== undefined) view.replyTo = replyTo;
  await send(ctx, view, taskId);
}

/**
 * Sends a view through the outbox: a failure is retried, never thrown. A message about a task (a
 * report, a relay view, or `taskId` given) is remembered, so the owner's reply to it goes to that
 * task (ADR 0043).
 */
export async function send(ctx: HerdContext, view: View, taskId?: string): Promise<void> {
  const about =
    taskId ?? (view.kind === "report" || view.kind === "relay" ? view.taskId : undefined);
  await ctx.outbox.send(view, about);
}

export function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.length <= 80 ? line : `${line.slice(0, 79)}…`;
}
