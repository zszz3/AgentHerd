// A Pi extension that bridges ACP stdio MCP servers (especially AgentHerd's gateway) into Pi
// tools (docs/adr/0060). Self-contained (Node built-ins only) like gate.ts and model.ts.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";

export const MCP_ENV = "AGENTHERD_PI_MCP";
export const AGENTHERD_MCP_SERVER = "agentherd";
export const BUILTIN_PI_TOOLS: readonly string[] = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
];
const LIST_TIMEOUT_MS = 15_000;
const MAX_SNIPPET_CHARS = 140;
const MAX_STDERR_CHARS = 2000;
const SECRET_ENV_NAME = /TOKEN|KEY|SECRET|PASSWORD/i;

export interface PiMcpServer {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

export interface PiMcpTool {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  trusted: boolean;
}

export interface PiMcpConfig {
  servers: PiMcpServer[];
  tools: PiMcpTool[];
}

export type McpToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpExtensionApi {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    promptSnippet: string;
    parameters: Record<string, unknown>;
    execute(
      toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<{ content: McpToolContent[]; details: Record<string, never> }>;
  }): void;
}

/** One-line summary for Pi's tool prompt section. */
export function snippetOf(name: string, description: string): string {
  const firstLine = (description.split(/\r?\n/)[0] ?? "").trim();
  if (firstLine === "") return name;
  const dot = firstLine.indexOf(". ");
  const sentence = dot > 0 ? firstLine.slice(0, dot + 1) : firstLine;
  return sentence.length > MAX_SNIPPET_CHARS
    ? `${sentence.slice(0, MAX_SNIPPET_CHARS - 1)}…`
    : sentence;
}

/** Normalizes an MCP tool `inputSchema` into a valid JSON Schema object for Pi. */
export function normalizeInputSchema(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { type: "object", properties: {} };
  }
  const obj = raw as Record<string, unknown>;
  const type = obj.type ?? "object";
  if (type === "object" && (typeof obj.properties !== "object" || obj.properties === null)) {
    return { ...obj, type: "object", properties: {} };
  }
  return obj.type === undefined ? { ...obj, type } : { ...obj };
}

function redactServerSecrets(text: string, server: PiMcpServer): string {
  let out = text;
  for (const entry of server.env) {
    if (entry.value !== "" && SECRET_ENV_NAME.test(entry.name)) {
      out = out.replaceAll(entry.value, "[REDACTED]");
    }
  }
  return out;
}

function envValue(server: PiMcpServer, key: string): string | undefined {
  return server.env.find((e) => e.name === key)?.value;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStdioServer(raw: unknown): raw is PiMcpServer {
  if (!isPlainObject(raw) || "type" in raw) return false;
  if (typeof raw.name !== "string" || raw.name === "" || typeof raw.command !== "string") {
    return false;
  }
  return Array.isArray(raw.args) && Array.isArray(raw.env);
}

interface RpcResponse {
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

function requestSocket(
  socketPath: string,
  token: string,
  method: string,
  params: unknown,
  timeoutMs?: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    let rest = "";
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => finish(new Error(`MCP ${method} timed out`)), timeoutMs);
    const finish = (err?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err !== undefined) reject(err);
      else resolve(value);
    };
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({ token })}\n${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      rest += chunk.toString("utf8");
      let nl = rest.indexOf("\n");
      while (nl >= 0) {
        const line = rest.slice(0, nl).trim();
        rest = rest.slice(nl + 1);
        nl = rest.indexOf("\n");
        if (line === "") continue;
        let msg: RpcResponse;
        try {
          msg = JSON.parse(line) as RpcResponse;
        } catch {
          finish(new Error("MCP server sent invalid JSON"));
          return;
        }
        if (msg.error !== undefined) {
          finish(new Error(msg.error.message || "MCP error"));
          return;
        }
        if (msg.id === 1) {
          finish(undefined, msg.result);
          return;
        }
      }
    });
    socket.on("error", (err) => finish(err));
    socket.on("close", () => finish(new Error("MCP socket closed before answering")));
  });
}

function requestStdio(
  server: PiMcpServer,
  method: string,
  params: unknown,
  timeoutMs?: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...Object.fromEntries(server.env.map((e) => [e.name, e.value])),
    };
    const child = spawn(server.command, server.args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    let rest = "";
    let stderr = "";
    const send = (msg: object) => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(msg)}\n`);
    };
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => finish(new Error(`MCP ${method} timed out`)), timeoutMs);
    const finish = (err?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.stdin.destroyed) child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (err !== undefined) reject(err);
      else resolve(value);
    };
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-MAX_STDERR_CHARS);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      rest += chunk.toString("utf8");
      let nl = rest.indexOf("\n");
      while (nl >= 0) {
        const line = rest.slice(0, nl).trim();
        rest = rest.slice(nl + 1);
        nl = rest.indexOf("\n");
        if (line === "") continue;
        let msg: RpcResponse;
        try {
          msg = JSON.parse(line) as RpcResponse;
        } catch {
          continue;
        }
        if (msg.error !== undefined && (msg.id === 1 || msg.id === 2 || msg.id === null)) {
          finish(new Error(msg.error.message || "MCP error"));
          return;
        }
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method, params });
        } else if (msg.id === 2) {
          finish(undefined, msg.result);
          return;
        }
      }
    });
    child.on("error", (err) => finish(err));
    child.on("exit", (code, signal) => {
      const detail = redactServerSecrets(stderr.trim(), server);
      const suffix = detail === "" ? "" : `: ${detail}`;
      finish(new Error(`MCP server exited (code ${code}, signal ${signal})${suffix}`));
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "pi-acp", version: "0.0.0" },
      },
    });
  });
}

function requestMcp(
  server: PiMcpServer,
  method: string,
  params: unknown,
  timeoutMs?: number,
): Promise<unknown> {
  const socketPath = envValue(server, "AGENTHERD_MCP_SOCKET");
  const token = envValue(server, "AGENTHERD_MCP_TOKEN");
  if (socketPath !== undefined && socketPath !== "" && token !== undefined && token !== "") {
    return requestSocket(socketPath, token, method, params, timeoutMs);
  }
  return requestStdio(server, method, params, timeoutMs);
}

/** Queries every stdio ACP MCP server for its tools; dead servers are logged and skipped. */
export async function discoverMcpTools(
  acpServers: readonly unknown[],
  log?: (line: string) => void,
): Promise<PiMcpConfig> {
  const servers: PiMcpServer[] = [];
  const tools: PiMcpTool[] = [];
  const seen = new Set<string>(BUILTIN_PI_TOOLS);
  for (const raw of acpServers) {
    if (!isStdioServer(raw)) continue;
    const server: PiMcpServer = {
      name: raw.name,
      command: raw.command,
      args: raw.args.filter((a): a is string => typeof a === "string"),
      env: raw.env.filter(
        (e): e is { name: string; value: string } =>
          isPlainObject(e) && typeof e.name === "string" && typeof e.value === "string",
      ),
    };
    let listed: unknown;
    try {
      listed = await requestMcp(server, "tools/list", {}, LIST_TIMEOUT_MS);
    } catch (error) {
      log?.(
        `MCP server ${server.name} failed: ${redactServerSecrets((error as Error).message, server)}`,
      );
      continue;
    }
    const rawTools = isPlainObject(listed) && Array.isArray(listed.tools) ? listed.tools : [];
    let added = 0;
    for (const entry of rawTools) {
      if (!isPlainObject(entry) || typeof entry.name !== "string" || entry.name === "") continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      tools.push({
        server: server.name,
        name: entry.name,
        description: typeof entry.description === "string" ? entry.description : "",
        inputSchema: normalizeInputSchema(entry.inputSchema),
        trusted: server.name === AGENTHERD_MCP_SERVER,
      });
      added++;
    }
    if (added > 0 && !servers.some((s) => s.name === server.name)) servers.push(server);
  }
  return { servers, tools };
}

function toMcpContent(raw: unknown): McpToolContent[] {
  if (!Array.isArray(raw)) return [];
  const out: McpToolContent[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) {
      out.push({ type: "text", text: JSON.stringify(item) });
      continue;
    }
    if (item.type === "text" && typeof item.text === "string") {
      out.push({ type: "text", text: item.text });
    } else if (
      item.type === "image" &&
      typeof item.data === "string" &&
      typeof item.mimeType === "string"
    ) {
      out.push({ type: "image", data: item.data, mimeType: item.mimeType });
    } else {
      out.push({ type: "text", text: JSON.stringify(item) });
    }
  }
  return out;
}

/** Calls one MCP tool; converts `isError: true` into a thrown Error so Pi marks the call failed. */
export async function callMcpTool(
  server: PiMcpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: McpToolContent[]; details: Record<string, never> }> {
  const result = await requestMcp(server, "tools/call", { name, arguments: args });
  const body = isPlainObject(result) ? result : {};
  const content = toMcpContent(body.content);
  if (body.isError === true) {
    const text = content
      .map((c) => (c.type === "text" ? c.text : `[${c.mimeType} image]`))
      .join("\n")
      .trim();
    throw new Error(text === "" ? "MCP tool failed" : text);
  }
  return {
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    details: {},
  };
}

/** Reads the pre-discovered MCP config file named in `AGENTHERD_PI_MCP`, or `undefined`. */
export function mcpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PiMcpConfig | undefined {
  const path = env[MCP_ENV];
  if (path === undefined || path === "") return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PiMcpConfig>;
    if (!Array.isArray(parsed.servers) || !Array.isArray(parsed.tools)) return undefined;
    return { servers: parsed.servers, tools: parsed.tools };
  } catch {
    return undefined;
  }
}

export default function mcp(pi: McpExtensionApi): void {
  const config = mcpConfigFromEnv(process.env);
  if (config === undefined) return;
  const byName = new Map(config.servers.map((s) => [s.name, s]));
  for (const tool of config.tools) {
    if (BUILTIN_PI_TOOLS.includes(tool.name)) continue;
    const server = byName.get(tool.server);
    if (server === undefined) continue;
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      promptSnippet: snippetOf(tool.name, tool.description),
      parameters: tool.inputSchema,
      execute: (_toolCallId, params) => callMcpTool(server, tool.name, params ?? {}),
    });
  }
}
