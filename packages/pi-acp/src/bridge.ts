// An ACP agent backed by Pi in RPC mode (docs/adr/0022). One Pi process per ACP session.
// Pi events become `session/update`; the gate extension's questions become
// `session/request_permission`. Pi's own dialogs from other extensions are cancelled: AgentHerd
// has no UI for them.

import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentApp,
  type AgentContext,
  agent,
  type ContentBlock,
  methods,
  PROTOCOL_VERSION,
  RequestError,
  type SessionNotification,
  type StopReason,
} from "@agentclientprotocol/sdk";
import {
  STEER_CAPABILITY,
  STEER_METHOD,
  type SteerParams,
  type SteerResponse,
} from "@agentherd/acp-client";
import { ALLOW, DENY, decodeQuestion } from "../extension/gate.ts";
import { discoverMcpTools, MCP_ENV } from "../extension/mcp.ts";
import { modelFromEnv, PI_PROVIDER } from "../extension/model.ts";
import { toolCallOf } from "./map.ts";
import { type PiRecord, PiRpc } from "./rpc.ts";

export const GATE_PATH = fileURLToPath(new URL("../extension/gate.ts", import.meta.url));
export const MCP_PATH = fileURLToPath(new URL("../extension/mcp.ts", import.meta.url));
export const MODEL_PATH = fileURLToPath(new URL("../extension/model.ts", import.meta.url));
export const BRIDGE_NAME = "pi-acp (AgentHerd)";
/**
 * Where Pi saves its sessions. When set, sessions are kept and can be opened again with
 * `session/load` (ADR 0039); otherwise Pi runs with `--no-session`.
 */
export const SESSION_DIR_ENV = "AGENTHERD_PI_SESSION_DIR";

export interface BridgeOptions {
  /** Pi's command line, for example `["pi"]` or `[node, ".../cli.js"]`. */
  pi: readonly string[];
  /** Extra Pi arguments, such as `--provider deepseek --model deepseek-flash`. */
  piArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** Diagnostics and Pi's stderr. Stdout carries ACP. */
  log?: (line: string) => void;
}

/** Rethrows so the ACP client sees the message, not a bare "Internal error". */
function fail(error: Error): never {
  throw RequestError.internalError(undefined, error.message);
}

/** A prompt's text (its text blocks, one per line) and its images, as Pi takes them. */
function promptOf(prompt: readonly ContentBlock[]): {
  text: string;
  images: { type: "image"; data: string; mimeType: string }[];
} {
  const text = prompt.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  const images = prompt.flatMap((block) =>
    block.type === "image"
      ? [{ type: "image" as const, data: block.data, mimeType: block.mimeType }]
      : [],
  );
  return { text, images };
}

/** The params of `_agentherd/steer` (ADR 0063): a session id and the message as ACP blocks. */
function steerParams(raw: unknown): SteerParams {
  const p = (raw ?? {}) as { sessionId?: unknown; prompt?: unknown };
  if (typeof p.sessionId !== "string" || !Array.isArray(p.prompt))
    throw RequestError.invalidParams(undefined, `${STEER_METHOD} needs sessionId and prompt`);
  return { sessionId: p.sessionId, prompt: p.prompt as ContentBlock[] };
}

const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

interface Turn {
  client: AgentContext;
  done: (result: { stopReason: StopReason } | Error) => void;
  error?: string;
  /** Set by `session/cancel`: the turn ends `cancelled` even if Pi finishes it normally. */
  cancelled?: boolean;
  /** The current assistant message wrote text. */
  wrote?: boolean;
  /** An earlier assistant message of this turn wrote text: the next text starts a paragraph. */
  gap?: boolean;
}

/** A message for the running turn (ADR 0063), until Pi's model sees it or the turn ends. */
interface Steer {
  done: (delivered: boolean) => void;
}

interface Session {
  id: string;
  cwd: string;
  pi: PiRpc;
  turn: Turn | null;
  /**
   * Messages sent with Pi's `steer`, oldest first. Only this bridge steers Pi, so they are Pi's
   * steering queue in the same order, plus at most one Pi has not answered yet (at the end).
   */
  steers: Steer[];
  /** Length of Pi's steering queue in its last `queue_update`. */
  queued: number;
  /** One `steer` at a time, so a message Pi refused can never be taken for one it delivered. */
  sending: Promise<void>;
}

/**
 * Pi's arguments: RPC mode, the session (saved under {@link SESSION_DIR_ENV} with the ACP session
 * id, or none), the gate, optional MCP bridge, and the owner's model if one is set.
 */
export function piArgsFor(
  piArgs: readonly string[],
  env: NodeJS.ProcessEnv,
  sessionId?: string,
): string[] {
  const dir = env[SESSION_DIR_ENV];
  const session =
    dir !== undefined && dir !== "" && sessionId !== undefined
      ? ["--session-dir", dir, "--session-id", sessionId]
      : ["--no-session"];
  const args = ["--mode", "rpc", ...session, "-e", GATE_PATH];
  if ((env[MCP_ENV] ?? "") !== "") args.push("-e", MCP_PATH);
  const model = modelFromEnv(env);
  if (model !== undefined)
    args.push("-e", MODEL_PATH, "--provider", PI_PROVIDER, "--model", model.id);
  return [...args, ...piArgs];
}

export function createPiBridge(opts: BridgeOptions): AgentApp & { closeAll(): Promise<void> } {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const sessions = new Map<string, Session>();

  function update(s: Session, update: SessionNotification["update"]): void {
    const turn = s.turn;
    if (turn === null) return;
    void turn.client
      .notify(methods.client.session.update, {
        sessionId: s.id,
        update,
      })
      .catch(() => {});
  }

  async function ask(s: Session, request: PiRecord): Promise<void> {
    const id = String(request.id);
    const cancel = () => s.pi.send({ type: "extension_ui_response", id, cancelled: true });
    const question =
      request.method === "select" ? decodeQuestion(String(request.title ?? "")) : undefined;
    if (question === undefined || s.turn === null) {
      if (DIALOGS.has(String(request.method))) cancel();
      return;
    }
    const toolCall = toolCallOf(question.toolCallId, question.toolName, question.input, s.cwd);
    try {
      const answer = await s.turn.client.request(methods.client.session.requestPermission, {
        sessionId: s.id,
        toolCall: { ...toolCall, status: "pending" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });
      const chosen = answer.outcome.outcome === "selected" ? answer.outcome.optionId : undefined;
      if (chosen === "allow-once") s.pi.send({ type: "extension_ui_response", id, value: ALLOW });
      else if (chosen === "reject-once") {
        s.pi.send({ type: "extension_ui_response", id, value: DENY });
      } else cancel();
    } catch {
      cancel();
    }
  }

  function onRecord(s: Session, r: PiRecord): void {
    switch (r.type) {
      case "queue_update": {
        // What left Pi's steering queue went to the model, oldest first.
        const queued = Array.isArray(r.steering) ? r.steering.length : 0;
        let delivered = s.queued - queued;
        s.queued = queued;
        while (delivered > 0 && s.steers.length > 0) {
          s.steers.shift()?.done(true);
          delivered -= 1;
        }
        return;
      }
      case "message_update": {
        const e = r.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
        if (e?.type === "text_delta" && typeof e.delta === "string" && e.delta !== "") {
          let text = e.delta;
          const turn = s.turn;
          if (turn !== null) {
            // Text from separate model calls (before and after a tool call, or after a message
            // read mid-turn) would otherwise run together in the reply.
            if (turn.gap === true) text = `\n\n${text}`;
            turn.gap = false;
            turn.wrote = true;
          }
          update(s, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          });
        }
        return;
      }
      case "message_end": {
        const m = r.message as { role?: string; stopReason?: string; errorMessage?: string };
        if (m?.role === "assistant" && s.turn !== null) {
          if (m.stopReason === "error") s.turn.error = m.errorMessage ?? "Pi's model call failed";
          if (s.turn.wrote === true) s.turn.gap = true;
          s.turn.wrote = false;
        }
        return;
      }
      case "tool_execution_start": {
        const args = (r.args ?? {}) as Record<string, unknown>;
        const call = toolCallOf(String(r.toolCallId), String(r.toolName), args, s.cwd);
        update(s, { sessionUpdate: "tool_call", ...call, status: "pending" });
        return;
      }
      case "tool_execution_end":
        update(s, {
          sessionUpdate: "tool_call_update",
          toolCallId: String(r.toolCallId),
          status: r.isError === true ? "failed" : "completed",
        });
        return;
      case "extension_ui_request":
        void ask(s, r);
        return;
      case "agent_settled": {
        const turn = s.turn;
        if (turn === null) return;
        s.turn = null;
        // Pi does not go on to queued messages after it settled; they come back undelivered and
        // leave its queue, so the next prompt is the only time the model sees them.
        void dropSteers(s);
        if (r.aborted === true || turn.cancelled === true) turn.done({ stopReason: "cancelled" });
        else if (turn.error !== undefined) turn.done(new Error(turn.error));
        else turn.done({ stopReason: "end_turn" });
        return;
      }
    }
  }

  /**
   * Answers every waiting message "not delivered" and clears Pi's steering queue. The clear goes
   * to Pi after any `steer` already sent, so none of them is left behind.
   */
  function dropSteers(s: Session): Promise<unknown> {
    const left = s.steers.splice(0);
    for (const steer of left) steer.done(false);
    if (left.length === 0 || !s.pi.running) return Promise.resolve();
    s.queued = 0;
    return s.pi.request({ type: "clear_queue" });
  }

  /**
   * Passes a message to the running turn with Pi's `steer` (ADR 0063).
   * @returns true once Pi's model saw it in this turn; false if the turn ended first.
   */
  function steer(s: Session, text: string, images: unknown[]): Promise<boolean> {
    const turn = s.turn;
    if (turn === null) return Promise.resolve(false);
    let resolve: (delivered: boolean) => void = () => {};
    const delivered = new Promise<boolean>((r) => {
      resolve = r;
    });
    const item: Steer = { done: (d) => resolve(d) };
    const send = async (): Promise<void> => {
      // A message for a turn that ended, or one the owner cancelled, goes as the next prompt.
      if (s.turn !== turn || turn.cancelled === true) return resolve(false);
      s.steers.push(item);
      const answer = await s.pi.request({
        type: "steer",
        message: text,
        ...(images.length === 0 ? {} : { images }),
      });
      const disposition = (answer.data as { disposition?: string } | undefined)?.disposition;
      if (answer.success && disposition !== "handled") return;
      // Refused, or taken by an input handler instead of the model: it never joins the queue.
      const at = s.steers.indexOf(item);
      if (at >= 0) s.steers.splice(at, 1);
      resolve(answer.success);
    };
    s.sending = s.sending.then(send, send);
    return delivered;
  }

  const baseEnv = (): NodeJS.ProcessEnv => ({ ...process.env, ...opts.env });
  const savesSessions = (): boolean => (baseEnv()[SESSION_DIR_ENV] ?? "") !== "";

  /**
   * Starts Pi for a session. With `load`, the session must exist in Pi's saved sessions.
   * @returns The session, after Pi answered `get_state`.
   */
  async function startPi(
    cwd: string,
    id = `pi-${randomUUID()}`,
    load = false,
    mcpServers: readonly unknown[] = [],
  ): Promise<Session> {
    const s: Session = {
      id,
      cwd,
      turn: null,
      steers: [],
      queued: 0,
      sending: Promise.resolve(),
      pi: undefined as never,
    };
    const stderr: string[] = [];
    const env = baseEnv();
    const mcp = await discoverMcpTools(mcpServers, log);
    let mcpDir: string | undefined;
    if (mcp.tools.length > 0) {
      mcpDir = mkdtempSync(join(tmpdir(), "pi-acp-mcp-"));
      if (process.platform !== "win32") chmodSync(mcpDir, 0o700);
      const mcpFile = join(mcpDir, "mcp.json");
      writeFileSync(mcpFile, JSON.stringify(mcp), { mode: 0o600 });
      env[MCP_ENV] = mcpFile;
    }
    let cleaned = false;
    const cleanup = () => {
      if (cleaned || mcpDir === undefined) return;
      cleaned = true;
      rmSync(mcpDir, { recursive: true, force: true });
    };
    try {
      s.pi = new PiRpc({
        command: opts.pi,
        args: piArgsFor(opts.piArgs ?? [], env, id),
        cwd,
        env,
        stderr: (chunk) => {
          stderr.push(chunk);
          if (stderr.length > 20) stderr.shift();
          for (const line of chunk.split("\n")) if (line !== "") log(`[pi] ${line}`);
        },
      });
      s.pi.onRecord((r) => onRecord(s, r));
      void s.pi.exited.then((e) => {
        cleanup();
        sessions.delete(s.id);
        const turn = s.turn;
        s.turn = null;
        for (const steer of s.steers.splice(0)) steer.done(false);
        turn?.done(new Error(`Pi exited (code ${e.code}, signal ${e.signal})\n${stderr.join("")}`));
      });
      const state = await s.pi.request({ type: "get_state" });
      if (!state.success) {
        await s.pi.close();
        throw new Error(`Pi did not start: ${state.error ?? "no answer"}\n${stderr.join("")}`);
      }
      if (
        load &&
        Number((state.data as { messageCount?: number } | undefined)?.messageCount ?? 0) === 0
      ) {
        await s.pi.close();
        throw new Error(`no saved Pi session ${id}`);
      }
      // Several messages that came during a step all reach the model at the next one (ADR 0063).
      void s.pi.request({ type: "set_steering_mode", mode: "all" });
      return s;
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  const app = agent({ name: BRIDGE_NAME })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: savesSessions(),
        promptCapabilities: { image: true },
        _meta: STEER_CAPABILITY,
      },
      agentInfo: { name: BRIDGE_NAME, version: "0.0.0" },
      authMethods: [],
    }))
    .onRequest(methods.agent.session.new, async ({ params }) => {
      const s = await startPi(params.cwd, undefined, false, params.mcpServers).catch(fail);
      sessions.set(s.id, s);
      return { sessionId: s.id };
    })
    .onRequest(methods.agent.session.load, async ({ params }) => {
      if (!savesSessions()) fail(new Error("this Pi bridge does not save sessions"));
      await sessions.get(params.sessionId)?.pi.close();
      const s = await startPi(params.cwd, params.sessionId, true, params.mcpServers).catch(fail);
      sessions.set(s.id, s);
      return {};
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      const s = sessions.get(params.sessionId);
      if (s === undefined) throw new Error(`unknown session ${params.sessionId}`);
      if (s.turn !== null) throw new Error("a turn is already running");
      const { text, images } = promptOf(params.prompt);
      const result = new Promise<{ stopReason: StopReason } | Error>((resolve) => {
        s.turn = { client, done: resolve };
      });
      const accepted = await s.pi.request({
        type: "prompt",
        message: text,
        ...(images.length === 0 ? {} : { images }),
      });
      if (
        !accepted.success ||
        (accepted.data as { disposition?: string })?.disposition === "handled"
      ) {
        s.turn = null;
        if (!accepted.success) fail(new Error(accepted.error ?? "Pi refused the prompt"));
        return { stopReason: "end_turn" };
      }
      const outcome = await result;
      if (outcome instanceof Error) fail(outcome);
      return outcome;
    })
    .onRequest(STEER_METHOD, steerParams, async ({ params }) => {
      const s = sessions.get(params.sessionId);
      if (s === undefined) throw new Error(`unknown session ${params.sessionId}`);
      const { text, images } = promptOf(params.prompt);
      const response: SteerResponse = { delivered: await steer(s, text, images) };
      return response;
    })
    .onNotification(methods.agent.session.cancel, async ({ params }) => {
      const s = sessions.get(params.sessionId);
      if (s === undefined || s.turn === null) return;
      s.turn.cancelled = true;
      // Pi's abort goes on to messages still queued, so they leave the queue first.
      await dropSteers(s);
      await s.pi.request({ type: "abort" });
    });

  return Object.assign(app, {
    async closeAll() {
      await Promise.all([...sessions.values()].map((s) => s.pi.close()));
    },
  });
}
