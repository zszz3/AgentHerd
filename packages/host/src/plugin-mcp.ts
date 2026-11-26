// Talking to a plugin's MCP server (ADR 0094): a local program over stdio (newline-delimited
// JSON-RPC) or a server over Streamable HTTP. One client per server; it starts on first use,
// says initialize once, and lists or calls tools.

import { type ChildProcess, spawn } from "node:child_process";
import { killTree } from "@agentherd/acp-client";
import type { McpTool } from "@agentherd/core";

export const MCP_PROTOCOL = "2025-06-18";
/** Starting may download the server first (npx, uvx): give it time. */
export const MCP_START_MS = 120_000;
export const MCP_CALL_MS = 120_000;
const STDERR_KEEP = 2000;

/** An MCP tool with the hints the server gave (MCP tool annotations). */
export interface PluginTool extends McpTool {
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpClient {
  tools(): Promise<PluginTool[]>;
  call(name: string, args: unknown): Promise<unknown>;
  close(): void;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const CLIENT_INFO = { name: "AgentHerd", version: "1" };

/** A local MCP server: one process, JSON-RPC lines on stdin and stdout. */
export function stdioClient(opts: {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  spawnFn?: typeof spawn;
  direct?: {
    timeout: number;
    maxLine: number;
    server: { name: string; version: string };
    onFailure?: () => void;
  };
}): McpClient & { closeAndWait(): Promise<void> } {
  let child: ChildProcess | undefined;
  let ready: Promise<void> | undefined;
  let closed = Promise.resolve();
  let started = false;
  let stopped = false;
  let next = 1;
  let stderr = "";
  let ended: Error | undefined;
  const pending = new Map<number, Pending>();

  const fail = (error: Error) => {
    ended = error;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };

  const failDirect = (proc: ChildProcess, error: Error) => {
    if (child !== proc || stopped) return;
    stopped = true;
    fail(error);
    proc.kill("SIGKILL");
    opts.direct?.onFailure?.();
  };

  const start = () => {
    const run = opts.spawnFn ?? spawn;
    const proc = run(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // npx, uvx and friends are .cmd files on Windows.
      shell: opts.direct === undefined && process.platform === "win32",
    });
    started = true;
    closed = new Promise((resolve) => proc.once("close", () => resolve()));
    proc.stdin?.on("error", () => {
      const error = new Error("the server input closed");
      if (opts.direct !== undefined) failDirect(proc, error);
      else fail(error);
    });
    child = proc;
    ended = undefined;
    let buffer = "";
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      if (child !== proc || ended !== undefined) return;
      buffer += chunk;
      if (opts.direct !== undefined && buffer.length > opts.direct.maxLine) {
        buffer = "";
        failDirect(proc, new Error("the server reply was too large"));
        return;
      }
      let at = buffer.indexOf("\n");
      while (at >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf("\n");
        if (line === "") continue;
        let msg: { id?: unknown; result?: unknown; error?: { message?: unknown } | null } | null;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof msg?.id !== "number") continue;
        const p = pending.get(msg.id);
        if (p === undefined) continue;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error !== undefined) {
          const message = msg.error?.message;
          p.reject(new Error(typeof message === "string" ? message : "the server refused"));
        } else p.resolve(msg.result);
      }
    });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      if (opts.direct === undefined) stderr = (stderr + chunk).slice(-STDERR_KEEP);
    });
    proc.on("error", (error) => {
      if (opts.direct !== undefined) failDirect(proc, new Error("the server process failed"));
      else fail(new Error(`没能启动 ${opts.command}：${error.message}`));
    });
    proc.on("exit", (code) => {
      if (opts.direct !== undefined) {
        failDirect(proc, new Error("the server exited"));
        return;
      }
      const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
      fail(
        new Error(`${opts.command} 退出了（${code ?? "被结束"}）${tail === "" ? "" : `：${tail}`}`),
      );
      if (child === proc) {
        child = undefined;
        ready = undefined;
      }
    });
  };

  const send = (method: string, params: unknown, ms: number): Promise<unknown> => {
    if (child === undefined || ended !== undefined) {
      return Promise.reject(ended ?? new Error("the server is not running"));
    }
    const id = next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`${method} 没有在 ${Math.round(ms / 1000)} 秒内回答`);
        if (opts.direct !== undefined && child !== undefined) {
          failDirect(child, error);
          return;
        }
        pending.delete(id);
        reject(error);
      }, ms);
      pending.set(id, { resolve, reject, timer });
      child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };

  const timeout = opts.direct?.timeout ?? MCP_CALL_MS;
  const ensure = (): Promise<void> => {
    if (stopped || (opts.direct !== undefined && started && ended !== undefined)) {
      return Promise.reject(new Error("the server was stopped"));
    }
    if (ready === undefined || ended !== undefined) {
      start();
      ready = send(
        "initialize",
        { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO },
        opts.direct?.timeout ?? MCP_START_MS,
      ).then((result) => {
        if (opts.direct !== undefined) {
          const info = (result as { serverInfo?: { name?: string; version?: string } } | null)
            ?.serverInfo;
          if (
            info?.name !== opts.direct.server.name ||
            info?.version !== opts.direct.server.version
          ) {
            throw new Error("unexpected server version");
          }
        }
        child?.stdin?.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
        );
      });
      ready.catch(() => {
        if (opts.direct === undefined) ready = undefined;
      });
    }
    return ready;
  };

  const close = () => {
    const c = child;
    child = undefined;
    ready = undefined;
    stopped = opts.direct !== undefined;
    fail(new Error("the server was stopped"));
    if (c !== undefined) {
      if (opts.direct === undefined) killTree(c, "SIGTERM");
      else c.kill("SIGKILL");
    }
  };
  return {
    async tools() {
      await ensure();
      const r = (await send("tools/list", {}, timeout)) as { tools?: PluginTool[] };
      return r.tools ?? [];
    },
    async call(name, args) {
      await ensure();
      return send("tools/call", { name, arguments: args ?? {} }, timeout);
    },
    close,
    async closeAndWait() {
      close();
      await closed;
    },
  };
}

/** The reply with `id` from a JSON body or an event-stream body. */
export function replyFrom(
  contentType: string,
  text: string,
  id: number,
):
  | {
      result?: unknown;
      error?: { message?: string };
    }
  | undefined {
  const bodies = contentType.includes("text/event-stream")
    ? text
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
    : [text];
  for (const body of bodies) {
    let v: unknown;
    try {
      v = JSON.parse(body);
    } catch {
      continue;
    }
    for (const msg of Array.isArray(v) ? v : [v]) {
      if (msg !== null && typeof msg === "object" && (msg as { id?: unknown }).id === id) {
        return msg as { result?: unknown; error?: { message?: string } };
      }
    }
  }
  return undefined;
}

/** A remote MCP server over Streamable HTTP. */
export function httpClient(opts: {
  url: string;
  headers: Record<string, string>;
  fetchFn?: typeof fetch;
}): McpClient {
  const fetchFn = opts.fetchFn ?? fetch;
  let session: string | undefined;
  let ready: Promise<void> | undefined;
  let next = 1;

  const post = async (body: unknown, ms: number): Promise<Response> => {
    let res: Response;
    try {
      res = await fetchFn(opts.url, {
        method: "POST",
        headers: {
          ...opts.headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MCP_PROTOCOL,
          ...(session === undefined ? {} : { "mcp-session-id": session }),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ms),
      });
    } catch (error) {
      throw new Error(`连不上 ${new URL(opts.url).host}：${(error as Error).message}`);
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid !== null && sid !== "") session = sid;
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `${new URL(opts.url).host} 要先登录（${res.status}）：检查 Key；要在网页里授权（OAuth）的服务，AgentHerd 现在还不支持`,
      );
    }
    if (!res.ok) throw new Error(`${new URL(opts.url).host} 回答 HTTP ${res.status}`);
    return res;
  };

  const rpc = async (method: string, params: unknown, ms: number): Promise<unknown> => {
    const id = next++;
    const res = await post({ jsonrpc: "2.0", id, method, params }, ms);
    const reply = replyFrom(res.headers.get("content-type") ?? "", await res.text(), id);
    if (reply === undefined) throw new Error(`${new URL(opts.url).host} 没有回答 ${method}`);
    if (reply.error !== undefined) throw new Error(reply.error.message ?? "the server refused");
    return reply.result;
  };

  const ensure = (): Promise<void> => {
    if (ready === undefined) {
      ready = rpc(
        "initialize",
        { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO },
        MCP_START_MS,
      ).then(async () => {
        await post({ jsonrpc: "2.0", method: "notifications/initialized" }, MCP_CALL_MS).catch(
          () => undefined,
        );
      });
      ready.catch(() => {
        ready = undefined;
      });
    }
    return ready;
  };

  return {
    async tools() {
      await ensure();
      const r = (await rpc("tools/list", {}, MCP_CALL_MS)) as { tools?: PluginTool[] };
      return r.tools ?? [];
    },
    async call(name, args) {
      await ensure();
      return rpc("tools/call", { name, arguments: args ?? {} }, MCP_CALL_MS);
    },
    close() {
      ready = undefined;
      session = undefined;
    },
  };
}
