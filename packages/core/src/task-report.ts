// Task reports: the completion report, watchdog alarms, and the stage on the board.

import type { AgentConnection } from "@agentherd/acp-client";
import type { MessageRef, TextTone } from "@agentherd/protocol";
import type { Timer } from "./clock.ts";
import { headTail } from "./cut-text.ts";
import { type Following, firstLine, type HerdContext, say } from "./herd-context.ts";
import type { VoiceRequest } from "./herder-port.ts";
import type { HerdReport } from "./mcp-gateway.ts";
import { type NoticeKind, type NoticeLevel, noticeLevel } from "./notices.ts";
import {
  REPORT_MAX_WORDS,
  type ReportBody,
  reportBody,
  reportResult,
  reportView,
  type SummaryAnswer,
  summaryPrompt,
} from "./report.ts";
import { stageOf } from "./tasks.ts";
import type { Alarm } from "./watchdog.ts";

export function setReport(ctx: HerdContext, f: Following, text: string): void {
  f.task.lastReport = text;
  f.task.updatedAt = ctx.clock.now().toISOString();
  ctx.board.changed();
}

/**
 * An informational notice about a task (ADR 0061): pushed to the owner, written only into the
 * task's row on the board, or just audited, as the owner chose for its kind. Without a task row
 * on the board it is pushed.
 * @returns how it went out.
 */
export async function notice(
  ctx: HerdContext,
  kind: NoticeKind,
  f: Following | undefined,
  text: string,
  options: { tone?: TextTone; replyTo?: MessageRef } = {},
): Promise<NoticeLevel> {
  const chosen = noticeLevel(ctx.store, kind);
  const level = chosen === "board" && f === undefined ? "push" : chosen;
  ctx.store.audit("notice", { kind, level, ...(f === undefined ? {} : { taskId: f.task.id }) });
  if (level === "board" && f !== undefined) setReport(ctx, f, text);
  if (level === "push") {
    await say(ctx, text, f?.task.title, options.tone, f?.task.id, options.replyTo);
  }
  return level;
}

/**
 * An agent's `herd_report` (docs/spec/09-agent-tools.md §2): its state sets the stage, its
 * summary the board line. Needing the owner, being stuck or failing reaches the owner at once.
 */
export function applyReport(ctx: HerdContext, f: Following, report: HerdReport): void {
  f.report = report;
  f.reportAt = f.turn.toolCalls;
  ctx.store.audit("task.herd_report", {
    taskId: f.task.id,
    state: report.state,
    summary: report.summary,
  });
  setReport(ctx, f, report.summary);
  restage(ctx, f);
  const state = report.state;
  if (state !== "waiting" && state !== "blocked" && state !== "failed") return;
  const last = f.notified;
  if (last?.state === state && last.summary === report.summary) {
    f.notified = report;
    return;
  }
  f.notified = report;
  ctx.store.audit("report.notified", { taskId: f.task.id, state });
  void (async () => {
    // The Herder says it in its own words (ADR 0053); without it, the agent's summary.
    const words = await voice(ctx, {
      kind: "notice",
      taskId: f.task.id,
      title: f.task.title,
      result: state,
      reply: f.turn.text,
      report,
    });
    if (words === "") return;
    await say(
      ctx,
      words ?? ctx.texts.reportNotice(state, report.summary),
      f.task.title,
      state === "waiting" ? undefined : "alarm",
      f.task.id,
    );
  })();
}

/** How long a message waits for the Herder's words before it goes out without them. */
export const VOICE_TIMEOUT_MS = 3 * 60_000;

/**
 * Characters of a task's reply the Herder gets with a result that did not ring the phone. A longer
 * reply keeps its start and its end; task_read gives the whole (ADR 0062).
 */
export const EVENT_REPLY_MAX = 1000;

/**
 * The Herder's words for a task's result (ADR 0053): "" when it chose to say nothing, undefined
 * when there is no speaking Herder or it failed or took longer than {@link VOICE_TIMEOUT_MS}.
 */
export async function voice(ctx: HerdContext, request: VoiceRequest): Promise<string | undefined> {
  const herder = ctx.herder();
  if (herder?.voice === undefined) return undefined;
  let timer: Timer | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = ctx.clock.after(VOICE_TIMEOUT_MS, () => resolve(undefined));
  });
  try {
    const words = await Promise.race([herder.voice(request).catch(() => undefined), timeout]);
    if (words === undefined) ctx.store.audit("report.unvoiced", { taskId: request.taskId });
    return words;
  } finally {
    timer?.cancel();
  }
}

/** Recomputes the stage of a task from its session; updates the board if it changed. */
export function restage(ctx: HerdContext, f: Following): void {
  const row = ctx.registry.get(f.task.id);
  if (row === undefined) return;
  if (row.state === "error") f.failed = true;
  const stage = stageOf({
    session: f.failed ? "error" : row.state,
    openItems: row.state === "waiting-approval" ? 1 : 0,
    alarm: f.alarm,
    report: f.report?.state,
    finished: f.finished,
  });
  if (stage === f.task.stage) return;
  f.task.stage = stage;
  f.task.updatedAt = ctx.clock.now().toISOString();
  ctx.board.changed();
}

/** Asks the session for its own short summary (docs/spec/04-herder.md "Completion report"). */
export async function askSummary(
  ctx: HerdContext,
  connection: AgentConnection,
  agentSessionId: string,
  f: Following,
): Promise<SummaryAnswer> {
  f.turn = { text: "", toolCalls: 0 };
  f.pending = "";
  const prompt = summaryPrompt(ctx.opts.reportMaxWords ?? REPORT_MAX_WORDS, ctx.texts);
  ctx.store.addTranscript(f.task.id, "prompt", prompt);
  try {
    await connection.prompt(agentSessionId, prompt);
  } finally {
    flushReply(ctx, f);
  }
  return { text: f.turn.text, toolCalls: f.turn.toolCalls };
}

/**
 * Sends the completion report once per turn. `toOwner` false when the owner already got the
 * agent's own report of this turn: the board and the Herder still learn it. With a Herder that
 * speaks (ADR 0053) the body is its words and the agent's reply is one tap below; otherwise the
 * agent's own short text (ADR 0049).
 */
export async function sendReport(
  ctx: HerdContext,
  f: Following,
  reply: string,
  ask: (() => Promise<SummaryAnswer>) | null,
  toOwner = true,
): Promise<void> {
  restage(ctx, f);
  // The agent's own report of a turn that ended normally speaks first (ADR 0049).
  const own = ask !== null && f.report !== undefined && f.report.state !== "progress";
  // A turn its pull request woke that the task handled on its own goes on the board, not to the
  // phone, unless the owner asked otherwise; needing the owner, stuck or failed is pushed (ADR 0061).
  if (toOwner && f.turnFrom === "pull-request" && reportResult(f.task.stage) === "done") {
    const level = noticeLevel(ctx.store, "pr-follow-up");
    if (level !== "push") {
      const summary = own && f.report !== undefined ? f.report.summary : undefined;
      ctx.store.audit("report.unpushed", { taskId: f.task.id, level });
      if (level === "board") {
        setReport(ctx, f, summary ?? (firstLine(reply) || ctx.texts.noReply));
      }
      ctx.herder()?.event({
        kind: "task-reported",
        taskId: f.task.id,
        title: f.task.title,
        text: summary ?? headTail(reply.trim(), EVENT_REPLY_MAX, "task_read gives the whole reply"),
        shown: level === "board" ? "board" : "none",
      });
      return;
    }
  }
  const speaks = toOwner && ctx.herder()?.voice !== undefined;
  let body: ReportBody;
  if (speaks) {
    const words = await voice(ctx, {
      kind: "report",
      taskId: f.task.id,
      title: f.task.title,
      result: reportResult(f.task.stage),
      reply,
      ...(own && f.report !== undefined ? { report: f.report } : {}),
    });
    if (words === "") {
      ctx.store.audit("report.silent", { taskId: f.task.id });
      setReport(ctx, f, ctx.texts.reported(firstLine(reply)));
      return;
    }
    const full = reply.trim();
    body = {
      body: words ?? (full === "" ? ctx.texts.noReply : ctx.texts.herderUnvoiced),
      summarized: full !== "",
      ...(full === "" ? {} : { fullReply: full }),
    };
  } else {
    body = await reportBody(reply, ask ?? (() => Promise.reject(new Error("no summary turn"))), {
      maxWords: ctx.opts.reportMaxWords ?? REPORT_MAX_WORDS,
      noReply: ctx.texts.noReply,
      ...(own && f.report !== undefined ? { summary: f.report.summary } : {}),
    });
    restage(ctx, f);
  }
  const view = reportView(f.task, body, ctx.clock.now(), ctx.texts);
  if (toOwner) {
    // Kept and retried until the channel takes it; a reply to it goes to the task (ADR 0043).
    const ref = await ctx.outbox.send(view, f.task.id);
    ctx.store.audit(ref === undefined ? "report.queued" : "report.sent", {
      taskId: f.task.id,
      summarized: body.summarized,
    });
  } else {
    ctx.store.audit("report.already-sent", { taskId: f.task.id });
  }
  setReport(ctx, f, ctx.texts.reported(firstLine(body.body)));
  // A Herder that spoke has the report in its conversation already.
  if (speaks) return;
  ctx.herder()?.event({
    kind: "task-reported",
    taskId: f.task.id,
    title: f.task.title,
    text: body.body,
  });
}

export async function onAlarm(ctx: HerdContext, alarm: Alarm): Promise<void> {
  const f = ctx.following.get(alarm.sessionId);
  if (f === undefined) return;
  f.alarm = true;
  ctx.store.audit("watchdog.alarm", { ...alarm });
  setReport(ctx, f, ctx.texts.watchdog(alarm.detail));
  await ctx.outbox.send(
    {
      kind: "text",
      taskLabel: f.task.title,
      text: ctx.texts.watchdog(alarm.detail),
      tone: "alarm",
    },
    f.task.id,
  );
  ctx.herder()?.event({
    kind: "watchdog",
    taskId: f.task.id,
    title: f.task.title,
    text: alarm.detail,
  });
}

/** Moves reply text gathered since the last tool call into the task's transcript. */
export function flushReply(ctx: HerdContext, f: Following): void {
  const text = f.pending ?? "";
  f.pending = "";
  if (text.trim() !== "") ctx.store.addTranscript(f.task.id, "agent", text.trim());
}
