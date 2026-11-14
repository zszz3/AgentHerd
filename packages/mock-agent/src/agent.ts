// A real ACP agent that plays a script (docs/spec/03-agents.md "Mock agent"). It speaks the
// same protocol as DSH or claude-agent-acp, so the client under test cannot tell the difference.

import {
  type AgentApp,
  type AgentContext,
  agent,
  methods,
  type PermissionOptionKind,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type StopReason,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import { callTool } from "./mcp-call.ts";
import type { Expectation, Script, ScriptToolCall, Step } from "./script.ts";

export interface MockAgentOptions {
  /** Called by a `crash` step. Defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Diagnostics. Defaults to stderr; stdout carries the protocol. */
  log?: (line: string) => void;
}

/** What the mock saw for one `request_permission` step; tests read it through `log`. */
export interface PermissionResult {
  toolCallId: string;
  outcome: Expectation;
  optionId?: string;
}

interface SessionState {
  turn: number;
  abort: AbortController | null;
  /** The stdio MCP servers the client passed for this session. */
  mcpServers: McpServerInfo[];
  /** Messages sent during the running turn (`steer: true`), not read yet. */
  steers: { text: string; done: (delivered: boolean) => void }[];
  /** Wakes a `read_steers` step that waits for a message. */
  steerCame?: (() => void) | undefined;
}

/** AgentHerd's ACP extension for a message during a running turn (ADR 0063). */
const STEER_METHOD = "_agentherd/steer";

interface SteerParams {
  sessionId: string;
  prompt: { type: string; text?: string }[];
}

function steerParams(raw: unknown): SteerParams {
  const p = (raw ?? {}) as { sessionId?: unknown; prompt?: unknown };
  if (typeof p.sessionId !== "string" || !Array.isArray(p.prompt))
    throw new Error(`${STEER_METHOD} needs sessionId and prompt`);
  return { sessionId: p.sessionId, prompt: p.prompt as SteerParams["prompt"] };
}

interface McpServerInfo {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

function stdioServers(servers: unknown, log: (line: string) => void): McpServerInfo[] {
  const out: McpServerInfo[] = [];
  for (const s of Array.isArray(servers) ? servers : []) {
    if (typeof s !== "object" || s === null || !("command" in s)) continue;
    const server = s as McpServerInfo;
    log(`mcp ${server.name} ${server.command}`);
    out.push(server);
  }
  return out;
}

class Cancelled extends Error {}

function toAcpToolCall(call: ScriptToolCall, status: ToolCallUpdate["status"]): ToolCallUpdate {
  const update: ToolCallUpdate = {
    toolCallId: call.id,
    title: call.title,
    kind: call.kind,
    status: status ?? null,
    locations: (call.paths ?? []).map((path) => ({ path })),
  };
  if (call.command !== undefined) update.rawInput = { command: call.command };
  return update;
}

function outcomeOf(kind: PermissionOptionKind | undefined): Expectation {
  if (kind === "allow_once" || kind === "allow_always") return "allow";
  if (kind === "reject_once" || kind === "reject_always") return "deny";
  return "cancelled";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Cancelled());
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Cancelled());
      },
      { once: true },
    );
  });
}

/** Waits up to `ms` for a message sent during the turn. */
function nextSteer(state: SessionState, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Cancelled());
    const finish = () => {
      clearTimeout(timer);
      state.steerCame = undefined;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    state.steerCame = finish;
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        state.steerCame = undefined;
        reject(new Cancelled());
      },
      { once: true },
    );
  });
}

export function createMockAgent(script: Script, options: MockAgentOptions = {}): AgentApp {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ?? ((line: string) => process.stderr.write(`[mock-agent] ${line}\n`));
  const sessions = new Map<string, SessionState>();
  let nextSession = 1;

  async function play(
    client: AgentContext,
    sessionId: string,
    steps: Step[],
    signal: AbortSignal,
    promptText = "",
  ): Promise<StopReason> {
    for (const step of steps) {
      if (signal.aborted) throw new Cancelled();
      switch (step.type) {
        case "message":
          await client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: step.text },
            },
          });
          break;
        case "echo_prompt":
          await client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: promptText },
            },
          });
          break;
        case "stderr":
          log(step.text);
          break;
        case "mcp_call": {
          const server = sessions.get(sessionId)?.mcpServers[0];
          const text =
            server === undefined
              ? "error: no MCP server"
              : await callTool(server, step.tool, step.arguments);
          log(`mcp_call ${step.tool}: ${text}`);
          await client.notify(methods.client.session.update, {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
          });
          break;
        }
        case "tool_call":
          await client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              ...toAcpToolCall(step.toolCall, step.status),
              title: step.toolCall.title,
              kind: step.toolCall.kind,
            },
          });
          break;
        case "request_permission": {
          const params: RequestPermissionRequest = {
            sessionId,
            toolCall: toAcpToolCall(step.toolCall, "pending"),
            options: step.options.map((o) => ({ optionId: o.id, name: o.name, kind: o.kind })),
          };
          const response = await client.request(methods.client.session.requestPermission, params);
          const selected =
            response.outcome.outcome === "selected" ? response.outcome.optionId : undefined;
          const kind = step.options.find((o) => o.id === selected)?.kind;
          const outcome = outcomeOf(kind);
          const result: PermissionResult = { toolCallId: step.toolCall.id, outcome };
          if (selected !== undefined) result.optionId = selected;
          log(`permission ${JSON.stringify(result)}`);
          if (step.expect !== undefined && step.expect !== outcome) {
            log(`expect failed: wanted ${step.expect}, got ${outcome}`);
            exit(3);
            return "refusal";
          }
          if (outcome === "cancelled") throw new Cancelled();
          if (outcome === "deny" && step.onReject === "end_turn") return "end_turn";
          break;
        }
        case "sleep":
          await sleep(step.ms, signal);
          break;
        case "read_steers": {
          const state = sessions.get(sessionId);
          if (state === undefined) break;
          if (state.steers.length === 0) await nextSteer(state, step.ms, signal);
          const read = state.steers.splice(0);
          for (const steer of read) {
            log(`steer read: ${steer.text}`);
            steer.done(true);
          }
          // Like a model at its next step: the answers go out before anything it writes.
          if (read.length > 0) await new Promise((resolve) => setImmediate(resolve));
          for (const steer of read) {
            await client.notify(methods.client.session.update, {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `Read: ${steer.text}` },
              },
            });
          }
          break;
        }
        case "crash":
          log(`crash with code ${step.code}`);
          exit(step.code);
          return "refusal";
        case "end_turn":
          return step.stopReason;
      }
    }
    return "end_turn";
  }

  return agent({ name: script.name })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: script.loadSession === true,
        ...(script.steer === true ? { _meta: { agentherd: { steer: true } } } : {}),
      },
      agentInfo: { name: script.name, version: "0.0.0" },
      authMethods: [],
    }))
    .onRequest(methods.agent.session.new, ({ params }) => {
      const sessionId = `mock-${nextSession++}`;
      const mcpServers = stdioServers(params.mcpServers, log);
      sessions.set(sessionId, { turn: 0, abort: null, mcpServers, steers: [] });
      return { sessionId };
    })
    .onRequest(methods.agent.session.load, ({ params }) => {
      if (script.loadSession !== true) throw new Error("session/load is not supported");
      log(`load ${params.sessionId}`);
      const mcpServers = stdioServers(params.mcpServers, log);
      sessions.set(params.sessionId, { turn: 0, abort: null, mcpServers, steers: [] });
      return {};
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      const state = sessions.get(params.sessionId);
      if (state === undefined) throw new Error(`unknown session ${params.sessionId}`);
      if (state.abort !== null) throw new Error("a turn is already running");
      const steps = script.turns[state.turn];
      state.turn += 1;
      const abort = new AbortController();
      state.abort = abort;
      try {
        if (steps === undefined) {
          await play(
            client,
            params.sessionId,
            [{ type: "message", text: "no more turns" }],
            abort.signal,
          );
          return { stopReason: "end_turn" };
        }
        const text = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("\n");
        return { stopReason: await play(client, params.sessionId, steps, abort.signal, text) };
      } catch (error) {
        if (error instanceof Cancelled || abort.signal.aborted) return { stopReason: "cancelled" };
        throw error;
      } finally {
        state.abort = null;
        // The turn is over: what it did not read goes back to the client as the next prompt.
        for (const steer of state.steers.splice(0)) {
          log(`steer not read: ${steer.text}`);
          steer.done(false);
        }
      }
    })
    .onRequest(STEER_METHOD, steerParams, async ({ params }) => {
      const state = sessions.get(params.sessionId);
      if (script.steer !== true || state === undefined || state.abort === null)
        return { delivered: false };
      const text = params.prompt.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("\n");
      log(`steer came: ${text}`);
      const delivered = await new Promise<boolean>((done) => {
        state.steers.push({ text, done });
        state.steerCame?.();
      });
      return { delivered };
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      sessions.get(params.sessionId)?.abort?.abort();
    });
}
