// The only place that turns AgentHerd decisions into ACP outcomes and ACP tool calls into
// AgentHerd ToolCallInfo (docs/spec/03-agents.md "ACP mapping").

import type {
  PermissionOption,
  RequestPermissionOutcome,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { ToolCallInfo } from "@agentherd/protocol";

/** One model a session offers in its `model` config option. */
export interface ModelChoice {
  /** The agent's own id, sent back in `session/set_config_option`. */
  value: string;
  name: string;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

/**
 * The models of a `session/new` or `session/load` answer's `model` config option (id or category
 * "model"), flattening grouped options. Empty when the agent names none.
 */
export function modelChoices(configOptions: unknown): ModelChoice[] {
  if (!Array.isArray(configOptions)) return [];
  const option = configOptions.find(
    (o) => isRecord(o) && (o.id === "model" || o.category === "model"),
  );
  const choices: ModelChoice[] = [];
  const add = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!isRecord(item)) continue;
      if (Array.isArray(item.options)) add(item.options);
      else if (typeof item.value === "string") {
        choices.push({ value: item.value, name: typeof item.name === "string" ? item.name : "" });
      }
    }
  };
  if (isRecord(option)) add(option.options);
  return choices;
}

/** The parts of an id like DSH's `["provider","model"]`; undefined for a plain id. */
function idParts(value: string): string[] | undefined {
  if (!value.startsWith("[")) return undefined;
  try {
    const parts: unknown = JSON.parse(value);
    return Array.isArray(parts) && parts.every((p) => typeof p === "string") ? parts : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The id a session offers model `wanted` under (ADR 0106): the id itself, else the model's own id
 * inside a compound one (DSH's `["personal-claude","claude-opus-5-5"]` for `claude-opus-5-5` or
 * `personal-claude/claude-opus-5-5`), else the display name (any case). The first the agent lists
 * wins; an unknown name goes on as it is, for the agent to refuse.
 */
export function modelValue(choices: readonly ModelChoice[], wanted: string): string {
  const exact = choices.find((c) => c.value === wanted);
  if (exact !== undefined) return exact.value;
  const byId = choices.find((c) => {
    const parts = idParts(c.value);
    return parts !== undefined && (parts.at(-1) === wanted || parts.join("/") === wanted);
  });
  if (byId !== undefined) return byId.value;
  const lower = wanted.toLowerCase();
  const byName = choices.find((c) => c.name.toLowerCase() === lower);
  return byName?.value ?? wanted;
}

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
