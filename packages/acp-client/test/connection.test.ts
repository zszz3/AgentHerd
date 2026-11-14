import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentProfile } from "@agentherd/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AgentConnection,
  CLOSE_GRACE_MS,
  type ExitEvent,
  type PermissionRequest,
  type SessionUpdateEvent,
  startAgent,
} from "../src/index.ts";

const BIN = fileURLToPath(new URL("../../mock-agent/bin/mock-agent.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "agentherd-acp-"));
let open: AgentConnection[] = [];

afterEach(async () => {
  await Promise.all(open.map((c) => c.close()));
  open = [];
});

function profile(script: string, env: Record<string, string> = {}): AgentProfile {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(file, script);
  return {
    id: "mock",
    name: "Mock",
    command: [process.execPath, BIN, "--script", file],
    env,
    exporter: null,
  };
}

async function start(script: string, env?: Record<string, string>) {
  const conn = await startAgent(profile(script, env), { cwd: dir });
  open.push(conn);
  const updates: SessionUpdateEvent[] = [];
  const permissions: PermissionRequest[] = [];
  conn.on("update", (u) => updates.push(u));
  conn.on("permission", (p) => permissions.push(p));
  const exit = new Promise<ExitEvent>((resolve) => conn.on("exit", resolve));
  const sessionId = await conn.newSession(dir);
  return { conn, updates, permissions, exit, sessionId };
}

function nextPermission(conn: AgentConnection): Promise<PermissionRequest> {
  return new Promise((resolve) => {
    const off = conn.on("permission", (p) => {
      off();
      resolve(p);
    });
  });
}

const PERMISSION = `
turns:
  - - message: "starting"
    - request_permission:
        toolCall: { id: t1, title: "Run tests", kind: execute, command: "pnpm test", paths: ["src/a.ts"] }
        on_reject: end_turn
    - message: "ran"
`;

describe("startAgent with the mock agent", () => {
  it("initializes and reads the agent name", async () => {
    const { conn } = await start("name: scripted\nturns: []\n");
    expect(conn.agentName).toBe("scripted");
  });

  it("allow → allow_once, the turn continues", async () => {
    const { conn, updates, sessionId } = await start(PERMISSION);
    const asked = nextPermission(conn);
    const turn = conn.prompt(sessionId, "go");
    const p = await asked;
    expect(p.toolCall).toMatchObject({
      kind: "execute",
      title: "Run tests",
      command: "pnpm test",
      paths: ["src/a.ts"],
    });
    expect(p.options.map((o) => o.kind)).toContain("allow_always");
    expect(p.respond({ kind: "allow" })).toBe(true);
    expect(await turn).toEqual({ stopReason: "end_turn" });
    expect(updates.filter((u) => u.type === "message").map((u) => u.text)).toEqual([
      "starting",
      "ran",
    ]);
    expect(conn.stderr().join("\n")).toContain('"optionId":"allow"');
    expect(conn.stderr().join("\n")).not.toContain('"optionId":"always"');
  });

  it("deny → reject_once, the turn ends", async () => {
    const { conn, updates, sessionId } = await start(PERMISSION);
    const asked = nextPermission(conn);
    const turn = conn.prompt(sessionId, "go");
    (await asked).respond({ kind: "deny" });
    expect(await turn).toEqual({ stopReason: "end_turn" });
    expect(updates.filter((u) => u.type === "message").map((u) => u.text)).toEqual(["starting"]);
    expect(conn.stderr().join("\n")).toContain('"outcome":"deny"');
  });

  it("only the first respond counts", async () => {
    const { conn, sessionId } = await start(PERMISSION);
    const asked = nextPermission(conn);
    const turn = conn.prompt(sessionId, "go");
    const p = await asked;
    expect(p.respond({ kind: "deny" })).toBe(true);
    expect(p.respond({ kind: "allow" })).toBe(false);
    expect(p.answered).toBe(true);
    await turn;
    expect(conn.stderr().join("\n")).toContain('"outcome":"deny"');
  });

  it("cancel answers open requests cancelled and ends the turn cancelled", async () => {
    const { conn, sessionId } = await start(PERMISSION);
    const asked = nextPermission(conn);
    const turn = conn.prompt(sessionId, "go");
    const p = await asked;
    await conn.cancel(sessionId);
    expect(p.answered).toBe(true);
    expect(await turn).toEqual({ stopReason: "cancelled" });
  });

  it("cancel during a sleep ends the turn cancelled", async () => {
    const { conn, sessionId } = await start("turns:\n  - - sleep: 10000\n");
    const turn = conn.prompt(sessionId, "go");
    await new Promise((r) => setTimeout(r, 100));
    await conn.cancel(sessionId);
    expect(await turn).toEqual({ stopReason: "cancelled" });
  });

  it("a crash emits exit and rejects the prompt", async () => {
    const { conn, exit, sessionId } = await start("turns:\n  - - crash: 7\n");
    await expect(conn.prompt(sessionId, "go")).rejects.toThrow(/exited \(code 7/);
    const e = await exit;
    expect(e.code).toBe(7);
    expect(e.stderr.join("\n")).toContain("crash with code 7");
  });

  it("a crash with a request open answers it cancelled", async () => {
    const script = `
turns:
  - - request_permission:
        toolCall: { id: t1, title: "x", kind: execute, command: "ls" }
`;
    const { conn, exit, sessionId } = await start(script);
    const asked = nextPermission(conn);
    const turn = conn.prompt(sessionId, "go").catch((e: Error) => e);
    const p = await asked;
    // Kill the agent from outside while the request is open.
    process.kill(conn.pid ?? 0, "SIGKILL");
    const e = await exit;
    expect(e.signal).toBe("SIGKILL");
    expect(p.answered).toBe(true);
    expect(await turn).toBeInstanceOf(Error);
  });

  it("passes MCP servers to new and loaded sessions", async () => {
    const conn = await startAgent(profile("load_session: true\nturns: []\n"), { cwd: dir });
    open.push(conn);
    const server = {
      name: "agentherd",
      command: "relay",
      args: ["--x"],
      env: [{ name: "T", value: "1" }],
    };
    const id = await conn.newSession(dir, [server]);
    await conn.loadSession(id, dir, [server]);
    const lines = conn.stderr().join("\n");
    expect(lines.match(/mcp agentherd relay/g)).toHaveLength(2);
  });

  it("redacts env secrets in stderr", async () => {
    const script = 'turns:\n  - - stderr: "token is hunter2-very-secret"\n    - crash: 1\n';
    const { conn, exit, sessionId } = await start(script, { MOCK_SECRET: "hunter2-very-secret" });
    conn.prompt(sessionId, "go").catch(() => {});
    const e = await exit;
    expect(e.stderr.join("\n")).toContain("token is");
    expect(e.stderr.join("\n")).not.toContain("hunter2-very-secret");
  });

  it("an invalid script fails start with the reason", async () => {
    await expect(startAgent(profile("turns: 3\n"), { cwd: dir })).rejects.toThrow(
      /turns: expected a list/,
    );
  });
});

const said = (updates: SessionUpdateEvent[]) =>
  updates
    .filter((u) => u.type === "message")
    .map((u) => u.text)
    .join("");

describe("steering a running turn (ADR 0063)", () => {
  it("passes a message to the turn and answers once the agent read it", async () => {
    const script = 'steer: true\nturns:\n  - - message: "working. "\n    - read_steers: 5000\n';
    const { conn, updates, sessionId } = await start(script);
    expect(conn.steers).toBe(true);
    const turn = conn.prompt(sessionId, "go");
    await expect.poll(() => said(updates)).toContain("working");
    expect(await conn.steer(sessionId, "and the docs")).toBe(true);
    expect(await turn).toEqual({ stopReason: "end_turn" });
    expect(said(updates)).toBe("working. Read: and the docs");
  });

  it("answers false when the turn ends before reading it", async () => {
    const script = 'steer: true\nturns:\n  - - message: "working"\n    - sleep: 300\n';
    const { conn, updates, sessionId } = await start(script);
    const turn = conn.prompt(sessionId, "go");
    await expect.poll(() => said(updates)).toContain("working");
    expect(await conn.steer(sessionId, "too late")).toBe(false);
    expect(await turn).toEqual({ stopReason: "end_turn" });
    expect(await conn.steer(sessionId, "no turn now")).toBe(false);
  });

  it("answers false at once for an agent that does not take it", async () => {
    const { conn, sessionId } = await start("turns:\n  - - sleep: 300\n");
    expect(conn.steers).toBe(false);
    const turn = conn.prompt(sessionId, "go");
    expect(await conn.steer(sessionId, "hi")).toBe(false);
    await turn;
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("startAgent with an agent that ignores SIGTERM", () => {
  it("kills it with SIGKILL after a failed initialize", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "stubborn-")), "pid");
    // Answers initialize with an error, then ignores SIGTERM.
    const script = [
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      'process.on("SIGTERM", () => {});',
      'process.stdin.once("data", (d) => {',
      '  const id = JSON.parse(String(d).split("\\n")[0]).id;',
      '  const error = { code: -32603, message: "boom" };',
      '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error }) + "\\n");',
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const profile: AgentProfile = {
      id: "stubborn",
      name: "Stubborn",
      command: [process.execPath, "-e", script],
      env: {},
      exporter: null,
    };
    await expect(startAgent(profile, { cwd: tmpdir() })).rejects.toThrow(/boom/);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(alive(pid)).toBe(true);
    await new Promise((r) => setTimeout(r, CLOSE_GRACE_MS + 500));
    expect(alive(pid)).toBe(false);
  }, 10_000);

  it("kills it when the abort signal fires", async () => {
    const profile: AgentProfile = {
      id: "silent",
      name: "Silent",
      command: [
        process.execPath,
        "-e",
        'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
      ],
      env: {},
      exporter: null,
    };
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 200);
    // Windows has no signals: taskkill ends the process tree with exit code 1.
    await expect(startAgent(profile, { cwd: tmpdir(), signal: abort.signal })).rejects.toThrow(
      process.platform === "win32" ? /exited \(code 1, signal null\)/ : /signal SIGKILL/,
    );
  });
});
