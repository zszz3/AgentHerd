// Approval pipeline (docs/spec/04-herder.md §3, ADR 0056): a mass delete and a step that leaves
// the Mac (push, pull request, merge, comment, publish, deploy, send) go to the owner, unless the
// owner allowed that step for the task; owner rules apply; anything else is approved. In observe mode only rules apply as suggestions
// and everything goes to the owner. Any failure escalates; no path from an error leads to allow.

import type { Decision, Item, Mode, Rule } from "@agentherd/protocol";
import {
  type ExtraGuard,
  guardCheck,
  massDeleteCheck,
  matchRules,
  type OutboundResult,
  type OutboundStep,
  outboundCheck,
  pushPlans,
} from "@agentherd/rules";

export interface PipelineContext {
  mode: Mode;
  rules: readonly Rule[];
  home: string;
  extraGuards?: readonly ExtraGuard[];
  /** Steps leaving the Mac that the owner allowed for this task (ADR 0056). */
  allowedSteps?: readonly OutboundStep[];
  /**
   * Set when a pull request woke the turn (ADR 0064): of the allowed steps, only a push to one of
   * these branches runs without asking.
   */
  pullRequestTurn?: {
    branches: readonly string[];
    /** The branch checked out in a folder, for a push that names none. */
    currentBranch: (dir: string) => string | undefined;
  };
}

/** Reason prefix of a step that leaves the Mac. */
export const LEAVES_MAC = "leaves the Mac: ";
/** Reason suffix of an allowed step that asks because a pull request woke the turn (ADR 0064). */
export const PR_TURN = " [pull request turn]";

export interface PipelineResult {
  decision: Decision;
  /** Apply `decision` to the agent now. False → send the item to the owner. */
  apply: boolean;
  /** Set when the pipeline found something but did not apply it (observe mode). */
  suggestion?: Decision;
  ruleId?: string;
}

/** Reason of a request approved because it is not a mass delete. */
export const AUTO_APPROVED = "auto-approved";

function escalate(item: Item, risk: Decision["risk"], reason: string): Decision {
  return {
    itemId: item.id,
    action: "escalate",
    confidence: 0,
    risk,
    source: "rule",
    reason,
    precedents: [],
  };
}

/** Reason of a read-only app call approved by its hints. */
export const APP_READ = "app read";
/** Reason of an app call that writes but deletes nothing, approved by its hints. */
export const APP_WRITE = "app write";

const allowBy = (item: Item, reason: string): PipelineResult => ({
  decision: {
    itemId: item.id,
    action: "allow",
    confidence: 1,
    risk: "low",
    source: "rule",
    reason,
    precedents: [],
  },
  apply: true,
});

/**
 * An app call no rule matched (docs/spec/09-agent-tools.md §3): read-only tools run in every
 * mode; writes that delete nothing run outside observe (the owner asked for them in the task);
 * destructive tools and tools without hints go to the owner.
 */
function appDefault(item: Item, mode: Mode): PipelineResult {
  const hints = item.toolCall?.appHints;
  if (hints === undefined) {
    return { decision: escalate(item, "medium", "app tool without hints"), apply: false };
  }
  if (hints.destructive) {
    return {
      decision: escalate(item, "high", "app tool that deletes or overwrites"),
      apply: false,
    };
  }
  if (hints.readOnly && !hints.create && !hints.update) return allowBy(item, APP_READ);
  if (!hints.create && !hints.update) {
    return { decision: escalate(item, "medium", "app tool without hints"), apply: false };
  }
  if (mode === "observe") {
    return { decision: escalate(item, "medium", "observe mode; app tool writes"), apply: false };
  }
  return allowBy(item, APP_WRITE);
}

/**
 * A turn a pull request woke may only push to that pull request's branch (ADR 0064): what the
 * owner allowed when the task started was for the work they asked for, not for whatever someone
 * writes on the pull request later.
 */
function pullRequestMayDo(item: Item, out: OutboundResult, ctx: PipelineContext): boolean {
  const pr = ctx.pullRequestTurn;
  if (pr === undefined) return true;
  const command = item.toolCall?.command;
  if (out.step !== "push" || item.toolCall?.kind === "app" || command === undefined) return false;
  const plans = pushPlans(command, { cwd: item.cwd, home: ctx.home });
  if (plans === undefined || plans.length === 0) return false;
  return plans.every((plan) => {
    if (plan.wide !== undefined || plan.dir === null) return false;
    const targets = [...plan.branches];
    if (plan.current) {
      const branch = pr.currentBranch(plan.dir);
      if (branch === undefined) return false;
      targets.push(branch);
    }
    return targets.length > 0 && targets.every((b) => pr.branches.includes(b));
  });
}

function decideUnsafe(item: Item, ctx: PipelineContext): PipelineResult {
  if (item.kind !== "permission") {
    return { decision: escalate(item, "medium", "not a permission request"), apply: false };
  }
  if (item.toolCall !== undefined && item.toolCall.kind !== "app") {
    const where = { cwd: item.cwd, home: ctx.home };
    // A mass delete always goes to the owner, in every mode, whatever the rules say.
    const mass = massDeleteCheck(item.toolCall, where);
    if (mass.hit) {
      return { decision: escalate(item, "high", `mass delete: ${mass.reason}`), apply: false };
    }
    // Entries the owner added to the guard list in config.json also always ask.
    if ((ctx.extraGuards?.length ?? 0) > 0) {
      const extra = guardCheck(item.toolCall, where, ctx.extraGuards);
      if (extra.hit && ctx.extraGuards?.some((g) => g.id === extra.id)) {
        return { decision: escalate(item, "high", `guard list: ${extra.reason}`), apply: false };
      }
    }
  }
  const hit = matchRules(ctx.rules, item, ctx.home);
  // A step that leaves the Mac asks in every mode, unless the owner allowed it for this task.
  // Only an owner's deny rule beats it (stricter than asking); allow rules do not.
  if (item.toolCall !== undefined && !(hit?.action === "deny" && ctx.mode !== "observe")) {
    const out = outboundCheck(item.toolCall);
    if (out !== undefined && !(ctx.allowedSteps ?? []).includes(out.step)) {
      return {
        decision: escalate(item, "high", `${LEAVES_MAC}${out.step}: ${out.reason}`),
        apply: false,
      };
    }
    if (out !== undefined && !pullRequestMayDo(item, out, ctx)) {
      return {
        decision: escalate(item, "high", `${LEAVES_MAC}${out.step}: ${out.reason}${PR_TURN}`),
        apply: false,
      };
    }
  }
  if (hit === null) {
    if (item.toolCall?.kind === "app") return appDefault(item, ctx.mode);
    if (ctx.mode === "observe") {
      return { decision: escalate(item, "medium", "no rule matched"), apply: false };
    }
    return {
      decision: {
        itemId: item.id,
        action: "allow",
        confidence: 1,
        risk: "low",
        source: "rule",
        reason: AUTO_APPROVED,
        precedents: [],
      },
      apply: true,
    };
  }
  const ruled: Decision = {
    itemId: item.id,
    action: hit.action,
    confidence: 1,
    risk: "low",
    source: "rule",
    reason: `rule ${hit.rule.id}`,
    precedents: [],
  };
  if (ctx.mode === "observe") {
    return {
      decision: escalate(item, "low", `observe mode; rule ${hit.rule.id} would ${hit.action}`),
      apply: false,
      suggestion: ruled,
      ruleId: hit.rule.id,
    };
  }
  return { decision: ruled, apply: true, ruleId: hit.rule.id };
}

export function decide(item: Item, ctx: PipelineContext): PipelineResult {
  try {
    const result = decideUnsafe(item, ctx);
    // Defense in depth: only a rule may produce an applied decision here.
    if (result.apply && result.decision.source !== "rule") {
      return {
        decision: escalate(item, "high", "pipeline produced an unexpected decision"),
        apply: false,
      };
    }
    return result;
  } catch (error) {
    return {
      decision: escalate(item, "high", `pipeline error: ${(error as Error).message}`),
      apply: false,
    };
  }
}
