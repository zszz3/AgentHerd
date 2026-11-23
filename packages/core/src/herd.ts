// The core facade (docs/spec/02-architecture.md §1). It receives a Channel; it imports no
// channel package and no Electron. The work lives in the parts it wires together:
// owner-commands.ts (inbound), relay.ts, task-runner.ts (task lifecycle and turns),
// task-report.ts (reports, alarms, stages) and permission.ts.

import { join } from "node:path";
import type { AgentProfile, Inbound, Item, Mode, Rule } from "@agentherd/protocol";
import { DEFAULT_LOCALE } from "@agentherd/protocol";
import type { OutboundStep } from "@agentherd/rules";
import { approveAppCalls } from "./app-calls.ts";
import { Board } from "./board.ts";
import { type Clock, systemClock } from "./clock.ts";
import { coreDataPaths } from "./data-home-paths.ts";
import { GitHubWatch } from "./github-watch.ts";
import {
  allTasks,
  type Following,
  type HerdContext,
  type HerdOptions,
  openTasks,
  type PromptFrom,
  type RunResult,
  saveTask,
  say,
  send,
} from "./herd-context.ts";
import {
  type FeedQuery,
  type FeedSource,
  HERDER_RETRY_TARGET,
  type HerderFactory,
  type HerderHost,
  type HerderPort,
  type OwnerImage,
} from "./herder-port.ts";
import { Inbox, type OwnerAnswer, type OwnerInputSource } from "./inbox.ts";
import { type LetterFate, Mailbox, type MailboxPatch, type MailboxSourceInput } from "./mailbox.ts";
import { type JsonRpcMessage, McpGateway } from "./mcp-gateway.ts";
import { noticeLevels, setNoticeLevel } from "./notices.ts";
import { Outbox } from "./outbox.ts";
import { OwnerCommands } from "./owner-commands.ts";
import { Registry } from "./registry.ts";
import { Relay, type RelayState } from "./relay.ts";
import type { SocialPlatform } from "./social-watch.ts";
import { SourceHealth, type SourceState } from "./source-health.ts";
import { Store, type TranscriptEntry } from "./store.ts";
import { applyReport, onAlarm, restage } from "./task-report.ts";
import { TaskRunner, unfinished } from "./task-runner.ts";
import type { Task } from "./tasks.ts";
import { type CoreTexts, coreTexts } from "./texts.ts";
import { WaitWatch } from "./waiting.ts";
import { Watchdog } from "./watchdog.ts";
import { Workspaces } from "./workspace.ts";

export type {
  AgentModels,
  HerdOptions,
  ModelLaunch,
  PromptFrom,
  RunResult,
} from "./herd-context.ts";
export { RELAY_IDLE_MINUTES, RELAY_KEY, type RelayState } from "./relay.ts";
export { SESSION_IDLE_MINUTES } from "./task-runner.ts";

/** State key: ids of tasks the last stop cut off (ADR 0040). */
export const INTERRUPTED_STATE = "tasks.interrupted";
/** Tasks named in the "continue?" question after a restart. */
export const RESUME_ASK_MAX = 5;
/** How long stopping waits for the turns it cut off to send their reports. */
const STOP_SETTLE_MS = 3000;

export class Herd {
  readonly store: Store;
  readonly registry: Registry;
  readonly board: Board;
  private readonly ctx: HerdContext;
  private readonly relays: Relay;
  private readonly runner: TaskRunner;
  private readonly owner: OwnerCommands;
  private readonly clock: Clock;
  private readonly texts: CoreTexts;
  private started = false;
  private herder: HerderPort | undefined;
  private readonly github: GitHubWatch | undefined;
  /**
   * The owner's mailbox: every outside source and every timer, when the host can look at them
   * (ADR 0099, 0100).
   */
  readonly mailbox: Mailbox | undefined;
  /** Asks about tasks that wait on the owner for long (ADR 0081). */
  readonly waits: WaitWatch;
  /** Tasks cut off by the last stop or crash, asked about once the channel is up. */
  private interrupted: string[] = [];
  private mode: Mode;

  private readonly opts: HerdOptions;

  constructor(opts: HerdOptions) {
    this.opts = opts;
    this.mode = opts.mode;
    this.texts = coreTexts(opts.locale ?? DEFAULT_LOCALE);
    this.clock = opts.clock ?? systemClock;
    const storeOptions = opts.secrets === undefined ? {} : { secrets: opts.secrets };
    this.store =
      opts.store ?? Store.open(join(opts.home, coreDataPaths.database.relative), storeOptions);
    this.registry = new Registry(this.store, this.clock);
    const inbox = new Inbox({
      channel: opts.channel,
      binding: opts.binding,
      store: this.store,
      clock: this.clock,
      ...(opts.remindMinutes === undefined ? {} : { remindMinutes: opts.remindMinutes }),
      ...(opts.timeoutMinutes === undefined ? {} : { timeoutMinutes: opts.timeoutMinutes }),
      ...(opts.secrets === undefined ? {} : { secrets: opts.secrets }),
      texts: this.texts,
      onAnswered: (item, answer, how) => this.toldApproval(item, answer, how),
    });
    this.board = new Board({
      channel: opts.channel,
      store: this.store,
      clock: this.clock,
      tasks: () => this.tasks(),
      onChange: () => {
        for (const f of this.ctx.following.values()) saveTask(this.ctx, f);
        // Set further down; a task that now waits on the owner starts the look (ADR 0081).
        this.waits?.nudge();
      },
      ...(opts.boardDebounceMs === undefined ? {} : { debounceMs: opts.boardDebounceMs }),
    });
    const watchdog = new Watchdog({
      clock: this.clock,
      onAlarm: (alarm) => void onAlarm(this.ctx, alarm),
      texts: this.texts,
      ...(opts.watchdogSeconds === undefined ? {} : { watchdogSeconds: opts.watchdogSeconds }),
      ...(opts.maxQuietMinutes === undefined ? {} : { maxQuietMinutes: opts.maxQuietMinutes }),
    });
    this.ctx = {
      opts,
      store: this.store,
      registry: this.registry,
      board: this.board,
      inbox,
      watchdog,
      clock: this.clock,
      texts: this.texts,
      following: new Map<string, Following>(),
      mcp: new McpGateway(
        (taskId, report) => {
          const f = this.ctx.following.get(taskId);
          if (f !== undefined && !f.ended) applyReport(this.ctx, f, report);
        },
        {
          ...(opts.apps === undefined ? {} : { apps: opts.apps }),
          approve: (taskId, calls) => approveAppCalls(this.ctx, taskId, calls),
          denied: (title) => this.texts.appDenied(title),
          ack: (taskId, text) => this.runner.ack(taskId, text),
        },
      ),
      outbox: new Outbox(opts.channel, this.store, this.clock),
      workspaces: new Workspaces(opts.home),
      sources: new SourceHealth(() => this.ctx, opts.sourceDownMinutes),
      herder: () => this.herder,
      mode: () => this.mode,
      github: () => this.github,
      mailbox: () => this.mailbox,
      waits: () => this.waits,
    };
    this.relays = new Relay(this.ctx);
    this.runner = new TaskRunner(this.ctx, this.relays, this);
    this.owner = new OwnerCommands(this.ctx, this.relays, this);
    this.registry.onChange((row) => {
      watchdog.waiting(row.id, row.state === "waiting-approval");
      const f = this.ctx.following.get(row.id);
      if (f !== undefined) restage(this.ctx, f);
    });
    // Tasks from before a restart stay on the board and can be continued (ADR 0039).
    // `agentherd run` beside a running host must not end or ask about that host's tasks.
    const closeStale = opts.closeStaleTasks !== false;
    const crashed = this.runner.restore(undefined, closeStale);
    const stopped = closeStale ? (this.store.getState<string[]>(INTERRUPTED_STATE) ?? []) : [];
    this.interrupted = [...new Set([...stopped, ...crashed])].filter((id) =>
      this.ctx.following.has(id),
    );
    this.mailbox =
      opts.mailbox === undefined
        ? undefined
        : new Mailbox(this.ctx, {
            check: opts.mailbox.check,
            ...(opts.mailbox.tickMs === undefined ? {} : { tickMs: opts.mailbox.tickMs }),
            ...(opts.mailbox.digestHour === undefined
              ? {}
              : { digestHour: opts.mailbox.digestHour }),
            ...(opts.mailboxChanged === undefined ? {} : { changed: opts.mailboxChanged }),
          });
    this.waits = new WaitWatch(
      this.ctx,
      {
        keep: async (taskId) => {
          await this.runner.promptTask(taskId, this.texts.waitKeepPrompt, [], "owner");
        },
        stop: (taskId, why) => this.runner.letGo(taskId, why),
      },
      opts.waitAskMinutes,
    );
    this.herder = opts.herder?.(this.herderHost());
    this.github =
      opts.github === undefined
        ? undefined
        : new GitHubWatch(this.ctx, opts.github, {
            prompt: (taskId, text) => this.runner.promptTask(taskId, text, [], "pull-request"),
          });
  }

  /** Replaces the Herder, e.g. after the owner chose another model. `undefined` turns it off. */
  /** The Herder now, if there is one. */
  herderPort(): HerderPort | undefined {
    return this.herder;
  }

  async setHerder(factory: HerderFactory | undefined): Promise<void> {
    const old = this.herder;
    this.herder = undefined;
    await old?.stop();
    this.herder = factory?.(this.herderHost());
    this.store.audit("herder.changed", { on: this.herder !== undefined });
    // What the old one had not finished is the new one's to take up (ADR 0062).
    if (this.started) this.herder?.resume?.();
  }

  hasHerder(): boolean {
    return this.herder !== undefined;
  }

  /** Agent profiles for tasks started after the change; running tasks keep theirs. */
  setProfiles(profiles: AgentProfile[]): void {
    this.opts.profiles = profiles;
  }

  getMode(): Mode {
    return this.mode;
  }

  /** Applies to permission requests that arrive after the change. */
  setMode(mode: Mode): void {
    this.mode = mode;
    this.store.audit("mode.changed", { mode });
  }

  /** Watched sources that are failing now (ADR 0050). */
  sources(): SourceState[] {
    return this.ctx.sources.list();
  }

  private herderHost(): HerderHost {
    return {
      locale: this.opts.locale ?? DEFAULT_LOCALE,
      texts: this.texts,
      userHome: this.opts.userHome,
      protectedPaths: this.opts.protectedPaths,
      protectedLocationFiles: this.opts.protectedLocationFiles,
      profiles: () =>
        this.opts.profiles.map((p) => ({
          id: p.id,
          name: p.name,
          ...(p.ownModels === true ? { ownModels: true } : {}),
        })),
      tasks: () => this.tasks(),
      openTasks: () => this.openTasks(),
      transcript: (taskId) => this.store.transcript(taskId),
      relayTaskId: () => this.relay()?.taskId,
      decisions: (limit) => this.store.recentDecisions(limit),
      models: () => this.opts.agentModels?.list() ?? [],
      apps: () => this.opts.appNames?.() ?? [],
      toolNotes: () => this.opts.toolNotes?.() ?? [],
      ...(this.opts.feeds === undefined
        ? {}
        : {
            feeds: () => this.opts.feeds?.on() ?? [],
            readFeed: (source: FeedSource, query: FeedQuery, mark: boolean) =>
              (this.opts.feeds as NonNullable<HerdOptions["feeds"]>).read(source, query, mark),
          }),
      ...(this.opts.westock === undefined
        ? {}
        : {
            westock: () => (this.opts.westock as NonNullable<HerdOptions["westock"]>).state(),
            stockQuote: (query: string) =>
              (this.opts.westock as NonNullable<HerdOptions["westock"]>).quote(query),
          }),
      ...(this.opts.danjuan === undefined
        ? {}
        : {
            danjuan: () => (this.opts.danjuan as NonNullable<HerdOptions["danjuan"]>).state(),
            fundHoldings: (query?: { days?: number; account?: string }) =>
              (this.opts.danjuan as NonNullable<HerdOptions["danjuan"]>).holdings(query),
          }),
      ...(this.opts.socials === undefined ? {} : { socialWatches: () => this.socialWatchLines() }),
      ...(this.mailbox === undefined
        ? {}
        : {
            mailboxSources: () => this.mailbox?.list() ?? [],
            addMailboxSource: (input: MailboxSourceInput) => this.needMailbox().add(input),
            changeMailboxSource: (id: string, patch: MailboxPatch) =>
              this.needMailbox().set(id, patch),
            removeMailboxSource: (id: string) => this.mailbox?.remove(id) ?? false,
            tryMailboxSource: (input: MailboxSourceInput) => this.needMailbox().tryOut(input),
            fileLetters: (items: { id: number; fate: LetterFate; why: string }[]) =>
              this.needMailbox().file(items),
          }),
      sources: () => this.ctx.sources.list(),
      checkModel: async (ref) => this.opts.agentModels?.check?.(ref) ?? { ok: true },
      startTask: async (profileId, cwd, title, prompt, model, images, allowed) => {
        const { taskId, turn } = await this.startTask(
          profileId,
          cwd,
          title,
          prompt,
          model,
          images,
          allowed,
          "herder",
        );
        turn.catch(() => {});
        return taskId;
      },
      promptTask: (taskId, text, images) =>
        void this.promptTask(taskId, text, images, "herder").catch(() => {}),
      renameTask: (taskId, name) => this.runner.renameTask(taskId, name),
      cancelTurn: (taskId) => this.cancelTurn(taskId),
      endTask: (taskId) => this.endTask(taskId, this.texts.endedByOwner),
      startRelay: (taskId) => this.relays.start(taskId),
      endRelay: () => this.relays.end("ended by the Herder"),
      say: (text) => this.owner.herderSays(text),
      ask: (text, options) => this.owner.ask(text, options),
      alert: (text, retry) =>
        send(this.ctx, {
          kind: "text",
          text,
          tone: "error",
          ...(retry
            ? {
                target: HERDER_RETRY_TARGET,
                options: [{ action: "retry", label: this.texts.retry }],
              }
            : {}),
        }),
      noticeLevels: () => noticeLevels(this.store),
      setNoticeLevel: (kind, level) => setNoticeLevel(this.store, kind, level),
      audit: (type, data) => this.store.audit(type, data),
      recordRequest: (request) => this.store.addHerderRequest(request),
      recordTurn: (role, text, taskId) => {
        this.store.addHerderTurn(role, text, taskId);
        this.opts.herderTurnAdded?.();
      },
      ...(this.opts.suggestion === undefined ? {} : { suggestion: this.opts.suggestion }),
      ...(this.opts.plugins === undefined ? {} : { plugins: this.opts.plugins }),
      memory: this.store.memory,
      ...(this.opts.embedder === undefined ? {} : { embedder: this.opts.embedder }),
      ...(this.opts.memoryComplete === undefined
        ? {}
        : { memoryComplete: this.opts.memoryComplete }),
      getState: (key) => this.store.getState(key),
      setState: (key, value) => this.store.setState(key, value),
      herderLog: () => this.store.herderLog(),
      writeHerderLog: (from, messages) => this.store.writeHerderLog(from, messages),
      herderFolds: () => this.store.herderFolds(),
      saveHerderContext: (key, state, folds) => this.store.saveHerderContext(key, state, folds),
      recordPrompt: (prompt) => this.store.putHerderPrompt(prompt),
      herderEvent: (kind, data, round) => this.store.addHerderEvent(kind, data, round),
    };
  }

  /**
   * One message from a task's `agentherd` MCP server. Throws `UnknownTokenError` for a token no
   * running task holds.
   */
  mcp(token: string, msg: JsonRpcMessage): Promise<JsonRpcMessage | undefined> {
    return this.ctx.mcp.handle(token, msg);
  }

  /** All tasks this Herd follows or followed. */
  tasks(): Task[] {
    return allTasks(this.ctx);
  }

  /** A task's conversation; `live` is reply text still being written. */
  transcript(taskId: string): { entries: TranscriptEntry[]; live: string } {
    const f = this.ctx.following.get(taskId);
    return { entries: this.store.transcript(taskId), live: f?.ended ? "" : (f?.pending ?? "") };
  }

  /** Tasks whose agent is still running. */
  openTasks(): Task[] {
    return openTasks(this.ctx);
  }

  /** The active relay, if its task is still open. */
  relay(): RelayState | undefined {
    return this.relays.current();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // Agents are not running after a restart, so an old relay points at nothing.
    const relay = this.relays.stored();
    this.relays.reset();
    // The pet wrapper marks its local injections; the channel adapters only pass the inbound.
    await this.opts.channel.start(
      this.opts.binding,
      (inbound, source: OwnerInputSource = "channel") => this.owner.handle(inbound, source),
    );
    this.store.audit("herd.started", { mode: this.mode, channel: this.opts.channel.id });
    // What the last run could not send goes out now.
    this.ctx.outbox.start();
    this.github?.start();
    this.mailbox?.start();
    // A one-off run beside a host leaves that host's tasks alone.
    if (this.opts.closeStaleTasks !== false) this.waits.start();
    await this.endOldRelay(relay?.taskId);
    await this.askToResume();
    // The owner's messages the last run had not finished are taken up now (ADR 0062).
    this.herder?.resume?.();
    if (this.opts.closeStaleTasks !== false) {
      void this.runner.cleanupWorkspaces().catch((error: Error) => {
        this.store.audit("workspace.error", { step: "cleanup", message: error.message });
      });
    }
  }

  /** A relay the last run left open points at an agent that is gone: show it ended. */
  private async endOldRelay(taskId: string | undefined): Promise<void> {
    if (taskId === undefined || !this.interrupted.includes(taskId)) return;
    const task = this.ctx.following.get(taskId)?.task;
    if (task === undefined) return;
    await send(this.ctx, { kind: "relay", taskId, taskLabel: task.title, active: false });
  }

  /**
   * Tasks cut off by the last stop or crash: the Herder asks the owner whether to continue them,
   * with buttons. Its answer goes to the Herder, which continues them with session_prompt. Never
   * restarted on their own. Without a Herder nobody could act on the answer, so nothing is asked.
   */
  private async askToResume(): Promise<void> {
    const ids = this.interrupted;
    this.interrupted = [];
    if (ids.length === 0) return;
    this.store.setState(INTERRUPTED_STATE, []);
    const tasks = ids
      .map((id) => this.ctx.following.get(id)?.task)
      .filter((t): t is Task => t !== undefined)
      .slice(0, RESUME_ASK_MAX);
    if (tasks.length === 0) return;
    const t = this.texts;
    if (this.herder === undefined) {
      // Nobody could act on an answer, but the owner still learns what was cut off.
      await say(this.ctx, t.interruptedTasks(tasks.map((task) => task.title)));
      return;
    }
    const options =
      tasks.length === 1
        ? [t.resumeYes, t.resumeNo]
        : [t.resumeAll, t.resumeNo, ...tasks.slice(0, 2).map((task) => t.resumeOnly(task.title))];
    const lines = tasks.map((task) => `- ${task.title}（${task.project} · ${task.agent}）`);
    await this.owner.ask(t.resumeQuestion(lines.join("\n")), [...options, t.otherOption]);
    this.store.audit("tasks.resume-asked", { taskIds: tasks.map((task) => task.id) });
  }

  /** Direct injection does not establish channel provenance. */
  handle(inbound: Inbound): Promise<void> {
    return this.owner.handle(inbound, "local");
  }

  addRule(rule: Rule): void {
    this.store.insertRule(rule);
  }

  /**
   * Starts an agent for a task, runs the owner's prompt to the end of the turn, sends the
   * completion report, then closes the agent. The task stays on the board.
   */
  async run(profileId: string, cwd: string, prompt: string): Promise<RunResult> {
    const { taskId, turn } = await this.startTask(profileId, cwd, prompt);
    try {
      return await turn;
    } finally {
      await this.endTask(taskId, this.texts.runFinished);
    }
  }

  /**
   * Starts an agent and a session for a task and sends the owner's text as the first prompt.
   * Returns once the session exists; `turn` settles when the first turn ends.
   */
  startTask(
    profileId: string,
    cwd: string | undefined,
    ownerText: string,
    prompt: string = ownerText,
    model?: string,
    images?: OwnerImage[],
    allowed?: readonly OutboundStep[],
    from: PromptFrom = "owner",
  ): Promise<{ taskId: string; turn: Promise<RunResult> }> {
    return this.runner.startTask(profileId, cwd, ownerText, prompt, model, images, allowed, from);
  }

  /**
   * Sends a prompt to an open task. Queued while a turn runs; settles when its turn ends.
   * `from` says who sent it, which decides what reaches the owner's phone (ADR 0061).
   */
  promptTask(
    taskId: string,
    text: string,
    images?: OwnerImage[],
    from: PromptFrom = "owner",
  ): Promise<RunResult> {
    return this.runner.promptTask(taskId, text, images, from);
  }

  /** Cancels the current turn of a task, then sends the text as the next prompt. */
  interruptTask(
    taskId: string,
    text: string,
    images?: OwnerImage[],
    from: PromptFrom = "owner",
  ): Promise<RunResult> {
    return this.runner.interruptTask(taskId, text, images, from);
  }

  /** Cancels the current turn of a task, if one is running. */
  cancelTurn(taskId: string): Promise<void> {
    return this.runner.cancelTurn(taskId);
  }

  /** Closes the agent of a task. The task stays on the board. */
  endTask(taskId: string, why: string): Promise<void> {
    return this.runner.endTask(taskId, why);
  }

  /**
   * The owner stopped a task from the app (ADR 0072): the same as telling the Herder it is
   * finished. Its agent stops; the task stays and can be continued.
   */
  async stopTask(taskId: string): Promise<void> {
    if (!this.tasks().some((t) => t.id === taskId)) throw new Error(`no task ${taskId}`);
    // Also a task that ended while it waited on the owner stops waiting (ADR 0081).
    await this.runner.letGo(taskId, this.texts.endedByOwner);
  }

  /** Looks at the tasks that wait on the owner now (tests). */
  checkWaiting(): Promise<void> {
    return this.waits.check();
  }

  private needMailbox(): Mailbox {
    if (this.mailbox === undefined) throw new Error("there is no mailbox here");
    return this.mailbox;
  }

  /** Looks at every due mailbox source now and delivers what came. For tests. */
  checkMailbox(): Promise<void> {
    return this.mailbox?.tick() ?? Promise.resolve();
  }

  /**
   * Turned-on platforms for the Herder: whether each is signed in, and whether the mailbox tells
   * the owner about its comments and mentions (ADR 0100).
   */
  private socialWatchLines(): {
    platform: SocialPlatform;
    name: string;
    ready: boolean;
    watch: { mentions: boolean };
  }[] {
    const sources = this.mailbox?.list() ?? [];
    return (this.opts.socials?.() ?? []).map((s) => ({
      platform: s.platform,
      name: s.name,
      ready: s.ready(),
      watch: {
        mentions: sources.some(
          (m) => m.kind === "social" && m.config.platform === s.platform && !m.paused,
        ),
      },
    }));
  }

  /** Puts the task's version of the files both it and the owner changed into the project. */
  takeTaskVersion(taskId: string): Promise<void> {
    return this.runner.takeTaskVersion(taskId);
  }

  /** Tells the Herder how an approval card was answered, so it can offer to keep it (ADR 0057). */
  private toldApproval(item: Item, answer: OwnerAnswer, how: "owner" | "skip" | "timeout"): void {
    const task = this.ctx.following.get(item.sessionId)?.task;
    this.herder?.event({
      kind: "approval",
      ...(task === undefined ? {} : { taskId: task.id }),
      title: task?.title ?? item.title,
      text: item.title,
      outcome:
        how === "timeout"
          ? "timed out"
          : how === "skip"
            ? "skipped"
            : answer === "allow"
              ? "allowed"
              : "refused",
    });
  }

  async stop(): Promise<void> {
    await this.herder?.stop();
    this.board.stop();
    this.ctx.watchdog.stop();
    this.relays.stop();
    // Remember what was cut off, so the next start can ask whether to continue it.
    const cut = [...this.ctx.following.values()]
      .filter((f) => !f.ended && unfinished(f))
      .map((f) => f.task.id);
    if (cut.length > 0 && this.started) {
      const titles = cut.map((id) => this.ctx.following.get(id)?.task.title ?? id);
      await say(this.ctx, this.texts.stoppingTasks(titles));
    }
    for (const f of this.ctx.following.values()) {
      if (!f.ended) await this.endTask(f.task.id, this.texts.agentherdStopped);
    }
    await this.runner.settle(STOP_SETTLE_MS);
    if (cut.length > 0) this.store.setState(INTERRUPTED_STATE, cut);
    await this.ctx.inbox.stop();
    this.ctx.outbox.stop();
    this.github?.stop();
    this.mailbox?.stop();
    this.waits.stop();
    if (this.started) await this.opts.channel.stop();
    this.store.audit("herd.stopped", {});
    if (this.opts.store === undefined) this.store.close();
  }
}
