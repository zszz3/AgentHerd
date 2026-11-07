// Task reports: the completion report, watchdog alarms, and the stage on the board.

import type { AgentConnection } from "@agentherd/acp-client";
import { type Following, firstLine, type HerdContext, say } from "./herd-context.ts";
import type { HerdReport } from "./mcp-gateway.ts";
import {
  REPORT_MAX_CHARS,
  reportBody,
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
  void say(
    ctx,
    ctx.texts.reportNotice(state, report.summary),
    f.task.title,
    state === "waiting" ? undefined : "alarm",
    f.task.id,
  );
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
  const max = ctx.opts.reportMaxChars ?? REPORT_MAX_CHARS;
  const prompt = summaryPrompt(max, ctx.texts);
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
 * agent's own report of this turn: the board and the Herder still learn it.
 */
export async function sendReport(
  ctx: HerdContext,
  f: Following,
  reply: string,
  ask: (() => Promise<SummaryAnswer>) | null,
  toOwner = true,
): Promise<void> {
  const max = ctx.opts.reportMaxChars ?? REPORT_MAX_CHARS;
  const body = await reportBody(
    reply,
    ask ?? (() => Promise.reject(new Error("no summary turn"))),
    max,
    ctx.texts.noReply,
  );
  restage(ctx, f);
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
