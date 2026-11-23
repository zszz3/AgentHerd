// The only place that turns AgentHerd decisions into ACP outcomes and ACP tool calls into
// AgentHerd ToolCallInfo (docs/spec/03-agents.md "ACP mapping").

import type {
  PermissionOption,
  RequestPermissionOutcome,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { ToolCallInfo } from "@agentherd/protocol";

export type PermissionAnswer = { kind: "allow" } | { kind: "deny" } | { kind: "cancelled" };

/**
 * `allow` → the `allow_once` option, never `allow_always`: an "always" rule lives in AgentHerd,
 * not in the agent. `deny` → `reject_once`, else any `reject_*`. Otherwise `cancelled`.
 */
export function toAcpOutcome(
  answer: PermissionAnswer,
  options: readonly PermissionOption[],
): RequestPermissionOutcome {
  const pick = (kinds: readonly string[]): RequestPermissionOutcome => {
    for (const kind of kinds) {
      const option = options.find((o) => o.kind === kind);
      if (option !== undefined) return { outcome: "selected", optionId: option.optionId };
    }
    return { outcome: "cancelled" };
  };
  switch (answer.kind) {
    case "allow":
      return pick(["allow_once"]);
    case "deny":
      return pick(["reject_once", "reject_always"]);
    case "cancelled":
      return { outcome: "cancelled" };
  }
}

function commandOf(rawInput: unknown): string | undefined {
  if (typeof rawInput !== "object" || rawInput === null) return undefined;
  // Antigravity names it CommandLine (`run_command`, ADR 0104).
  const input = rawInput as { command?: unknown; CommandLine?: unknown };
  const command = input.command ?? input.CommandLine;
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((c) => typeof c === "string")) {
    return command.join(" ");
  }
  return undefined;
}

export function toToolCallInfo(call: ToolCallUpdate): ToolCallInfo {
  const info: ToolCallInfo = {
    kind: call.kind ?? "other",
    title: call.title ?? call.toolCallId,
    paths: (call.locations ?? []).map((l) => l.path),
  };
  const command = commandOf(call.rawInput);
  if (command !== undefined) info.command = command;
  if (call.rawInput !== undefined && call.rawInput !== null) info.rawInput = call.rawInput;
  return info;
}

/**
 * Merges ACP tool call updates by `toolCallId`. ACP sends a tool call once and later only the
 * changed fields; a permission request's `toolCall` may carry only the id (DSH does this).
 * Fields that are `undefined` or `null` in an update keep their earlier value.
 */
export class ToolCallTracker {
  private readonly calls = new Map<string, ToolCallUpdate>();

  /** Records an update and returns the merged tool call. */
  merge(sessionId: string, update: ToolCallUpdate): ToolCallUpdate {
    const key = `${sessionId}\u0000${update.toolCallId}`;
    const merged: ToolCallUpdate = { ...this.calls.get(key), toolCallId: update.toolCallId };
    for (const [field, value] of Object.entries(update)) {
      if (value !== undefined && value !== null) (merged as Record<string, unknown>)[field] = value;
    }
    this.calls.set(key, merged);
    return merged;
  }

  /** Forgets all tool calls of a session. */
  clear(sessionId: string): void {
    for (const key of this.calls.keys())
      if (key.startsWith(`${sessionId}\u0000`)) this.calls.delete(key);
  }
}
