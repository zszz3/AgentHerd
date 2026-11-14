// Starts an agent CLI as an ACP server over stdio and exposes the small surface core needs
// (docs/spec/03-agents.md). AgentHerd is the ACP client: it offers no fs and no terminal, so
// every action of the agent goes through its own tools and asks permission through ACP.

import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  type ClientConnection,
  type ContentBlock,
  client,
  methods,
  type NewSessionResponse,
  ndJsonStream,
  type PermissionOption,
  PROTOCOL_VERSION,
  type SessionNotification,
  type StopReason,
} from "@agentclientprotocol/sdk";
import type { AgentProfile, ToolCallInfo } from "@agentherd/protocol";
import { redact } from "@agentherd/rules";
import { commandLine, killTree } from "./command.ts";
import { type PermissionAnswer, ToolCallTracker, toAcpOutcome, toToolCallInfo } from "./mapping.ts";

export const STDERR_LINES = 200;
/** How long close() waits after SIGTERM before SIGKILL. */
export const CLOSE_GRACE_MS = 3000;
/** How long a failed request waits for the process exit to explain it. */
const EXIT_GRACE_MS = 1000;

export interface StartOptions {
  cwd: string;
  env?: Record<string, string>;
  /** Kills the agent (SIGKILL) when aborted, e.g. a check that gave up waiting. */
  signal?: AbortSignal;
}

export interface SessionUpdateEvent {
  sessionId: string;
  type: "message" | "tool_call" | "tool_call_update" | "plan" | "other";
  text?: string;
  toolCallId?: string;
  toolCall?: ToolCallInfo;
  status?: string;
}

export interface PermissionRequest {
  sessionId: string;
  /** Unique within one connection. */
  requestId: string;
  toolCallId: string;
  toolCall: ToolCallInfo;
  options: { id: string; kind: string; name: string }[];
  /** Answers the agent. Only the first call counts; it returns false for later calls. */
  respond(answer: PermissionAnswer): boolean;
  readonly answered: boolean;
}

export interface ExitEvent {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Last lines of stderr, redacted. */
  stderr: string[];
}

/** An image for a prompt; `data` is base64. */
export interface PromptImage {
  data: string;
  mimeType: string;
}

/**
 * AgentHerd's ACP extension for a message during a running turn (ADR 0063). An agent that takes
 * it says so with `agentCapabilities._meta.agentherd.steer: true`. The request answers once the
 * agent showed the message to its model in that turn (`delivered: true`), or once the turn ended
 * without it (`delivered: false`: send it as the next prompt).
 */
export const STEER_METHOD = "_agentherd/steer";

export interface SteerParams {
  sessionId: string;
  prompt: ContentBlock[];
}

export interface SteerResponse {
  delivered: boolean;
}

/** The capability an agent advertises in `initialize` when it takes `STEER_METHOD`. */
export const STEER_CAPABILITY = { agentherd: { steer: true } } as const;

/** Whether `initialize` advertised `STEER_METHOD`. */
export function takesSteering(capabilities: { _meta?: unknown } | undefined): boolean {
  const meta = capabilities?._meta as { agentherd?: { steer?: unknown } } | null | undefined;
  return meta?.agentherd?.steer === true;
}

interface Events {
  update: SessionUpdateEvent;
  permission: PermissionRequest;
  exit: ExitEvent;
}

type Listener<T> = (event: T) => void;

/** A stdio MCP server an agent starts for a session (ACP `McpServerStdio`). */
export interface StdioMcpServer {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

export interface AgentConnection {
  readonly profile: AgentProfile;
  readonly agentName: string;
  /** `agentInfo.version` from initialize, when the agent sends it. */
  readonly agentVersion: string | undefined;
  /** Ways to sign in the agent offers (ACP `authMethods`); empty when it needs none. */
  readonly authMethods: { id: string; name: string; description?: string }[];
  readonly pid: number | undefined;
  /** `mcpServers` are stdio MCP servers the agent starts for this session. */
  newSession(cwd: string, mcpServers?: StdioMcpServer[]): Promise<string>;
  /** Whether the agent can open a session it saved earlier (ACP `loadSession`). */
  readonly loadsSessions: boolean;
  /**
   * Opens a session the agent saved earlier (ACP `session/load`), so it keeps its own context.
   * Only when `loadsSessions` is true.
   */
  loadSession(sessionId: string, cwd: string, mcpServers?: StdioMcpServer[]): Promise<void>;
  /** Whether the agent takes image blocks in a prompt (ACP `promptCapabilities.image`). */
  readonly acceptsImages: boolean;
  /** Images go only to an agent that accepts them; others get the text alone. */
  prompt(
    sessionId: string,
    text: string,
    images?: PromptImage[],
  ): Promise<{ stopReason: StopReason }>;
  /** Whether the agent takes a message during a running turn (ADR 0063, `STEER_METHOD`). */
  readonly steers: boolean;
  /**
   * Gives the session's running turn one more message; the agent's model sees it at its next
   * step. Images go only to an agent that accepts them.
   * @returns true once the agent read it in that turn; false when the turn ended first, no turn
   *   was running, or the agent does not take it. Send it as the next prompt then.
   */
  steer(sessionId: string, text: string, images?: PromptImage[]): Promise<boolean>;
  /** Sends `session/cancel` and answers the session's open permission requests `cancelled`. */
  cancel(sessionId: string): Promise<void>;
  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void;
  /** Last lines of stderr, redacted. */
  stderr(): string[];
  close(): Promise<void>;
}

function toUpdateEvent(n: SessionNotification, tracker: ToolCallTracker): SessionUpdateEvent {
  const u = n.update;
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
      return {
        sessionId: n.sessionId,
        type: "message",
        text: u.content.type === "text" ? u.content.text : "",
      };
    case "tool_call":
    case "tool_call_update": {
      const event: SessionUpdateEvent = {
        sessionId: n.sessionId,
        type: u.sessionUpdate,
        toolCallId: u.toolCallId,
        toolCall: toToolCallInfo(tracker.merge(n.sessionId, u)),
      };
      if (u.status !== undefined && u.status !== null) event.status = u.status;
      return event;
    }
    case "plan":
      return { sessionId: n.sessionId, type: "plan" };
    default:
      return { sessionId: n.sessionId, type: "other" };
  }
}

class Emitter {
  private listeners = new Map<string, Set<Listener<never>>>();
  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => set.delete(listener as Listener<never>);
  }
  emit<K extends keyof Events>(event: K, value: Events[K]): void {
    for (const l of this.listeners.get(event) ?? []) (l as Listener<Events[K]>)(value);
  }
}

class StderrRing {
  private lines: string[] = [];
  private partial = "";
  private readonly secrets: Record<string, string>;
  constructor(secrets: Record<string, string>) {
    this.secrets = secrets;
  }
  push(chunk: string): void {
    const parts = (this.partial + chunk).split("\n");
    this.partial = parts.pop() ?? "";
    for (const line of parts) this.add(line);
  }
  private add(line: string): void {
    this.lines.push(redact(line, this.secrets));
    if (this.lines.length > STDERR_LINES) this.lines.shift();
  }
  snapshot(): string[] {
    return this.partial === ""
      ? [...this.lines]
      : [...this.lines, redact(this.partial, this.secrets)];
  }
}

export async function startAgent(
  profile: AgentProfile,
  options: StartOptions,
): Promise<AgentConnection> {
  const [command, ...args] = profile.command;
  if (command === undefined) throw new Error(`profile ${profile.id} has an empty command`);
  const extraEnv = { ...profile.env, ...options.env };
  const line = commandLine(command, args);
  const child: ChildProcess = spawn(line.command, line.args, {
    cwd: options.cwd,
    env: { ...process.env, ...line.env, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  options.signal?.addEventListener(
    "abort",
    () => {
      if (child.exitCode === null && child.signalCode === null) killTree(child, "SIGKILL");
    },
    { once: true },
  );
  const ring = new StderrRing(extraEnv);
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => ring.push(chunk));

  const emitter = new Emitter();
  const open = new Map<string, PermissionRequest & { cancel(): void }>();
  let nextRequest = 1;
  const tracker = new ToolCallTracker();

  const exited = new Promise<ExitEvent>((resolve) => {
    let done = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return;
      done = true;
      for (const request of open.values()) request.cancel();
      const event = { code, signal, stderr: ring.snapshot() };
      emitter.emit("exit", event);
      resolve(event);
    };
    child.on("exit", finish);
    child.on("error", (error) => {
      ring.push(`spawn error: ${error.message}\n`);
      finish(null, null);
    });
  });

  const app = client({ name: "agentherd" })
    .onNotification(methods.client.session.update, ({ params }) => {
      emitter.emit("update", toUpdateEvent(params, tracker));
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      const acpOptions: PermissionOption[] = params.options;
      return new Promise((resolve) => {
        let answered = false;
        const requestId = `p${nextRequest++}`;
        const settle = (answer: PermissionAnswer): boolean => {
          if (answered) return false;
          answered = true;
          open.delete(requestId);
          resolve({ outcome: toAcpOutcome(answer, acpOptions) });
          return true;
        };
        const request = {
          sessionId: params.sessionId,
          requestId,
          toolCallId: params.toolCall.toolCallId,
          toolCall: toToolCallInfo(tracker.merge(params.sessionId, params.toolCall)),
          options: acpOptions.map((o) => ({ id: o.optionId, kind: o.kind, name: o.name })),
          respond: settle,
          get answered() {
            return answered;
          },
          cancel: () => settle({ kind: "cancelled" }),
        };
        open.set(requestId, request);
        emitter.emit("permission", request);
      });
    });

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin as Writable) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout as Readable) as ReadableStream<Uint8Array>,
  );
  const connection: ClientConnection = app.connect(stream);
  const agent = connection.agent;

  const exitError = (e: ExitEvent) =>
    new Error(
      `agent ${profile.id} exited (code ${e.code}, signal ${e.signal})\n${e.stderr.join("\n")}`,
    );
  const failOnExit = exited.then((e) => {
    throw exitError(e);
  });
  failOnExit.catch(() => {});
  // A request also fails when the agent closes stdout. If the process is exiting, report the
  // exit and its stderr instead of the bare "connection closed".
  const whileAlive = <T>(p: Promise<T>): Promise<T> =>
    Promise.race([p, failOnExit]).catch(async (error: unknown) => {
      const timeout = new Promise<null>((r) => setTimeout(() => r(null), EXIT_GRACE_MS).unref());
      const e = await Promise.race([exited, timeout]);
      throw e === null ? error : exitError(e);
    });

  let init: Awaited<ReturnType<typeof initialize>>;
  const initialize = () =>
    agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "agentherd", version: "0.0.0" },
    });
  // SIGTERM, then SIGKILL after a grace period for an agent that ignores SIGTERM.
  const terminate = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    killTree(child, "SIGTERM");
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) killTree(child, "SIGKILL");
    }, CLOSE_GRACE_MS);
    force.unref();
    void exited.then(() => clearTimeout(force));
  };
  try {
    init = await whileAlive(initialize());
  } catch (error) {
    terminate();
    throw error;
  }

  /** The prompt as ACP blocks; images only for an agent that accepts them. */
  const blocks = (text: string, images: PromptImage[]): ContentBlock[] => {
    const accepted = init.agentCapabilities?.promptCapabilities?.image === true ? images : [];
    const prompt: ContentBlock[] = [{ type: "text", text }];
    for (const i of accepted) prompt.push({ type: "image", data: i.data, mimeType: i.mimeType });
    return prompt;
  };

  return {
    profile,
    agentName: init.agentInfo?.name ?? profile.name,
    agentVersion: init.agentInfo?.version,
    authMethods: (init.authMethods ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      ...(m.description ? { description: m.description } : {}),
    })),
    pid: child.pid,
    acceptsImages: init.agentCapabilities?.promptCapabilities?.image === true,
    loadsSessions: init.agentCapabilities?.loadSession === true,
    async loadSession(sessionId, cwd, mcpServers = []) {
      await whileAlive(agent.request(methods.agent.session.load, { sessionId, cwd, mcpServers }));
    },
    async newSession(cwd, mcpServers = []) {
      const res: NewSessionResponse = await whileAlive(
        agent.request(methods.agent.session.new, { cwd, mcpServers }),
      );
      return res.sessionId;
    },
    async prompt(sessionId, text, images = []) {
      const prompt = blocks(text, images);
      const res = await whileAlive(
        agent.request(methods.agent.session.prompt, { sessionId, prompt }),
      );
      return { stopReason: res.stopReason };
    },
    steers: takesSteering(init.agentCapabilities),
    async steer(sessionId, text, images = []) {
      if (!takesSteering(init.agentCapabilities)) return false;
      const params: SteerParams = { sessionId, prompt: blocks(text, images) };
      try {
        const res = await whileAlive(agent.request<SteerResponse>(STEER_METHOD, params));
        return res?.delivered === true;
      } catch {
        // Whatever went wrong, the message did not reach the turn; it goes as the next prompt.
        return false;
      }
    },
    async cancel(sessionId) {
      for (const request of [...open.values()]) {
        if (request.sessionId === sessionId) request.cancel();
      }
      await agent.notify(methods.agent.session.cancel, { sessionId });
    },
    on: (event, listener) => emitter.on(event, listener),
    stderr: () => ring.snapshot(),
    async close() {
      connection.close();
      terminate();
      await exited;
    },
  };
}
