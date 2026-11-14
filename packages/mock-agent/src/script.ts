// The mock agent script format (docs/spec/03-agents.md "Mock agent"). A script is a list of
// turns. Each `session/prompt` plays the next turn; when the turns run out the agent answers
// "no more turns" and ends the turn.

import { parse } from "yaml";

export type PermissionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";
export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "other";

export interface ScriptToolCall {
  id: string;
  title: string;
  kind: ToolKind;
  command?: string;
  paths?: string[];
}

export interface ScriptOption {
  id: string;
  kind: PermissionKind;
  name: string;
}

export type Expectation = "allow" | "deny" | "cancelled";

export type Step =
  | { type: "message"; text: string }
  /** Replies with the prompt text it got (tests check what AgentHerd sent). */
  | { type: "echo_prompt" }
  | { type: "stderr"; text: string }
  | { type: "tool_call"; toolCall: ScriptToolCall; status: "pending" | "completed" | "failed" }
  | {
      type: "request_permission";
      toolCall: ScriptToolCall;
      options: ScriptOption[];
      expect?: Expectation;
      onReject: "end_turn" | "continue";
    }
  | { type: "sleep"; ms: number }
  /**
   * Waits up to `ms` for messages sent during the turn (`steer: true`), then reads every one
   * that came: each is answered "delivered" and replied with "Read: <text>".
   */
  | { type: "read_steers"; ms: number }
  /** Calls a tool on the session's first stdio MCP server; the result becomes a message. */
  | { type: "mcp_call"; tool: string; arguments: Record<string, unknown> }
  | { type: "crash"; code: number }
  | { type: "end_turn"; stopReason: "end_turn" | "refusal" | "max_tokens" };

export interface Script {
  name: string;
  turns: Step[][];
  /** Offer `session/load`; a loaded session plays the turns from the start. */
  loadSession?: boolean;
  /** Take messages during a running turn (AgentHerd's steer extension, ADR 0063). */
  steer?: boolean;
}

export class ScriptError extends Error {
  override name = "ScriptError";
}

export const DEFAULT_OPTIONS: readonly ScriptOption[] = [
  { id: "allow", kind: "allow_once", name: "Allow" },
  { id: "always", kind: "allow_always", name: "Always allow" },
  { id: "reject", kind: "reject_once", name: "Reject" },
];

const TOOL_KINDS: readonly string[] = [
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "other",
];
const PERMISSION_KINDS: readonly string[] = [
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
];

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, where: string): string {
  if (typeof v !== "string") throw new ScriptError(`${where}: expected a string`);
  return v;
}

function strList(v: unknown, where: string): string[] {
  if (!Array.isArray(v)) throw new ScriptError(`${where}: expected a list of strings`);
  return v.map((x, i) => str(x, `${where}[${i}]`));
}

function oneOf<T extends string>(v: unknown, allowed: readonly string[], where: string): T {
  const s = str(v, where);
  if (!allowed.includes(s)) {
    throw new ScriptError(`${where}: expected one of ${allowed.join(", ")}, got "${s}"`);
  }
  return s as T;
}

function toolCall(v: unknown, where: string): ScriptToolCall {
  if (!isObj(v)) throw new ScriptError(`${where}: expected a mapping`);
  const call: ScriptToolCall = {
    id: str(v.id, `${where}.id`),
    title: str(v.title, `${where}.title`),
    kind: v.kind === undefined ? "other" : oneOf<ToolKind>(v.kind, TOOL_KINDS, `${where}.kind`),
  };
  if (v.command !== undefined) call.command = str(v.command, `${where}.command`);
  if (v.paths !== undefined) call.paths = strList(v.paths, `${where}.paths`);
  return call;
}

function options(v: unknown, where: string): ScriptOption[] {
  if (v === undefined) return [...DEFAULT_OPTIONS];
  if (!Array.isArray(v) || v.length === 0) throw new ScriptError(`${where}: expected a list`);
  return v.map((o, i) => {
    const w = `${where}[${i}]`;
    if (!isObj(o)) throw new ScriptError(`${w}: expected a mapping`);
    return {
      id: str(o.id, `${w}.id`),
      kind: oneOf<PermissionKind>(o.kind, PERMISSION_KINDS, `${w}.kind`),
      name: str(o.name, `${w}.name`),
    };
  });
}

function step(v: unknown, where: string): Step {
  if (!isObj(v)) throw new ScriptError(`${where}: expected a mapping`);
  const keys = Object.keys(v);
  if (keys.length !== 1) throw new ScriptError(`${where}: expected exactly one step key`);
  const key = keys[0] as string;
  const body = v[key];
  const w = `${where}.${key}`;
  switch (key) {
    case "message":
      return { type: "message", text: str(body, w) };
    case "stderr":
      return { type: "stderr", text: str(body, w) };
    case "echo_prompt":
      return { type: "echo_prompt" };
    case "tool_call": {
      const status = isObj(body) && body.status !== undefined ? body.status : "completed";
      return {
        type: "tool_call",
        toolCall: toolCall(body, w),
        status: oneOf(status, ["pending", "completed", "failed"], `${w}.status`),
      };
    }
    case "request_permission": {
      if (!isObj(body)) throw new ScriptError(`${w}: expected a mapping`);
      const s: Step = {
        type: "request_permission",
        toolCall: toolCall(body.toolCall, `${w}.toolCall`),
        options: options(body.options, `${w}.options`),
        onReject:
          body.on_reject === undefined
            ? "end_turn"
            : oneOf(body.on_reject, ["end_turn", "continue"], `${w}.on_reject`),
      };
      if (body.expect !== undefined) {
        s.expect = oneOf<Expectation>(body.expect, ["allow", "deny", "cancelled"], `${w}.expect`);
      }
      return s;
    }
    case "mcp_call": {
      if (!isObj(body)) throw new ScriptError(`${w}: expected a mapping`);
      const args = body.arguments ?? {};
      if (!isObj(args)) throw new ScriptError(`${w}.arguments: expected a mapping`);
      return { type: "mcp_call", tool: str(body.tool, `${w}.tool`), arguments: args };
    }
    case "sleep": {
      if (typeof body !== "number" || body < 0) throw new ScriptError(`${w}: expected ms >= 0`);
      return { type: "sleep", ms: body };
    }
    case "read_steers": {
      if (typeof body !== "number" || body < 0) throw new ScriptError(`${w}: expected ms >= 0`);
      return { type: "read_steers", ms: body };
    }
    case "crash": {
      const code = body === null || body === undefined ? 1 : body;
      if (typeof code !== "number") throw new ScriptError(`${w}: expected an exit code`);
      return { type: "crash", code };
    }
    case "end_turn": {
      const reason = body === null || body === undefined ? "end_turn" : body;
      return {
        type: "end_turn",
        stopReason: oneOf(reason, ["end_turn", "refusal", "max_tokens"], w),
      };
    }
    default:
      throw new ScriptError(`${where}: unknown step "${key}"`);
  }
}

/** Parses and validates a YAML script. Throws `ScriptError` with the location of the problem. */
export function parseScript(text: string): Script {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (error) {
    throw new ScriptError(`invalid YAML: ${(error as Error).message}`);
  }
  if (!isObj(doc)) throw new ScriptError("script: expected a mapping");
  if (!Array.isArray(doc.turns)) throw new ScriptError("turns: expected a list");
  if (doc.load_session !== undefined && typeof doc.load_session !== "boolean") {
    throw new ScriptError("load_session: expected true or false");
  }
  if (doc.steer !== undefined && typeof doc.steer !== "boolean") {
    throw new ScriptError("steer: expected true or false");
  }
  return {
    ...(doc.load_session === true ? { loadSession: true } : {}),
    ...(doc.steer === true ? { steer: true } : {}),
    name: doc.name === undefined ? "mock-agent" : str(doc.name, "name"),
    turns: doc.turns.map((turn, t) => {
      if (!Array.isArray(turn)) throw new ScriptError(`turns[${t}]: expected a list of steps`);
      return turn.map((s, i) => step(s, `turns[${t}][${i}]`));
    }),
  };
}
