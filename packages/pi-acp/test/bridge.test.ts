// The bridge end to end: AgentHerd's ACP client → bin/pi-acp.ts → a fake Pi that runs the
// real gate extension.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentConnection,
  type PermissionRequest,
  type SessionUpdateEvent,
  startAgent,
} from "@agentherd/acp-client";
import { afterEach, describe, expect, it } from "vitest";

const BIN = fileURLToPath(new URL("../bin/pi-acp.ts", import.meta.url));
const FAKE = fileURLToPath(new URL("./fake-pi.ts", import.meta.url));

interface Plan {
  calls?: { toolName: string; input: Record<string, unknown> }[];
  reply?: string;
  error?: string;
  startFail?: boolean;
}

let open: AgentConnection | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

async function start(plan: Plan) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-acp-"));
  const conn = await startAgent(
    {
      id: "pi",
      name: "Pi",
      command: [process.execPath, BIN, "--pi", FAKE],
      env: { FAKE_PI: JSON.stringify({ calls: [], reply: "done", ...plan }) },
      exporter: null,
    },
    { cwd },
  );
  open = conn;
  const updates: SessionUpdateEvent[] = [];
  const asked: PermissionRequest[] = [];
  conn.on("update", (u) => updates.push(u));
  conn.on("permission", (p) => asked.push(p));
  return { conn, cwd, updates, asked };
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
});
