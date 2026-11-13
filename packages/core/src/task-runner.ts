// Task lifecycle: start an agent, run prompts one turn at a time, end the task.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { type AgentConnection, type StdioMcpServer, startAgent } from "@agentherd/acp-client";
import type { AgentProfile, MessageRef } from "@agentherd/protocol";
import type { OutboundStep } from "@agentherd/rules";
import {
  type Following,
  firstLine,
  type HerdContext,
  type RunResult,
  saveTask,
  say,
  send,
  type TaskOps,
  withModel,
} from "./herd-context.ts";
import type { OwnerImage } from "./herder-port.ts";
import { LESSON_JOB } from "./memory-store.ts";
import { ACK_WORDS_MAX, tooLong } from "./owner-text.ts";
import { onPermission } from "./permission.ts";
import type { Relay } from "./relay.ts";
import { REPLY_HINT_CHARS, replyHint } from "./report.ts";
import type { TranscriptEntry } from "./store.ts";
import { askSummary, flushReply, sendReport, setReport } from "./task-report.ts";
import { projectName, taskTitle } from "./tasks.ts";
import type { CoreTexts } from "./texts.ts";
import type { TaskWorkspace } from "./workspace.ts";

export const SESSION_IDLE_MINUTES = 60;
/** Minutes between checks on work an agent left running in the background. */
export const BACKGROUND_CHECK_MINUTES = 5;
/** Checks before the task is reported anyway (about half an hour). */
export const BACKGROUND_MAX_CHECKS = 6;

/** An owner's message this old no longer counts as the request a new turn answers. */
export const OWNER_MESSAGE_FRESH_MS = 5 * 60_000;
/** At most this many models are tried for one task before it fails. */
export const MAX_MODEL_SWITCHES = 3;
/** Saved tasks loaded when AgentHerd starts (ADR 0039). */
export const TASKS_RESTORED = 50;
/** Characters of the earlier conversation given to an agent that could not open its session. */
export const HISTORY_MAX_CHARS = 8000;
/** Target of the 「用任务的版本」 button, followed by the task id (ADR 0043). */
export const WORKSPACE_TARGET = "workspace:";

/**
 * The `agentherd` MCP server for a new or loaded session, with a fresh token for the task
 * (docs/spec/09-agent-tools.md §1). None when the host has no gateway or the profile opts out.
 */
function mcpServers(ctx: HerdContext, f: Following): StdioMcpServer[] {
  const make = ctx.opts.mcpServer;
  if (make === undefined || f.profile.mcp === false) return [];
  return [make(ctx.mcp.register(f.task.id))];
}

export class TaskRunner {
  private readonly ctx: HerdContext;
  private readonly relay: Relay;
  private readonly ops: TaskOps;
  /** Turns running now, so stopping can wait for their reports. */
  private readonly turns = new Set<Promise<unknown>>();

  constructor(ctx: HerdContext, relay: Relay, ops: TaskOps) {
    this.ctx = ctx;
    this.relay = relay;
    this.ops = ops;
  }

  /**
   * Starts an agent and a session for a task and sends the owner's text as the first prompt.
   * Returns once the session exists; `turn` settles when the first turn ends.
   */
  async startTask(
    profileId: string,
    cwd: string | undefined,
    ownerText: string,
    prompt: string = ownerText,
    model?: string,
    images: OwnerImage[] = [],
    allowed: readonly OutboundStep[] = [],
  ): Promise<{ taskId: string; turn: Promise<RunResult> }> {
    const { ctx } = this;
    const found = ctx.opts.profiles.find((p) => p.id === profileId);
    if (found === undefined) throw new Error(`unknown agent profile "${profileId}"`);
    model = await this.configuredModel(profileId, model);
    let profile = found;
    if (model !== undefined) {
      if (ctx.opts.agentModels === undefined) throw new Error("no model list to choose from");
      profile = withModel(found, ctx.opts.agentModels.launchFor(profileId, model));
    }
    const sessionId = randomUUID();
    const workspace = await this.workspaceFor(sessionId, cwd);
    const now = ctx.clock.now().toISOString();
    const f: Following = {
      task: {
        id: sessionId,
        title: taskTitle(ownerText),
        project:
          workspace.kind === "scratch"
            ? ctx.texts.noProject
            : projectName(workspace.project ?? workspace.cwd),
        agent: model === undefined ? profile.name : `${profile.name} · ${model}`,
        ...(model === undefined ? {} : { model }),
        stage: "queued",
        lastReport: ctx.texts.starting,
        startedAt: now,
        updatedAt: now,
        automaticDecisions: [],
        ...(allowed.length === 0 ? {} : { allowedSteps: [...new Set(allowed)] }),
      },
      profile,
      cwd: workspace.cwd,
      workspace,
      alarm: false,
      finished: false,
      failed: false,
      ended: false,
      turn: { text: "", toolCalls: 0 },
      offs: [],
      queue: [],
      busy: false,
    };
    ctx.following.set(sessionId, f);
    // Pull requests the owner names in the request are followed for this task (ADR 0051).
    ctx.github()?.handed(sessionId, prompt === ownerText ? ownerText : `${ownerText}\n${prompt}`);
    ctx.registry.add(sessionId, profile.id, f.cwd);
    ctx.board.changed();

    try {
      const connection = await startAgent(profile, { cwd: f.cwd });
      f.connection = connection;
      f.agentSessionId = await connection.newSession(f.cwd, mcpServers(ctx, f));
    } catch (error) {
      const message = (error as Error).message;
      await f.connection?.close().catch(() => {});
      delete f.connection;
      if (await this.switchModel(f, message)) {
        this.started(f, model);
        return { taskId: sessionId, turn: this.ops.promptTask(sessionId, prompt, images) };
      }
      setReport(ctx, f, ctx.texts.couldNotStart(message));
      ctx.registry.set(sessionId, "error");
      await sendReport(ctx, f, ctx.texts.couldNotStartBody(message), null);
      await this.ops.endTask(sessionId, ctx.texts.agentCouldNotStart);
      throw error;
    }
    this.listen(f, f.connection, f.agentSessionId);
    this.started(f, model);
    return { taskId: sessionId, turn: this.ops.promptTask(sessionId, prompt, images) };
  }

  /** Hosts with a model list never launch an agent with its native defaults. */
  private async configuredModel(profileId: string, asked?: string): Promise<string | undefined> {
    const models = this.ctx.opts.agentModels;
    // Bare core integrations without a model provider retain their existing contract.
    if (models === undefined) {
      if (asked !== undefined) throw new Error("no model list to choose from");
      return undefined;
    }
    if (asked !== undefined) {
      if (!models.list().some((m) => m.ref === asked && m.agents.includes(profileId))) {
        throw new Error(`cannot run ${asked} with ${profileId}: not in the configured model list`);
      }
      return asked;
    }
    for (const choice of models.list()) {
      if (!choice.agents.includes(profileId)) continue;
      if (models.check !== undefined && !(await models.check(choice.ref)).ok) continue;
      return choice.ref;
    }
    throw new Error(
      `no configured model available for ${profileId}; configure a model in AgentHerd`,
    );
  }

  /**
   * Where a new task works (ADR 0043): a copy of a git project, the folder itself, or a scratch
   * folder. A copy that cannot be made falls back to the folder itself.
   */
  private async workspaceFor(taskId: string, cwd: string | undefined): Promise<TaskWorkspace> {
    const { ctx } = this;
    try {
      return await ctx.workspaces.create(taskId, cwd, { inplace: ctx.opts.taskCopies === false });
    } catch (error) {
      ctx.store.audit("workspace.error", {
        taskId,
        step: "create",
        message: (error as Error).message,
      });
      if (cwd === undefined) throw error;
      return { kind: "inplace", cwd, project: cwd };
    }
  }

  /** Before a turn: the owner's newer changes go into the task's copy. */
  private async syncIn(f: Following): Promise<void> {
    const ws = f.workspace;
    if (ws?.kind !== "copy" || ws.root === undefined || !existsSync(ws.root)) return;
    try {
      await this.ctx.workspaces.beforeTurn(ws);
    } catch (error) {
      this.ctx.store.audit("workspace.error", {
        taskId: f.task.id,
        step: "before-turn",
        message: (error as Error).message,
      });
    }
  }

  /**
   * After a turn: the task's changes go into the project folder.
   * @returns files both changed, whose task version was not put in.
   */
  private async syncOut(f: Following): Promise<string[]> {
    const { ctx } = this;
    const ws = f.workspace;
    if (ws?.kind !== "copy" || ws.root === undefined || !existsSync(ws.root)) return [];
    try {
      const { applied, conflicts } = await ctx.workspaces.afterTurn(ws, f.task.id);
      if (applied.length > 0 || conflicts.length > 0) {
        ctx.store.audit("workspace.synced", { taskId: f.task.id, applied, conflicts });
      }
      saveTask(ctx, f);
      return conflicts;
    } catch (error) {
      const message = (error as Error).message;
      ctx.store.audit("workspace.error", { taskId: f.task.id, step: "after-turn", message });
      await say(ctx, ctx.texts.workspaceSyncFailed(message), f.task.title, "error", f.task.id);
      return [];
    }
  }

  /** Tells the owner which files kept their version, with a button for the task's. */
  private async tellConflicts(f: Following, files: string[]): Promise<void> {
    if (files.length === 0) return;
    const { ctx } = this;
    await send(
      ctx,
      {
        kind: "text",
        text: ctx.texts.workspaceConflict(files),
        taskLabel: f.task.title,
        tone: "alarm",
        target: `${WORKSPACE_TARGET}${f.task.id}`,
        options: [{ action: "take-task", label: ctx.texts.useTaskVersion }],
      },
      f.task.id,
    );
  }

  /** The owner chose the task's version of the files both changed. */
  async takeTaskVersion(taskId: string): Promise<void> {
    const { ctx } = this;
    const f = ctx.following.get(taskId);
    const ws = f?.workspace;
    if (f === undefined || ws === undefined || (ws.conflicts ?? []).length === 0) return;
    const files = await ctx.workspaces.takeTask(ws);
    saveTask(ctx, f);
    ctx.store.audit("workspace.took-task", { taskId, files });
    await say(ctx, ctx.texts.tookTaskVersion(files), f.task.title, undefined, taskId);
  }

  /** At the end of a task: copies back what is left and removes its copy. */
  private async closeWorkspace(f: Following): Promise<void> {
    const ws = f.workspace;
    if (ws?.kind !== "copy") return;
    await this.tellConflicts(f, await this.syncOut(f));
    try {
      await this.ctx.workspaces.remove(ws);
    } catch (error) {
      this.ctx.store.audit("workspace.error", {
        taskId: f.task.id,
        step: "remove",
        message: (error as Error).message,
      });
    }
  }

  /** Copies an earlier run left (a crash or a kill): their changes go back, then they go. */
  async cleanupWorkspaces(): Promise<void> {
    for (const f of [...this.ctx.following.values()]) {
      const root = f.workspace?.root;
      if (!f.ended || f.reopening !== undefined || root === undefined || !existsSync(root)) {
        continue;
      }
      await this.closeWorkspace(f);
    }
  }

  private started(f: Following, asked: string | undefined): void {
    this.ctx.store.audit("session.started", {
      sessionId: f.task.id,
      profileId: f.profile.id,
      cwd: f.cwd,
      ...(asked === undefined ? {} : { model: f.task.model ?? asked }),
      agentSessionId: f.agentSessionId,
    });
    this.ctx.watchdog.track(f.task.id);
  }

  /** Gives a task a new name on the board and in later reports. */
  renameTask(taskId: string, name: string): void {
    const f = this.ctx.following.get(taskId);
    if (f === undefined) throw new Error(`unknown task ${taskId}`);
    f.task.title = taskTitle(name);
    f.task.updatedAt = this.ctx.clock.now().toISOString();
    this.ctx.board.changed();
  }

  /**
   * Sends a prompt to an open task. Queued while a turn runs; settles when its turn ends.
   * @param fromOwner false for AgentHerd's own prompts (pull request activity): they do not take
   *   the owner's latest message as the one to acknowledge.
   */
  promptTask(
    taskId: string,
    text: string,
    images: OwnerImage[] = [],
    fromOwner = true,
  ): Promise<RunResult> {
    const f = this.ctx.following.get(taskId);
    if (f === undefined) return Promise.reject(new Error(`unknown task ${taskId}`));
    const trigger = fromOwner ? this.takeOwnerMessage() : undefined;
    if (fromOwner) this.ctx.github()?.handed(taskId, text);
    // An ended task (also one from before a restart) is started again (ADR 0039).
    if (f.ended && f.reopening === undefined) {
      f.reopening = this.reopen(f).finally(() => {
        delete f.reopening;
      });
    }
    const queue = (): Promise<RunResult> => {
      if (f.ended) return Promise.reject(new Error(`task ${taskId} is not open`));
      const done = new Promise<RunResult>((resolve, reject) => {
        f.queue.push({
          text,
          images,
          resolve,
          reject,
          ...(trigger === undefined ? {} : { trigger }),
        });
      });
      void this.pump(f);
      return done;
    };
    return f.reopening === undefined ? queue() : f.reopening.then(queue);
  }

  /**
   * Loads saved tasks as ended tasks, so they show and can be continued (ADR 0039). With
   * `closeStale`, tasks and sessions an earlier run left open are ended now.
   * @returns ids of tasks that were still working when AgentHerd went away without stopping.
   */
  restore(limit = TASKS_RESTORED, closeStale = true): string[] {
    const { ctx } = this;
    const crashed: string[] = [];
    const now = ctx.clock.now().toISOString();
    for (const saved of ctx.store.tasks(limit).reverse()) {
      if (ctx.following.has(saved.task.id)) continue;
      const profile = ctx.opts.profiles.find((p) => p.id === saved.profileId) ?? {
        id: saved.profileId,
        name: saved.task.agent,
        command: [],
        env: {},
        exporter: null,
      };
      const f: Following = {
        task: saved.task,
        profile,
        cwd: saved.cwd,
        alarm: false,
        finished: saved.task.stage === "done",
        failed: saved.failed,
        ended: true,
        endedWhy: saved.endedWhy ?? ctx.texts.agentherdStopped,
        endedAt: saved.endedAt ?? now,
        turn: { text: "", toolCalls: 0 },
        turnsEnded: 1,
        offs: [],
        queue: [],
        busy: false,
        ...(saved.agentSessionId === undefined ? {} : { agentSessionId: saved.agentSessionId }),
        ...(saved.workspace === undefined ? {} : { workspace: saved.workspace }),
      };
      ctx.following.set(saved.task.id, f);
      if (saved.endedAt !== undefined || !closeStale) continue;
      // AgentHerd stopped without ending the task (a crash or a kill): end it now.
      const session = ctx.store.getSession(f.task.id);
      if (session !== undefined && session.state !== "ended") {
        ctx.store.upsertSession({ ...session, state: "ended", updatedAt: now });
      }
      if (unfinished(f)) {
        crashed.push(f.task.id);
        f.task.stage = "failed";
        f.task.lastReport = ctx.texts.agentherdStopped;
      }
      // Ended by AgentHerd going away, not by the work: nothing to learn (ADR 0054).
      ctx.store.audit("task.ended", { taskId: f.task.id, why: f.endedWhy });
      saveTask(ctx, f);
    }
    return crashed;
  }

  /** Agents to start an ended task again with: its own, then Pi, then the rest but DSH. */
  private reopenCandidates(f: Following): AgentProfile[] {
    const profiles = this.ctx.opts.profiles;
    const out: AgentProfile[] = [];
    const add = (p: AgentProfile | undefined) => {
      if (p !== undefined && !out.some((o) => o.id === p.id)) out.push(p);
    };
    add(profiles.find((p) => p.id === f.profile.id));
    add(profiles.find((p) => p.id === "pi"));
    for (const p of profiles) if (p.id !== "dsh") add(p);
    return out;
  }

  /**
   * Starts the agent of an ended task again in the same folder and with the same model. The agent
   * opens its saved session when it can; otherwise the next prompt carries the earlier
   * conversation. Throws, after telling the owner, when no agent starts.
   */
  private async reopen(f: Following): Promise<void> {
    const { ctx } = this;
    const taskId = f.task.id;
    const errors: string[] = [];
    if (f.workspace !== undefined) {
      // A fresh copy of the project as it is now, in the same folder as before (ADR 0043).
      try {
        f.workspace = await ctx.workspaces.create(taskId, undefined, { previous: f.workspace });
        f.cwd = f.workspace.cwd;
      } catch (error) {
        ctx.store.audit("workspace.error", {
          taskId,
          step: "reopen",
          message: (error as Error).message,
        });
      }
    }
    for (const base of this.reopenCandidates(f)) {
      try {
        const model = await this.configuredModel(base.id, f.task.model);
        let profile = base;
        if (model !== undefined) {
          if (ctx.opts.agentModels === undefined) throw new Error("no model list to choose from");
          profile = withModel(base, ctx.opts.agentModels.launchFor(base.id, model));
        }
        const connection = await startAgent(profile, { cwd: f.cwd });
        let sessionId: string | undefined;
        if (
          connection.loadsSessions &&
          (ctx.opts.agentModels === undefined || f.task.model !== undefined) &&
          f.agentSessionId !== undefined &&
          base.id === f.profile.id
        ) {
          try {
            await connection.loadSession(f.agentSessionId, f.cwd, mcpServers(ctx, f));
            sessionId = f.agentSessionId;
          } catch (error) {
            ctx.store.audit("task.load-failed", { taskId, message: (error as Error).message });
          }
        }
        const loaded = sessionId !== undefined;
        if (sessionId === undefined) {
          try {
            sessionId = await connection.newSession(f.cwd, mcpServers(ctx, f));
          } catch (error) {
            await connection.close().catch(() => {});
            throw error;
          }
        }
        f.connection = connection;
        f.agentSessionId = sessionId;
        f.profile = profile;
        f.ended = false;
        delete f.endedWhy;
        delete f.endedAt;
        f.failed = false;
        f.alarm = false;
        f.finished = false;
        f.needsHistory = !loaded;
        // A continued task does not switch models on its first turn: it already did work.
        f.turnsEnded = Math.max(f.turnsEnded ?? 0, 1);
        if (model !== undefined) f.task.model = model;
        f.task.agent = model === undefined ? profile.name : `${profile.name} · ${model}`;
        ctx.registry.add(taskId, profile.id, f.cwd);
        this.listen(f, connection, sessionId);
        ctx.watchdog.track(taskId);
        ctx.store.audit("task.reopened", {
          taskId,
          profileId: profile.id,
          loaded,
          agentSessionId: sessionId,
        });
        ctx.store.addTranscript(taskId, "note", ctx.texts.taskReopened(f.task.agent, loaded));
        ctx.board.changed();
        return;
      } catch (error) {
        errors.push(`${base.name}: ${(error as Error).message}`);
      }
    }
    const message = errors.join("\n") || "no agent is installed";
    ctx.store.audit("task.reopen-failed", { taskId, message });
    setReport(ctx, f, ctx.texts.couldNotStart(message));
    await sendReport(ctx, f, ctx.texts.couldNotStartBody(message), null);
    throw new Error(message);
  }

  /** Cancels the current turn of a task, then sends the text as the next prompt. */
  async interruptTask(taskId: string, text: string, images?: OwnerImage[]): Promise<RunResult> {
    const f = this.ctx.following.get(taskId);
    if (f === undefined) throw new Error(`unknown task ${taskId}`);
    const next = this.ops.promptTask(taskId, text, images);
    if (f.busy && f.connection !== undefined && f.agentSessionId !== undefined) {
      await f.connection.cancel(f.agentSessionId);
    }
    return next;
  }

  /** Cancels the current turn of a task, if one is running. */
  async cancelTurn(taskId: string): Promise<void> {
    const f = this.ctx.following.get(taskId);
    if (f === undefined || f.ended) throw new Error(`task ${taskId} is not open`);
    if (f.busy && f.connection !== undefined && f.agentSessionId !== undefined) {
      await f.connection.cancel(f.agentSessionId);
    }
  }

  /** Closes the agent of a task. The task stays on the board. */
  async endTask(taskId: string, why: string): Promise<void> {
    const { ctx } = this;
    const f = ctx.following.get(taskId);
    if (f === undefined || f.ended) return;
    const connection = f.connection;
    f.ended = true;
    f.endedWhy = why;
    f.endedAt = ctx.clock.now().toISOString();
    f.idleTimer?.cancel();
    ctx.watchdog.untrack(taskId);
    this.stopBackground(f);
    for (const off of f.offs) off();
    f.offs = [];
    for (const queued of f.queue.splice(0)) queued.reject(new Error(`the task ended: ${why}`));
    await ctx.inbox.expireSession(taskId, why);
    await connection?.close();
    if (f.connection === connection) delete f.connection;
    ctx.mcp.revoke(taskId);
    await this.closeWorkspace(f);
    ctx.registry.set(taskId, "ended");
    ctx.store.audit("task.ended", { taskId, why });
    this.queueLesson(f, why);
    if (this.relay.stored()?.taskId === taskId) {
      await this.relay.end("the task ended");
    }
    await ctx.board.flush();
  }

  /**
   * Most tasks teach nothing worth keeping: their record stays searchable, nothing is written to
   * memory (ADR 0054). Only a task that went wrong or needed the owner again is looked at later,
   * for a lesson. One AgentHerd itself stopped is never looked at.
   */
  private queueLesson(f: Following, why: string): void {
    const { ctx } = this;
    const taskId = f.task.id;
    if (why === ctx.texts.agentherdStopped) return;
    if (ctx.store.transcript(taskId).length < 2) return;
    const signals = lessonSignals(f);
    if (signals.length === 0) {
      ctx.store.audit("memory.lesson.none", { taskId });
      return;
    }
    ctx.store.memory.enqueueJob(LESSON_JOB, {
      taskId,
      title: f.task.title,
      cwd: f.cwd,
      agent: f.task.agent,
      failed: f.failed,
      why,
      signals,
    });
  }

  private listen(f: Following, connection: AgentConnection, agentSessionId: string): void {
    const { ctx } = this;
    const sessionId = f.task.id;
    f.offs = [
      connection.on("permission", (request) => {
        if (request.sessionId !== agentSessionId) return;
        ctx.watchdog.event(sessionId);
        void onPermission(ctx, sessionId, f.profile, f.cwd, request).catch((error: Error) => {
          // Never leave the agent without an answer it can act on: cancel, never allow.
          request.respond({ kind: "cancelled" });
          ctx.store.audit("permission.error", { sessionId, message: error.message });
        });
      }),
      connection.on("update", (u) => {
        if (u.sessionId !== agentSessionId) return;
        if (u.type === "message") {
          f.turn.text += u.text ?? "";
          f.pending = (f.pending ?? "") + (u.text ?? "");
        }
        if (u.type === "tool_call_update" && u.toolCallId !== undefined && u.status !== undefined) {
          ctx.store.setToolStatus(sessionId, u.toolCallId, u.status);
        }
        if (u.type === "tool_call" && u.toolCall !== undefined) {
          f.turn.toolCalls += 1;
          flushReply(ctx, f);
          ctx.store.addTranscript(sessionId, "tool", u.toolCall.command ?? u.toolCall.title, {
            id: u.toolCallId ?? "",
            ...(u.status === undefined ? {} : { status: u.status }),
          });
          const key = `${u.toolCall.title}\u0000${JSON.stringify(u.toolCall.rawInput ?? u.toolCall.command ?? "")}`;
          ctx.watchdog.toolCall(sessionId, key, u.toolCall.command ?? u.toolCall.title);
        } else {
          ctx.watchdog.event(sessionId);
        }
        const state = ctx.registry.get(sessionId)?.state;
        if (state !== "waiting-approval" && f.busy) ctx.registry.set(sessionId, "working");
      }),
      connection.on("exit", (e) => {
        ctx.store.audit("session.exited", { sessionId, code: e.code, signal: e.signal });
        if (f.busy) {
          ctx.watchdog.exited(sessionId, ctx.texts.exited(String(e.code ?? e.signal)));
        }
        if (!f.ended) ctx.registry.set(sessionId, e.code === 0 ? "ended" : "error");
        if (!f.busy && !f.ended) void this.ops.endTask(sessionId, ctx.texts.agentExited);
      }),
    ];
  }

  /**
   * Waits (at most `ms`) for running turns to finish. Stopping ends tasks, which fails their
   * turns; each failed turn still reports, and that report must be sent before the store
   * closes, or the outbox sends it a second time after the next start.
   */
  async settle(ms: number): Promise<void> {
    if (this.turns.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...this.turns]),
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
    clearTimeout(timer);
  }

  /** Runs queued prompts one turn at a time. */
  private async pump(f: Following): Promise<void> {
    if (f.busy) return;
    const next = f.queue.shift();
    if (next === undefined) return;
    f.busy = true;
    f.idleTimer?.cancel();
    if (next.wake !== true) f.ownerTurns = (f.ownerTurns ?? 0) + 1;
    const turn = this.runTurn(f, next.text, next.images, next.wake === true, next.trigger);
    this.turns.add(turn);
    try {
      next.resolve(await turn);
    } catch (error) {
      next.reject(error as Error);
    } finally {
      this.turns.delete(turn);
      f.busy = false;
    }
    if (f.ended) return;
    if (f.queue.length > 0) {
      void this.pump(f);
      return;
    }
    const minutes = this.ctx.opts.sessionIdleMinutes ?? SESSION_IDLE_MINUTES;
    f.idleTimer = this.ctx.clock.after(minutes * 60_000, () => {
      void this.ops.endTask(f.task.id, `no prompt for ${minutes} minutes`);
    });
  }

  /**
   * When the task's model broke its first turn (or its agent did not start) before any text or
   * tool call, restarts on the next agent and model that answers (ADR 0030, 0031). False when the
   * task keeps failing.
   */
  private async switchModel(f: Following, why: string): Promise<boolean> {
    const { ctx } = this;
    const models = ctx.opts.agentModels;
    const failed = f.task.model;
    if (models?.next === undefined || failed === undefined || f.endedWhy !== undefined)
      return false;
    if ((f.turnsEnded ?? 0) > 0 || f.turn.text.trim() !== "" || f.turn.toolCalls > 0) return false;
    const tried = f.triedModels ?? [];
    if (!tried.includes(failed)) tried.push(failed);
    f.triedModels = tried;
    f.switches = (f.switches ?? 0) + 1;
    if (f.switches > MAX_MODEL_SWITCHES) return false;
    const fromLabel = f.task.agent;
    let ref: string;
    let profile: AgentProfile;
    try {
      const next = await models.next(f.profile.id, failed, tried);
      if (next === undefined) return false;
      const base = ctx.opts.profiles.find((p) => p.id === next.profileId);
      if (base === undefined) return false;
      ref = (await this.configuredModel(base.id, next.model)) as string;
      profile = withModel(base, models.launchFor(base.id, ref));
    } catch {
      return false;
    }
    for (const off of f.offs) off();
    f.offs = [];
    const old = f.connection;
    delete f.connection;
    await old?.close();
    try {
      const connection = await startAgent(profile, { cwd: f.cwd });
      f.connection = connection;
      f.agentSessionId = await connection.newSession(f.cwd, mcpServers(ctx, f));
    } catch (error) {
      ctx.store.audit("task.model-switch-failed", {
        taskId: f.task.id,
        to: ref,
        message: (error as Error).message,
      });
      return false;
    }
    f.profile = profile;
    f.failed = false;
    f.task.model = ref;
    f.task.agent = `${profile.name} · ${ref}`;
    this.listen(f, f.connection, f.agentSessionId);
    const short = why.length > 200 ? `${why.slice(0, 200)}…` : why;
    ctx.store.audit("task.model-switched", {
      taskId: f.task.id,
      from: fromLabel,
      to: f.task.agent,
      why: short,
    });
    ctx.store.addTranscript(
      f.task.id,
      "note",
      ctx.texts.modelSwitched(fromLabel, f.task.agent, short),
    );
    await say(ctx, ctx.texts.modelSwitched(fromLabel, f.task.agent, short), f.task.title, "alarm");
    ctx.board.changed();
    return true;
  }

  /**
   * The agent's `herd_ack`: one line to the owner about what it is starting, once per turn.
   * @returns why it was not sent.
   */
  ack(taskId: string, text: string): string | undefined {
    const { ctx } = this;
    const f = ctx.following.get(taskId);
    if (f === undefined || f.ended || !f.busy) return "no turn is running";
    if (f.waking === true) return "not needed: this turn is AgentHerd's own check, not a request";
    if (f.acked === true) return "already sent in this turn";
    const long = tooLong(text, ACK_WORDS_MAX);
    if (long !== undefined) return long;
    f.acked = true;
    ctx.store.audit("task.ack", { taskId, text, reply: f.trigger !== undefined });
    // A reply to the owner's message, so it reads as the answer to that request (ADR 0049).
    void say(ctx, text, f.task.title, undefined, taskId, f.trigger);
    return undefined;
  }

  /** The owner's latest message, if it came just now; taken once. */
  private takeOwnerMessage(): MessageRef | undefined {
    const { ctx } = this;
    const m = ctx.ownerMessage;
    delete ctx.ownerMessage;
    if (m === undefined || ctx.clock.now().getTime() - m.at > OWNER_MESSAGE_FRESH_MS)
      return undefined;
    return m.ref;
  }

  /**
   * The turn ended with the agent's last word a `progress` report and no tool call after it:
   * work it started still runs in the background. Nothing is reported; the agent is asked again
   * later, up to BACKGROUND_MAX_CHECKS times (docs/spec/04-herder.md "Background work").
   */
  private stillRunning(f: Following, wake: boolean): boolean {
    const { ctx } = this;
    const report = f.report;
    const checks = wake ? (f.background?.checks ?? 0) : 0;
    this.stopBackground(f);
    if (
      !f.finished ||
      report?.state !== "progress" ||
      f.reportAt !== f.turn.toolCalls ||
      checks >= BACKGROUND_MAX_CHECKS
    ) {
      return false;
    }
    const minutes = ctx.opts.backgroundCheckMinutes ?? BACKGROUND_CHECK_MINUTES;
    f.finished = false;
    f.background = {
      checks: checks + 1,
      timer: ctx.clock.after(minutes * 60_000, () => this.wake(f, minutes)),
    };
    ctx.registry.set(f.task.id, "working");
    setReport(ctx, f, ctx.texts.backgroundRunning(report.summary));
    ctx.store.audit("task.background", { taskId: f.task.id, checks: checks + 1 });
    return true;
  }

  /** Asks the agent about its background work, unless the owner's prompt is already running. */
  private wake(f: Following, minutes: number): void {
    const background = f.background;
    if (f.ended || background === undefined) return;
    delete background.timer;
    if (f.busy || f.queue.length > 0) return;
    f.queue.push({
      text: this.ctx.texts.backgroundCheck(minutes),
      images: [],
      wake: true,
      resolve: () => {},
      reject: () => {},
    });
    void this.pump(f);
  }

  private stopBackground(f: Following): void {
    f.background?.timer?.cancel();
    delete f.background;
  }

  private async runTurn(
    f: Following,
    text: string,
    images: OwnerImage[],
    wake = false,
    trigger?: MessageRef,
  ): Promise<RunResult> {
    const { ctx } = this;
    const sessionId = f.task.id;
    const { connection, agentSessionId } = f;
    if (connection === undefined || agentSessionId === undefined) {
      throw new Error(`task ${sessionId} has no session`);
    }
    await this.syncIn(f);
    // The owner's prompt ends the wait for background work; a check keeps the count.
    if (!wake) this.stopBackground(f);
    else f.background?.timer?.cancel();
    // A herd_report speaks for the turn it came in; the next turn starts without one.
    delete f.report;
    delete f.reportAt;
    delete f.notified;
    f.acked = false;
    f.waking = wake;
    if (trigger === undefined) delete f.trigger;
    else f.trigger = trigger;
    f.turn = { text: "", toolCalls: 0 };
    f.pending = "";
    // Read before this prompt is added, so the history holds only the earlier conversation.
    const history = f.needsHistory === true ? historyText(ctx.store.transcript(sessionId)) : "";
    f.needsHistory = false;
    ctx.store.addTranscript(sessionId, "prompt", withImagePaths(text, images, ctx.texts));
    f.finished = false;
    f.alarm = false;
    // An agent that takes no images gets where they are saved instead.
    let prompt = connection.acceptsImages ? text : withImagePaths(text, images, ctx.texts);
    // Every prompt carries the length hint (ADR 0036); follow-ups were long without it.
    if (history !== "") prompt = `${ctx.texts.priorConversation(history)}\n\n${prompt}`;
    // With a Herder that speaks for the task the agent writes for it, not for a phone (ADR 0053).
    const hint =
      ctx.herder()?.voice === undefined
        ? replyHint(ctx.opts.replyHintChars ?? REPLY_HINT_CHARS, ctx.texts)
        : ctx.texts.voicedReplyHint;
    prompt = `${hint}\n\n${prompt}`;
    ctx.registry.set(sessionId, "working");
    ctx.watchdog.turnStarted(sessionId);
    try {
      const { stopReason } = await connection.prompt(
        agentSessionId,
        prompt,
        images.map((i) => ({ data: i.data, mimeType: i.mimeType })),
      );
      ctx.watchdog.turnEnded(sessionId);
      f.finished = stopReason === "end_turn";
      f.turnsEnded = (f.turnsEnded ?? 0) + 1;
      flushReply(ctx, f);
      ctx.store.audit("turn.ended", { sessionId, stopReason });
      // The owner reads the report with the task's changes already in the project folder.
      const conflicts = await this.syncOut(f);
      ctx.registry.set(sessionId, "idle");
      await ctx.inbox.expireSession(sessionId, ctx.texts.turnEnded);
      const reply = f.turn.text;
      if (this.relay.current()?.taskId === sessionId) {
        setReport(ctx, f, ctx.texts.relayed(firstLine(reply)));
        await say(ctx, reply.trim() === "" ? ctx.texts.noReply : reply, f.task.title);
        ctx.store.audit("relay.reply", { taskId: sessionId, stopReason });
      } else if (!this.stillRunning(f, wake)) {
        // The owner already got the agent's own report of this turn when it came.
        const told = f.report !== undefined && f.notified === f.report;
        await sendReport(
          ctx,
          f,
          reply,
          () => askSummary(ctx, connection, agentSessionId, f),
          !told,
        );
      }
      await this.tellConflicts(f, conflicts);
      // Pull requests the agent opened or wrote on are looked at (ADR 0047).
      ctx
        .github()
        ?.turnEnded(sessionId, `${reply}\n${ctx.following.get(sessionId)?.report?.summary ?? ""}`);
      return { sessionId, stopReason };
    } catch (error) {
      // Ending a task closes its agent, which fails the running turn; report why it ended, not
      // the agent's exit.
      const message = f.endedWhy ?? (error as Error).message;
      ctx.watchdog.turnEnded(sessionId);
      flushReply(ctx, f);
      ctx.store.addTranscript(sessionId, "note", message);
      this.stopBackground(f);
      if (await this.switchModel(f, message)) return this.runTurn(f, text, images);
      const conflicts = await this.syncOut(f);
      if (ctx.registry.get(sessionId)?.state !== "ended") ctx.registry.set(sessionId, "error");
      await sendReport(ctx, f, ctx.texts.failedBody(message), null);
      await this.tellConflicts(f, conflicts);
      await this.ops.endTask(sessionId, ctx.texts.turnFailed);
      throw error;
    }
  }
}

/** A task that was in the middle of work: running a turn, waiting, or not yet reported done. */
export function unfinished(f: Following): boolean {
  return f.busy || f.queue.length > 0 || (f.task.stage !== "done" && f.task.stage !== "failed");
}

/**
 * The earlier prompts and replies of a task, newest kept when long, for an agent that could not
 * open its old session. Tool calls and notes are left out.
 */
export function historyText(entries: readonly TranscriptEntry[], max = HISTORY_MAX_CHARS): string {
  const lines = entries
    .filter((e) => e.role === "prompt" || e.role === "agent")
    .map((e) => `${e.role === "prompt" ? "AgentHerd" : "you"}: ${e.text.trim()}`);
  let text = lines.join("\n\n");
  if (text.length > max) text = `…${text.slice(text.length - max)}`;
  return text;
}

/** The text with one line per image, naming the file it is saved in. */
export function withImagePaths(text: string, images: OwnerImage[], texts: CoreTexts): string {
  if (images.length === 0) return text;
  const lines = images.map((i) => texts.imageAttached(i.path));
  return [text, ...lines].filter((l) => l !== "").join("\n");
}

/** Why a task may hold a lesson (ADR 0054); empty for a task that simply went well. */
export function lessonSignals(f: Following): string[] {
  const signals: string[] = [];
  if (f.failed || f.task.stage === "failed") signals.push("it failed");
  if (f.task.stage === "stuck" || f.report?.state === "blocked") signals.push("it got stuck");
  if (f.alarm) signals.push("the watchdog raised an alarm");
  if ((f.switches ?? 0) > 0 || (f.triedModels?.length ?? 0) > 0) {
    signals.push("its model or agent had to be switched");
  }
  if ((f.ownerTurns ?? 0) > 1) {
    signals.push(`the owner prompted it ${(f.ownerTurns ?? 0) - 1} more time(s) after the first`);
  }
  return signals;
}
