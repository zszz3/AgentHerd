// App calls from an agent through the agentherd MCP server (docs/spec/09-agent-tools.md §3):
// each call is checked like a permission request; one call the owner must see sends one item
// for the whole batch, and the strictest answer wins.

import { randomUUID } from "node:crypto";
import type { AppHints, Item } from "@agentherd/protocol";
import { matchRules } from "@agentherd/rules";
import { turnPermits } from "./github-watch.ts";
import type { HerdContext } from "./herd-context.ts";
import type { ExactApprovalPreview } from "./mcp-gateway.ts";
import { APP_WRITE, decide, type PipelineResult } from "./pipeline.ts";

/** One app tool an agent wants to run. */
export interface AppCall {
  /** Composio tool slug, e.g. GMAIL_SEND_EMAIL. */
  slug: string;
  /** "<Toolkit>: <Tool>". */
  title: string;
  toolkit: string;
  hints?: AppHints;
  arguments: unknown;
}

function rank(r: PipelineResult): number {
  if (!r.apply) return 1;
  return r.decision.action === "deny" ? 2 : r.decision.action === "allow" ? 0 : 1;
}

function itemFor(ctx: HerdContext, taskId: string, calls: readonly AppCall[]): Item {
  const f = ctx.following.get(taskId);
  const first = calls[0] as AppCall;
  const body = calls
    .map((c) => `${c.title}\n${JSON.stringify(c.arguments ?? {}, null, 2)}`)
    .join("\n\n");
  return {
    id: randomUUID(),
    sessionId: taskId,
    profileId: f?.profile.id ?? "unknown",
    cwd: f?.cwd ?? ctx.opts.userHome,
    kind: "permission",
    state: "open",
    createdAt: ctx.clock.now().toISOString(),
    toolCall: {
      kind: "app",
      title: calls.map((c) => c.title).join(", "),
      command: first.slug,
      paths: [],
      rawInput: calls.length === 1 ? first.arguments : calls.map((c) => c.arguments),
      ...(calls.length === 1 && first.hints !== undefined ? { appHints: first.hints } : {}),
    },
    title: calls.map((c) => c.title).join(", "),
    body,
    risk: "medium",
  };
}

export function approveExactAppCall(
  ctx: HerdContext,
  taskId: string,
  call: AppCall,
  preview: ExactApprovalPreview,
  expiresAt: number,
  signal: AbortSignal,
) {
  // Store classification only; the preview is never part of the item or its tool call.
  const item = itemFor(ctx, taskId, [{ ...call, arguments: undefined }]);
  item.body = "";
  return ctx.inbox.approveExact(item, preview, expiresAt, signal);
}

function isReadOnly(hints: AppHints | undefined): boolean {
  return (
    hints?.readOnly === true &&
    hints.create === false &&
    hints.update === false &&
    hints.destructive === false
  );
}

function officeProvider(call: AppCall): string | undefined {
  if (call.toolkit === "builtin:wecom") return "WeCom";
  if (call.toolkit === "builtin:dingtalk") return "DingTalk";
  return undefined;
}

function itemForCall(base: Item, call: AppCall): Item {
  return {
    ...base,
    toolCall: {
      kind: "app",
      title: call.title,
      command: call.slug,
      paths: [],
      rawInput: call.arguments,
      ...(call.hints === undefined ? {} : { appHints: call.hints }),
    },
  };
}

/** Apply the owner's explicit deny before a built-in office preflight can contact the provider. */
export function blockDeniedOfficePreflight(ctx: HerdContext, taskId: string, call: AppCall): void {
  const provider = call.toolkit === "builtin:mijia" ? "Mi Home" : officeProvider(call);
  if (provider === undefined) return;
  const hit = matchRules(ctx.store.listRules(), itemFor(ctx, taskId, [call]), ctx.opts.userHome);
  if (hit?.action !== "deny") return;
  ctx.store.audit("app.call.preflight", {
    taskId,
    slug: call.slug,
    action: "deny",
    ruleId: hit.rule.id,
  });
  throw new Error(`${provider} call blocked by rule ${hit.rule.id}`);
}

/** The pipeline's answer for one call, as if it came alone. */
function decideOne(ctx: HerdContext, base: Item, call: AppCall): PipelineResult {
  const item = itemForCall(base, call);
  const policy = {
    mode: ctx.mode(),
    rules: ctx.store.listRules(),
    home: ctx.opts.userHome,
    ...turnPermits(ctx, base.sessionId),
  };
  const provider = officeProvider(call);
  if (provider !== undefined && policy.mode === "observe") {
    // Observe normally only suggests rules. A built-in office deny still wins.
    const enforced = decide(item, { ...policy, mode: "assist" });
    if (enforced.apply && enforced.decision.action === "deny") return enforced;
  }

  const result = decide(item, policy);
  if (
    provider !== undefined &&
    !isReadOnly(call.hints) &&
    result.apply &&
    result.decision.action === "allow"
  ) {
    return {
      decision: {
        ...result.decision,
        action: "escalate",
        confidence: 0,
        risk: "medium",
        reason: `${provider} tool is not read-only; needs your confirmation`,
      },
      apply: false,
    };
  }
  return result;
}

/**
 * True when the calls may run. Approved writes go into the task's report; anything the owner
 * must see waits for the owner's answer.
 */
export async function approveAppCalls(
  ctx: HerdContext,
  taskId: string,
  calls: readonly AppCall[],
): Promise<boolean> {
  if (calls.length === 0) return true;
  const { store, clock } = ctx;
  const item = itemFor(ctx, taskId, calls);
  const results = calls.map((c) => decideOne(ctx, item, c));
  // A deny wins; then anything for the owner; then allow.
  const strictest = results.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  const decision = { ...strictest.decision, itemId: item.id };
  item.risk = decision.risk;
  store.insertItem(item);
  store.audit("app.call", {
    taskId,
    itemId: item.id,
    tools: calls.map((c) => c.slug),
    action: strictest.apply ? decision.action : "owner",
    reason: decision.reason,
  });
  const now = () => clock.now().toISOString();

  if (strictest.apply) {
    store.insertDecision(decision, {
      ...(strictest.ruleId === undefined ? {} : { ruleId: strictest.ruleId }),
      createdAt: now(),
    });
    store.updateItem(item.id, { state: "decided", decidedAt: now() });
    const allowed = decision.action === "allow";
    const f = ctx.following.get(taskId);
    if (f !== undefined) {
      if (strictest.ruleId !== undefined) {
        f.task.automaticDecisions.push(ctx.texts.byRule(allowed, strictest.ruleId, item.title));
      } else if (allowed && results.some((r) => r.decision.reason === APP_WRITE)) {
        f.task.automaticDecisions.push(ctx.texts.appWrite(item.title));
      }
    }
    return allowed;
  }

  const officeCalls = calls.filter((call) => officeProvider(call) !== undefined);
  ctx.registry.set(taskId, "waiting-approval");
  const allowed = await new Promise<boolean>((resolve) => {
    let done = false;
    void ctx.inbox.add(
      item,
      {
        answer: (answer) => {
          if (done) return false;
          done = true;
          ctx.registry.set(taskId, "working");
          resolve(answer === "allow");
          return true;
        },
      },
      decision.reason,
      ctx.following.get(taskId)?.task.title,
      officeCalls.some((call) => call.toolkit === "builtin:dingtalk")
        ? "separate-card"
        : officeCalls.length > 0,
    );
  });
  if (!allowed) return false;

  if (officeCalls.length === 0) return true;

  // Rules can change while the owner is deciding. Only a current deny overrides their answer;
  // outbound checks and task permits cannot mask it. Keep this separate from the owner's decision.
  let denied: { call: AppCall; ruleId: string } | undefined;
  try {
    const rules = store.listRules();
    for (const call of officeCalls) {
      const hit = matchRules(rules, itemForCall(item, call), ctx.opts.userHome);
      if (hit?.action !== "deny") continue;
      denied = { call, ruleId: hit.rule.id };
      break;
    }
  } catch {
    store.audit("app.call.recheck", { taskId, itemId: item.id, action: "error" });
    throw new Error("could not verify current rules for the office connector");
  }
  if (denied !== undefined) {
    const { call, ruleId } = denied;
    store.audit("app.call.recheck", {
      taskId,
      itemId: item.id,
      action: "deny",
      slug: call.slug,
      ruleId,
    });
    // Throw so the gateway reports a rule block, not that the owner refused the call.
    throw new Error(`${officeProvider(call)} call blocked by rule ${ruleId}`);
  }
  return true;
}
