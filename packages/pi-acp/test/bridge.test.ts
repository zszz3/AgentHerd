// The bridge end to end: AgentHerd's ACP client → bin/pi-acp.ts → a fake Pi that runs the
// real gate and mcp extensions.

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type PermissionRequest,
  type SessionUpdateEvent,
  type StdioMcpServer,
  startAgent,
} from "@agentherd/acp-client";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_DIR_ENV } from "../src/index.ts";

const BIN = fileURLToPath(new URL("../bin/pi-acp.ts", import.meta.url));
const FAKE = fileURLToPath(new URL("./fake-pi.ts", import.meta.url));

interface Call {
  toolName: string;
  input: Record<string, unknown>;
}

interface Plan {
  calls?: Call[];
  turns?: { calls?: Call[]; reply?: string; error?: string }[];
  reply?: string;
  error?: string;
  startFail?: boolean;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function start(plan: Plan, extraEnv: Record<string, string> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-acp-"));
  const conn = await startAgent(
    {
      id: "pi",
      name: "Pi",
      command: [process.execPath, BIN, "--pi", FAKE],
      env: { FAKE_PI: JSON.stringify({ calls: [], reply: "done", ...plan }), ...extraEnv },
      exporter: null,
    },
    { cwd },
  );
  cleanups.push(() => conn.close());
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  const updates: SessionUpdateEvent[] = [];
  const asked: PermissionRequest[] = [];
  conn.on("update", (u) => updates.push(u));
  conn.on("permission", (p) => asked.push(p));
  return { conn, cwd, updates, asked };
}

/** A fake gateway socket speaking AgentHerd's token + JSON-RPC line framing. */
async function startFakeSocket(
  activeTokens: Set<string>,
  onCall: (token: string, name: string, args: unknown) => { text: string; isError?: boolean },
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-acp-sock-"));
  const socketPath = join(dir, "mcp.sock");
  const server = createServer((socket) => {
    let token: string | undefined;
    let rest = "";
    socket.on("data", (chunk: Buffer) => {
      rest += chunk.toString("utf8");
      let nl = rest.indexOf("\n");
      while (nl >= 0) {
        const line = rest.slice(0, nl).trim();
        rest = rest.slice(nl + 1);
        nl = rest.indexOf("\n");
        if (line === "") continue;
        const msg = JSON.parse(line) as {
          token?: string;
          id?: string | number | null;
          method?: string;
          params?: { name?: string; arguments?: unknown };
        };
        if (token === undefined) {
          token = msg.token ?? "";
          if (!activeTokens.has(token)) {
            socket.end(
              `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "unknown task token" } })}\n`,
            );
            return;
          }
          continue;
        }
        if (msg.method === "tools/list") {
          socket.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                tools: [
                  {
                    name: "herd_report",
                    description: "Report task progress. Keep summary short.",
                    inputSchema: {
                      type: "object",
                      properties: { state: { type: "string" }, summary: { type: "string" } },
                      required: ["state", "summary"],
                    },
                  },
                  {
                    name: "echo_tool",
                    description: "Echo input",
                    inputSchema: { type: "object", properties: { msg: { type: "string" } } },
                  },
                ],
              },
            })}\n`,
          );
        } else if (msg.method === "tools/call") {
          const out = onCall(token, msg.params?.name ?? "", msg.params?.arguments);
          socket.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                content: [{ type: "text", text: out.text }],
                ...(out.isError === true ? { isError: true } : {}),
              },
            })}\n`,
          );
        }
      }
    });
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(socketPath, done);
  });
  cleanups.push(
    () =>
      new Promise<void>((done) => {
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          done();
        });
      }),
  );
  return socketPath;
}

function gatewayServer(socketPath: string, token: string): StdioMcpServer {
  return {
    name: "agentherd",
    command: process.execPath,
    args: ["-e", "process.exit(1)"],
    env: [
      { name: "AGENTHERD_MCP_SOCKET", value: socketPath },
      { name: "AGENTHERD_MCP_TOKEN", value: token },
    ],
  };
}

function customStdioServer(): StdioMcpServer {
  const dir = mkdtempSync(join(tmpdir(), "pi-acp-stdiomcp-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "mcp.mjs");
  writeFileSync(
    script,
    [
      'let rest = "";',
      'process.stdin.on("data", (c) => {',
      '  rest += c.toString("utf8");',
      '  let nl = rest.indexOf("\\n");',
      "  while (nl >= 0) {",
      "    const line = rest.slice(0, nl).trim();",
      "    rest = rest.slice(nl + 1);",
      '    nl = rest.indexOf("\\n");',
      "    if (!line) continue;",
      "    const m = JSON.parse(line);",
      '    if (m.method === "initialize") {',
      '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } }) + "\\n");',
      '    } else if (m.method === "tools/list") {',
      '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "custom_ping", description: "Custom ping", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] } }) + "\\n");',
      '    } else if (m.method === "tools/call") {',
      '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "pong:" + (m.params?.arguments?.q ?? "") }] } }) + "\\n");',
      "    }",
      "  }",
      "});",
    ].join("\n"),
  );
  return { name: "custom", command: process.execPath, args: [script], env: [] };
}

const text = (updates: SessionUpdateEvent[]) =>
  updates
    .filter((u) => u.type === "message")
    .map((u) => u.text)
    .join("");
const statuses = (updates: SessionUpdateEvent[]) =>
  updates.filter((u) => u.type === "tool_call_update").map((u) => u.status);

describe("pi-acp bridge", () => {
  it("asks before a write and runs it when allowed", async () => {
    const { conn, cwd, updates, asked } = await start({
      calls: [{ toolName: "write", input: { path: "a.txt", content: "goats" } }],
    });
    conn.on("permission", (p) => p.respond({ kind: "allow" }));
    expect(conn.agentName).toBe("pi-acp (AgentHerd)");
    const sid = await conn.newSession(cwd);
    expect(await conn.prompt(sid, "go")).toEqual({ stopReason: "end_turn" });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.toolCall).toMatchObject({
      kind: "edit",
      title: `Write ${join(cwd, "a.txt")}`,
      paths: [join(cwd, "a.txt")],
    });
    expect(statuses(updates)).toEqual(["completed"]);
    expect(text(updates)).toBe("done");
  });

  it("passes the owner's images on to Pi", async () => {
    const { conn, cwd, updates } = await start({ reply: "saw {images}" });
    expect(conn.acceptsImages).toBe(true);
    const sid = await conn.newSession(cwd);
    await conn.prompt(sid, "look", [{ data: "iVBORw0K", mimeType: "image/png" }]);
    expect(text(updates)).toBe("saw image/png");
  });

  it("blocks the call when denied", async () => {
    const { conn, cwd, updates, asked } = await start({
      calls: [{ toolName: "bash", input: { command: "rm -rf build" } }],
    });
    conn.on("permission", (p) => p.respond({ kind: "deny" }));
    const sid = await conn.newSession(cwd);
    expect(await conn.prompt(sid, "go")).toEqual({ stopReason: "end_turn" });
    expect(asked[0]?.toolCall).toMatchObject({ kind: "execute", command: "rm -rf build" });
    expect(statuses(updates)).toEqual(["failed"]);
  });

  it("lets reads inside the folder run without asking, but asks for reads outside", async () => {
    const { conn, cwd, updates, asked } = await start({
      calls: [
        { toolName: "read", input: { path: "src/a.ts" } },
        { toolName: "grep", input: { pattern: "x" } },
        { toolName: "read", input: { path: "/etc/hosts" } },
      ],
    });
    conn.on("permission", (p) => p.respond({ kind: "allow" }));
    const sid = await conn.newSession(cwd);
    await conn.prompt(sid, "go");
    expect(asked.map((p) => p.toolCall.paths)).toEqual([["/etc/hosts"]]);
    expect(statuses(updates)).toEqual(["completed", "completed", "completed"]);
  });

  it("cancels a turn that waits for an answer", async () => {
    const { conn, cwd, asked } = await start({
      calls: [{ toolName: "bash", input: { command: "make" } }],
    });
    const sid = await conn.newSession(cwd);
    const turn = conn.prompt(sid, "go");
    await expect.poll(() => asked.length).toBe(1);
    await conn.cancel(sid);
    expect(await turn).toEqual({ stopReason: "cancelled" });
    expect(asked[0]?.answered).toBe(true);
  });

  it("fails the turn with Pi's model error", async () => {
    const { conn, cwd } = await start({ error: "401 invalid api key" });
    const sid = await conn.newSession(cwd);
    await expect(conn.prompt(sid, "go")).rejects.toThrow(/401 invalid api key/);
  });

  it("fails the session when Pi cannot start", async () => {
    const { conn, cwd } = await start({ startFail: true });
    await expect(conn.newSession(cwd)).rejects.toThrow(/no model configured/);
  });

  it("bridges agentherd socket MCP tools without gate prompts and propagates tool errors", async () => {
    const seen: { token: string; name: string; args: unknown }[] = [];
    const socketPath = await startFakeSocket(new Set(["tok-1"]), (token, name, args) => {
      seen.push({ token, name, args });
      if (name === "echo_tool" && (args as { msg?: string }).msg === "fail") {
        return { text: "denied by gateway", isError: true };
      }
      return { text: name === "herd_report" ? "reported" : "ok" };
    });
    const before = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith("pi-acp-mcp-")));
    const { conn, cwd, updates, asked } = await start({
      calls: [
        { toolName: "herd_report", input: { state: "ready", summary: "all set" } },
        { toolName: "echo_tool", input: { msg: "fail" } },
      ],
      reply: "{results}",
    });
    const sid = await conn.newSession(cwd, [gatewayServer(socketPath, "tok-1")]);
    expect(await conn.prompt(sid, "go")).toEqual({ stopReason: "end_turn" });
    expect(asked).toHaveLength(0);
    expect(seen).toEqual([
      { token: "tok-1", name: "herd_report", args: { state: "ready", summary: "all set" } },
      { token: "tok-1", name: "echo_tool", args: { msg: "fail" } },
    ]);
    expect(statuses(updates)).toEqual(["completed", "failed"]);
    expect(text(updates)).toBe("reported|error: denied by gateway");
    await conn.close();
    const after = readdirSync(tmpdir()).filter((f) => f.startsWith("pi-acp-mcp-"));
    expect(after.filter((f) => !before.has(f))).toEqual([]);
  });

  it("still gates non-agentherd stdio MCP tools through session/request_permission", async () => {
    const server = customStdioServer();
    const { conn, cwd, updates, asked } = await start({
      calls: [{ toolName: "custom_ping", input: { q: "hi" } }],
      reply: "{results}",
    });
    let allow = true;
    conn.on("permission", (p) => p.respond({ kind: allow ? "allow" : "deny" }));
    const sid = await conn.newSession(cwd, [server]);
    await conn.prompt(sid, "go");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.toolCall.kind).toBe("other");
    expect(text(updates)).toBe("pong:hi");
    expect(statuses(updates)).toEqual(["completed"]);

    allow = false;
    updates.length = 0;
    await conn.prompt(sid, "go again");
    expect(asked).toHaveLength(2);
    expect(statuses(updates)).toEqual(["failed"]);
  });

  it("runs without MCP tools and never logs the token when an MCP server fails at start", async () => {
    const secret = "secret-mcp-token-value";
    const { conn, cwd, updates } = await start({ reply: "still ran" });
    const sid = await conn.newSession(cwd, [
      gatewayServer("/does/not/exist/mcp.sock", secret),
      {
        name: "dead-stdio",
        command: process.execPath,
        args: ["-e", `process.stderr.write("failed ${secret}\\n"); process.exit(1)`],
        env: [
          { name: "TOKEN", value: secret },
          { name: "AGENTHERD_MCP_SECRET_SKIP", value: "1" },
        ],
      },
    ]);
    await conn.prompt(sid, "go");
    expect(text(updates)).toBe("still ran");
    expect(conn.stderr().join("\n")).not.toContain(secret);
    expect(conn.stderr().join("\n")).toContain("MCP server agentherd failed");
  });

  it("reopens a saved Pi session with session/load and uses the refreshed MCP token", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-acp-sess-"));
    cleanups.push(() => rmSync(sessionDir, { recursive: true, force: true }));
    const activeTokens = new Set(["tok-1"]);
    const called: string[] = [];
    const socketPath = await startFakeSocket(activeTokens, (token, name) => {
      called.push(`${token}:${name}`);
      return { text: "reported" };
    });

    const first = await start(
      { calls: [{ toolName: "herd_report", input: { state: "progress", summary: "halfway" } }] },
      { [SESSION_DIR_ENV]: sessionDir },
    );
    expect(first.conn.loadsSessions).toBe(true);
    const sid = await first.conn.newSession(first.cwd, [gatewayServer(socketPath, "tok-1")]);
    await first.conn.prompt(sid, "turn 1");
    await first.conn.close();

    expect(existsSync(join(sessionDir, `${sid}.json`))).toBe(true);
    activeTokens.delete("tok-1");
    activeTokens.add("tok-2");

    const second = await start(
      {
        calls: [{ toolName: "herd_report", input: { state: "ready", summary: "done now" } }],
        reply: "{results}",
      },
      { [SESSION_DIR_ENV]: sessionDir },
    );
    await second.conn.loadSession(sid, second.cwd, [gatewayServer(socketPath, "tok-2")]);
    await second.conn.prompt(sid, "turn 2");
    expect(called).toEqual(["tok-1:herd_report", "tok-2:herd_report"]);
    expect(text(second.updates)).toBe("reported");
  });
});
