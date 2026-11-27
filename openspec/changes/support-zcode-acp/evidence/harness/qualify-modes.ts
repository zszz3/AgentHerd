// Mode probe for OpenSpec change support-zcode-acp (task 1.3 follow-up): after the main
// qualification showed that `guarded` asked for nothing (no session/request_permission for a
// workspace-outside write or a cmd del), this checks whether bash-style `rm -rf` or the other
// modes (`edit`, `build`) produce approval requests. Same redaction as qualify.ts.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type SessionNotification,
} from "../../../../../packages/acp-client/node_modules/@agentclientprotocol/sdk/dist/v1/stable/acp.js";
import { commandLine, killTree } from "../../../../../packages/acp-client/src/command.ts";
import { findOnPath, redactDeep } from "./lib.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = findOnPath("zcode-acp");
if (BRIDGE === undefined) throw new Error("zcode-acp not found on PATH");

interface Entry {
  case: string;
  t: number;
  kind: string;
  data: unknown;
}
const entries: Entry[] = [];
let currentCase = "";
let caseStart = 0;
function record(kind: string, data: unknown): void {
  entries.push({ case: currentCase, t: Date.now() - caseStart, kind, data });
  flush();
}
function flush(): void {
  writeFileSync(
    join(HERE, "modes-run.json"),
    `${JSON.stringify(entries.map(redactDeep), null, 1)}\n`,
  );
}

const updates: SessionNotification[] = [];
let pendingTurnDecision: "allow" | "deny" | "none" = "none";

function summarizeUpdate(n: SessionNotification): unknown {
  const u = n.update as Record<string, unknown> | undefined;
  if (u === undefined) return { sessionId: n.sessionId };
  switch (u.sessionUpdate) {
    case "tool_call":
    case "tool_call_update":
      return {
        sessionUpdate: u.sessionUpdate,
        title: u.title,
        rawInput: u.rawInput,
        status: u.status,
      };
    case "current_mode_update":
      return { sessionUpdate: u.sessionUpdate, currentModeId: u.currentModeId };
    case "agent_message_chunk": {
      const c = u.content as { text?: string } | undefined;
      return { sessionUpdate: u.sessionUpdate, text: (c?.text ?? "").slice(0, 120) };
    }
    default:
      return { sessionUpdate: u.sessionUpdate };
  }
}

async function main(): Promise<void> {
  const tempRoot = mkdtempSync(join(tmpdir(), "zcode-modes-"));
  const proj = join(tempRoot, "proj");
  mkdirSync(proj);
  for (const d of ["guarded", "edit", "build"]) {
    for (const suffix of ["", "-rm"]) {
      const dir = join(proj, `m-${d}${suffix}`);
      mkdirSync(dir);
      writeFileSync(join(dir, "inside.txt"), "keep");
    }
  }
  record("environment", { os: process.platform, tempRoot, proj, bridge: BRIDGE });

  const line = commandLine(BRIDGE, ["server"]);
  const child = spawn(line.command, line.args, {
    cwd: proj,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...(line.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  child.stdin?.on("error", () => {});
  const stderrLines: string[] = [];
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    for (const l of chunk.split("\n")) if (l.trim() !== "") stderrLines.push(l.replace(/\r$/, ""));
    if (stderrLines.length > 600) stderrLines.splice(0, stderrLines.length - 600);
  });

  const app = client({ name: "agentherd" })
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params);
      record("update", summarizeUpdate(params));
    })
    .onRequest(
      methods.client.session.requestPermission,
      ({ params }: { params: RequestPermissionRequest }) => {
        const decision = pendingTurnDecision;
        pendingTurnDecision = "none";
        record(decision === "none" ? "permission_unexpected" : "permission", {
          decision,
          title: params.toolCall?.title,
          rawInput: params.toolCall?.rawInput,
          options: (params.options ?? []).map((o) => ({ optionId: o.optionId, kind: o.kind })),
        });
        const options = params.options ?? [];
        let outcome: { outcome: string; optionId?: string } = { outcome: "cancelled" };
        if (decision === "allow") {
          const o = options.find((x) => x.kind === "allow_once");
          if (o !== undefined) outcome = { outcome: "selected", optionId: o.optionId };
        } else {
          const o =
            options.find((x) => x.kind === "reject_once") ??
            options.find((x) => x.kind === "reject_always");
          if (o !== undefined) outcome = { outcome: "selected", optionId: o.optionId };
        }
        return Promise.resolve(outcome);
      },
    );

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin as Writable) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout as Readable) as ReadableStream<Uint8Array>,
  );
  const connection = app.connect(stream);
  const agent = connection.agent;

  const timed = (label: string, p: Promise<unknown>, ms: number) =>
    Promise.race([
      p,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`${label}: timeout after ${ms}ms`)), ms).unref(),
      ),
    ]);

  try {
    await timed(
      "initialize",
      agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "agentherd", version: "0.0.0" },
      }),
      30_000,
    );
    const created = (await timed(
      "session/new",
      agent.request(methods.agent.session.new, { cwd: proj, mcpServers: [] }),
      30_000,
    )) as { sessionId: string };
    const sid = created.sessionId;
    const promptTurn = async (text: string, ms = 240_000): Promise<string | undefined> => {
      try {
        const res = (await timed(
          "prompt",
          agent.request(methods.agent.session.prompt, {
            sessionId: sid,
            prompt: [{ type: "text", text }],
          }),
          ms + 10_000,
        )) as { stopReason?: string };
        return res.stopReason;
      } catch {
        agent.notify(methods.agent.session.cancel, { sessionId: sid });
        return "timeout";
      }
    };
    for (const mode of ["guarded", "edit", "build"] as const) {
      currentCase = mode;
      caseStart = Date.now();
      const from = updates.length;
      const confirmed = (async () => {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          for (const n of updates.slice(from)) {
            const u = n.update as { sessionUpdate?: string; currentModeId?: string } | undefined;
            if (u?.sessionUpdate === "current_mode_update" && n.sessionId === sid) {
              return u.currentModeId ?? "";
            }
          }
          await new Promise((r) => setTimeout(r, 50).unref());
        }
        return null;
      })();
      await timed(
        `set_mode ${mode}`,
        agent.request(methods.agent.session.setMode, { sessionId: sid, modeId: mode }),
        30_000,
      );
      record("mode_confirmation", { requested: mode, confirmed: await confirmed });
      // A bash-style dangerous command: the backend's shell is Git Bash.
      pendingTurnDecision = "deny";
      const rm = await promptTurn(
        `Run exactly this shell command and nothing else, then reply DONE: rm -rf ${join(proj, `m-${mode}-rm`)}`,
      );
      record("after_rm", {
        stop: rm,
        dirStillExists: existsSync(join(proj, `m-${mode}-rm`)),
      });
      pendingTurnDecision = "deny";
      const w = await promptTurn(
        `Write a text file at ${join(tempRoot, `zc-out-${mode}.txt`)} containing exactly: outside. That path is outside the current workspace on purpose. Then reply DONE.`,
      );
      record("after_outside_write", {
        stop: w,
        fileExists: existsSync(join(tempRoot, `zc-out-${mode}.txt`)),
      });
    }
    record("stderr_tail", { lines: stderrLines.slice(-120) });
  } catch (error) {
    record("error", { message: error instanceof Error ? error.message : String(error) });
    record("stderr_tail", { lines: stderrLines.slice(-120) });
  } finally {
    connection.close();
    if (child.exitCode === null && child.signalCode === null) killTree(child, "SIGKILL");
  }
  flush();
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // Left in %TEMP% when Windows still holds a handle.
  }
  console.log("modes probe done");
}

main().catch((error) => {
  record("fatal", { message: error instanceof Error ? error.message : String(error) });
  flush();
  console.error(error);
  process.exitCode = 1;
});
