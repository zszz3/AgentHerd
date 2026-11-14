// Permission requests from an agent: rules decide, or the owner gets an inbox item.

import { randomUUID } from "node:crypto";
import type { PermissionRequest } from "@agentherd/acp-client";
import type { AgentProfile, Item } from "@agentherd/protocol";
import { turnPermits } from "./github-watch.ts";
import type { HerdContext } from "./herd-context.ts";
import { decide } from "./pipeline.ts";

export async function onPermission(
  ctx: HerdContext,
  sessionId: string,
  profile: AgentProfile,
  cwd: string,
  request: PermissionRequest,
): Promise<void> {
  const { opts, store, clock } = ctx;
  const item: Item = {
    id: randomUUID(),
    sessionId,
    profileId: profile.id,
    cwd,
    kind: "permission",
    state: "open",
    createdAt: clock.now().toISOString(),
    toolCall: request.toolCall,
    title: request.toolCall.title,
    body: request.toolCall.command ?? request.toolCall.paths.join("\n"),
    risk: "medium",
  };
  const result = decide(item, {
    mode: ctx.mode(),
    rules: store.listRules(),
    home: opts.userHome,
    ...(opts.extraGuards === undefined ? {} : { extraGuards: opts.extraGuards }),
    ...turnPermits(ctx, sessionId),
  });
  item.risk = result.decision.risk;
  store.insertItem(item);
  if (result.suggestion !== undefined) {
    const { action, reason, confidence } = result.suggestion;
    store.audit("item.suggestion", { itemId: item.id, action, reason, confidence });
  }

  const now = () => clock.now().toISOString();
  if (result.apply) {
    const action = result.decision.action;
    const answered = (action === "allow" || action === "deny") && request.respond({ kind: action });
    if (answered) {
      store.insertDecision(result.decision, {
        ...(result.ruleId === undefined ? {} : { ruleId: result.ruleId }),
        createdAt: now(),
      });
      store.updateItem(item.id, { state: "decided", decidedAt: now() });
      store.audit("item.decided", { itemId: item.id, source: "rule", action });
      // Requests approved only because they are not a mass delete are in the audit log; the
      // report lists decisions made by the owner's rules.
      const f = result.ruleId === undefined ? undefined : ctx.following.get(sessionId);
      if (f !== undefined) {
        f.task.automaticDecisions.push(
          ctx.texts.byRule(action === "allow", result.ruleId, item.body || item.title),
        );
      }
    } else {
      store.updateItem(item.id, { state: "expired", decidedAt: now() });
    }
    return;
  }

  ctx.registry.set(sessionId, "waiting-approval");
  await ctx.inbox.add(
    item,
    {
      answer: (answer) => {
        const ok = request.respond({ kind: answer });
        if (ok) ctx.registry.set(sessionId, "working");
        return ok;
      },
    },
    result.decision.reason,
    ctx.following.get(sessionId)?.task.title,
  );
}
