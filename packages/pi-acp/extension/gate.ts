// A Pi extension that asks AgentHerd before a tool call (docs/adr/0022). Pi loads it with
// `-e`; it must stay self-contained (no package imports) because Pi compiles it on its own.
// The question travels as an RPC `extension_ui_request` (`select`) whose title carries the
// call as JSON after GATE_PREFIX. Anything but "allow" blocks the call.

import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export const GATE_PREFIX = "agentherd-gate:";
export const ALLOW = "allow";
export const DENY = "deny";
/** Tools that only read; they run without asking when they stay inside the session folder. */
export const READ_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];
const MCP_ENV = "AGENTHERD_PI_MCP";
const BUILTIN_TOOLS: readonly string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export interface GateQuestion {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** The parts of Pi's extension API the gate uses (Pi 1.5.0 `ExtensionAPI`). */
export interface GateApi {
  on(
    event: "tool_call",
    handler: (
      event: { toolCallId: string; toolName: string; input: Record<string, unknown> },
      ctx: {
        cwd: string;
        hasUI: boolean;
        ui: { select(title: string, options: string[]): Promise<string | undefined> };
      },
    ) => Promise<{ block: true; reason: string } | undefined>,
  ): void;
}

export function encodeQuestion(q: GateQuestion): string {
  return GATE_PREFIX + JSON.stringify(q);
}

/** @returns The question, or `undefined` when the title is not from the gate. */
export function decodeQuestion(title: string): GateQuestion | undefined {
  if (!title.startsWith(GATE_PREFIX)) return undefined;
  try {
    const q = JSON.parse(title.slice(GATE_PREFIX.length)) as Partial<GateQuestion>;
    if (typeof q.toolCallId !== "string" || typeof q.toolName !== "string") return undefined;
    const input = typeof q.input === "object" && q.input !== null ? q.input : {};
    return { toolCallId: q.toolCallId, toolName: q.toolName, input };
  } catch {
    return undefined;
  }
}

function inside(cwd: string, path: unknown): boolean {
  if (path === undefined) return true;
  if (typeof path !== "string") return false;
  const rel = relative(cwd, resolve(cwd, path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Reads trusted MCP tool names from `AGENTHERD_PI_MCP`. Fails closed (empty set). */
export function trustedMcpTools(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const path = env[MCP_ENV];
  if (path === undefined || path === "") return new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      tools?: { name?: unknown; trusted?: unknown }[];
    };
    const out = new Set<string>();
    for (const tool of Array.isArray(parsed.tools) ? parsed.tools : []) {
      if (
        tool?.trusted === true &&
        typeof tool.name === "string" &&
        !BUILTIN_TOOLS.includes(tool.name)
      ) {
        out.add(tool.name);
      }
    }
    return out;
  } catch {
    return new Set();
  }
}

/**
 * True when the call may run without asking: a read tool inside the session folder, or a
 * trusted `agentherd` gateway tool (whose own approval pipeline handles confirmations).
 */
export function runsWithoutAsking(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  trusted?: ReadonlySet<string>,
): boolean {
  if (!BUILTIN_TOOLS.includes(toolName) && trusted?.has(toolName) === true) return true;
  return READ_TOOLS.includes(toolName) && inside(cwd, input.path);
}

export default function gate(pi: GateApi): void {
  const trusted = trustedMcpTools(process.env);
  pi.on("tool_call", async (event, ctx) => {
    if (runsWithoutAsking(event.toolName, event.input, ctx.cwd, trusted)) return undefined;
    if (!ctx.hasUI) return { block: true, reason: "AgentHerd could not ask the owner." };
    const answer = await ctx.ui.select(
      encodeQuestion({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
      }),
      [ALLOW, DENY],
    );
    if (answer === ALLOW) return undefined;
    return { block: true, reason: "The owner did not allow this in AgentHerd." };
  });
}
