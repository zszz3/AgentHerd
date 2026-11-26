// The local API over a Unix domain socket: `<home>/run/herd.sock`, mode 600 in a 700 directory,
// newline-delimited JSON (./api.ts). No TCP port. On Windows: a named pipe named after the home.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  API_VERSION,
  type CallMessage,
  type EventMessage,
  HOST_METHODS,
  type HostApi,
  type HostEvent,
  type HostMethod,
  type RemoteHost,
  type ResultMessage,
} from "./api.ts";
import { hostDataPaths } from "./data-home-paths.ts";

const isWindows = process.platform === "win32";

export function socketPath(home: string, platform: NodeJS.Platform = process.platform): string {
  // Windows has no Unix socket files here; use a named pipe derived from the home path.
  if (platform === "win32") {
    const id = createHash("sha256")
      .update(win32.resolve(home).toLowerCase())
      .digest("hex")
      .slice(0, 16);
    return `\\\\.\\pipe\\agentherd-${id}`;
  }
  return join(home, hostDataPaths.hostSocket.relative);
}

/**
 * Lines from a stream of chunks. A chunk can end in the middle of a character (Chinese takes three
 * bytes), so the bytes go through one decoder that keeps the unfinished end for the next chunk;
 * decoding each chunk alone turned such a character into 「��」 in long answers.
 */
export function lineReader(onLine: (line: string) => void): (chunk: Buffer) => void {
  const decoder = new StringDecoder("utf8");
  let rest = "";
  return (chunk) => {
    rest += decoder.write(chunk);
    let nl = rest.indexOf("\n");
    while (nl >= 0) {
      const line = rest.slice(0, nl).trim();
      rest = rest.slice(nl + 1);
      if (line !== "") onLine(line);
      nl = rest.indexOf("\n");
    }
  };
}

/** True when a host answers on this socket. */
export function isHostRunning(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((done) => {
    // A named pipe cannot be checked with existsSync; connecting tells.
    if (!isWindows && !existsSync(path)) {
      done(false);
      return;
    }
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      done(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      done(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

export interface ApiServer {
  path: string;
  close(): Promise<void>;
}

export interface EventSource {
  onEvent(listener: (event: HostEvent) => void): () => void;
}

/** Serves `api` on the socket. Refuses to start if another host answers there. */
export async function serveApi(api: HostApi & EventSource, path: string): Promise<ApiServer> {
  if (!isWindows) {
    const dir = join(path, "..");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  if (await isHostRunning(path)) throw new Error(`another AgentHerd host is running (${path})`);
  if (!isWindows && existsSync(path)) unlinkSync(path);

  const sockets = new Set<Socket>();
  const off = api.onEvent((event) => {
    const line = `${JSON.stringify({ v: API_VERSION, type: "event", event } satisfies EventMessage)}\n`;
    for (const s of sockets) s.write(line);
  });

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
    socket.on(
      "data",
      lineReader((line) => {
        void answer(api, line).then((reply) => {
          if (reply !== undefined && !socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
        });
      }),
    );
  });
  await new Promise<void>((done, fail) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      // A pipe name in use means another host holds it (Unix sockets were checked above).
      if (isWindows && error.code === "EADDRINUSE") {
        fail(new Error(`another AgentHerd host is running (${path})`));
      } else fail(error);
    });
    server.listen(path, () => done());
  });
  if (!isWindows) chmodSync(path, 0o600);
  return {
    path,
    close: () =>
      new Promise<void>((done) => {
        off();
        for (const s of sockets) s.destroy();
        server.close(() => done());
      }),
  };
}

async function answer(api: HostApi, line: string): Promise<ResultMessage | undefined> {
  let call: CallMessage;
  try {
    call = JSON.parse(line) as CallMessage;
  } catch {
    return undefined;
  }
  const reply = (ok: boolean, body: { result?: unknown; error?: string }): ResultMessage => ({
    v: API_VERSION,
    id: call.id,
    type: "result",
    ok,
    ...body,
  });
  if (call.type !== "call" || typeof call.id !== "number") return undefined;
  if (call.v !== API_VERSION) return reply(false, { error: `unsupported API version ${call.v}` });
  if (!HOST_METHODS.includes(call.method)) {
    return reply(false, { error: `unknown method "${String(call.method)}"` });
  }
  try {
    const fn = api[call.method] as (...args: unknown[]) => unknown;
    // JSON turns an omitted (undefined) argument into null; give the method undefined back.
    const params = Array.isArray(call.params)
      ? call.params.map((p) => (p === null ? undefined : p))
      : [];
    const result = await fn.apply(api, params);
    return reply(true, { result });
  } catch (error) {
    return reply(false, { error: (error as Error).message });
  }
}

export interface HostClient {
  host: RemoteHost;
  onEvent(listener: (event: HostEvent) => void): () => void;
  onClose(listener: () => void): void;
  close(): void;
}

/** Connects to a running host. */
export function connectHost(path: string): Promise<HostClient> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
    const listeners = new Set<(event: HostEvent) => void>();
    const closers: (() => void)[] = [];
    let next = 1;
    socket.on(
      "data",
      lineReader((line) => {
        let msg: ResultMessage | EventMessage;
        try {
          msg = JSON.parse(line) as ResultMessage | EventMessage;
        } catch {
          return;
        }
        if (msg.type === "event") {
          for (const l of listeners) l(msg.event);
          return;
        }
        const p = pending.get(msg.id);
        if (p === undefined) return;
        pending.delete(msg.id);
        if (msg.ok) p.ok(msg.result);
        else p.fail(new Error(msg.error ?? "host error"));
      }),
    );
    socket.once("error", (error) => reject(error));
    socket.on("close", () => {
      for (const p of pending.values()) p.fail(new Error("AgentHerd host disconnected"));
      pending.clear();
      for (const c of closers) c();
    });
    const call = (method: HostMethod, params: unknown[]): Promise<unknown> =>
      new Promise((ok, fail) => {
        if (socket.destroyed) {
          fail(new Error("AgentHerd host disconnected"));
          return;
        }
        const id = next++;
        pending.set(id, { ok, fail });
        const msg: CallMessage = { v: API_VERSION, id, type: "call", method, params };
        socket.write(`${JSON.stringify(msg)}\n`);
      });
    const host = Object.fromEntries(
      HOST_METHODS.map((m) => [m, (...params: unknown[]) => call(m, params)]),
    ) as unknown as RemoteHost;
    socket.once("connect", () =>
      resolve({
        host,
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        onClose(listener) {
          closers.push(listener);
        },
        close() {
          socket.end();
        },
      }),
    );
  });
}
