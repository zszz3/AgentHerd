#!/usr/bin/env node
// A fake `pi --mode rpc` for tests. It loads every `-e <path>` extension (gate, mcp, model)
// and plays FAKE_PI (JSON): { calls, reply, error?, steer?, startFail?, turns?, log? }.
// Each prompt runs every call through the gate and executes registered extension tools, then
// replies. "{images}" becomes the prompt's image mime types; "{results}" becomes tool outputs;
// "{steers}" becomes the messages the turn read with `steer`. With `log`, every command's type
// is appended to that file, one per line.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { type GateApi, LineSplitter, type McpExtensionApi } from "../src/index.ts";

interface Call {
  toolName: string;
  input: Record<string, unknown>;
}

interface TurnPlan {
  /** What the model writes before its tool calls, as its own message. */
  before?: string;
  calls?: Call[];
  reply?: string;
  error?: string;
  /**
   * After the calls, waits for a message sent with `steer`: "read" hands it to the model, "leave"
   * ends the turn with it still queued, "hold" waits for an abort.
   */
  steer?: "read" | "leave" | "hold";
}

interface Plan extends TurnPlan {
  startFail?: boolean;
  turns?: TurnPlan[];
  log?: string;
}

const plan = JSON.parse(process.env.FAKE_PI ?? '{"calls":[],"reply":"ok"}') as Plan;
if (plan.startFail === true) {
  process.stderr.write("fake pi: no model configured\n");
  process.exit(1);
}
const write = (r: object) => process.stdout.write(`${JSON.stringify(r)}\n`);
const log = (line: string) => {
  if (plan.log !== undefined) appendFileSync(plan.log, `${line}\n`);
};

function flagValues(flag: string): string[] {
  const out: string[] = [];
  for (let i = 2; i < process.argv.length - 1; i++) {
    if (process.argv[i] === flag) out.push(process.argv[i + 1] ?? "");
  }
  return out;
}

const sessionDir = flagValues("--session-dir")[0];
const sessionId = flagValues("--session-id")[0];
const markerFile =
  sessionDir !== undefined && sessionId !== undefined
    ? join(sessionDir, `${sessionId}.json`)
    : undefined;

const answers = new Map<string, (r: Record<string, unknown>) => void>();
let nextUi = 1;
let images: { mimeType: string }[] = [];
let aborted = false;
let abortRun: (() => void) | undefined;
let turnIndex = 0;
/** Pi's steering queue, and the messages the current turn read from it. */
const steering: string[] = [];
let steered: string[] = [];
let steerCame: (() => void) | undefined;
const queueUpdate = () => write({ type: "queue_update", steering: [...steering], followUp: [] });
const nextSteer = (): Promise<void> =>
  steering.length > 0
    ? Promise.resolve()
    : new Promise((resolve) => {
        steerCame = resolve;
      });
if (markerFile !== undefined && existsSync(markerFile)) {
  try {
    const saved = JSON.parse(readFileSync(markerFile, "utf8")) as { turn?: unknown };
    if (typeof saved.turn === "number") turnIndex = saved.turn + 1;
  } catch {
    turnIndex = 0;
  }
}

type Handler = Parameters<GateApi["on"]>[1];
type RegisteredTool = Parameters<McpExtensionApi["registerTool"]>[0];
let gate: Handler | undefined;
const registeredTools = new Map<string, RegisteredTool>();

const extensionApi = {
  on: (_event: string, h: Handler) => {
    gate = h;
  },
  registerTool: (tool: RegisteredTool) => {
    registeredTools.set(tool.name, tool);
  },
  registerProvider: () => {},
};

for (const ext of flagValues("-e")) {
  if (ext === "") continue;
  const mod = (await import(pathToFileURL(ext).href)) as {
    default?: (pi: typeof extensionApi) => void;
  };
  mod.default?.(extensionApi);
}

const ctx = {
  cwd: process.cwd(),
  hasUI: true,
  ui: {
    select(title: string, options: string[]): Promise<string | undefined> {
      const id = `ui-${nextUi++}`;
      write({ type: "extension_ui_request", id, method: "select", title, options });
      return new Promise((resolve) => {
        answers.set(id, (r) => resolve(typeof r.value === "string" ? r.value : undefined));
      });
    },
  },
};

async function run(turn: TurnPlan): Promise<void> {
  aborted = false;
  steered = [];
  const abortP = new Promise<"aborted">((r) => (abortRun = () => r("aborted")));
  const results: string[] = [];
  if (turn.before !== undefined) {
    write({ type: "message_start", message: { role: "assistant", content: [] } });
    write({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: turn.before },
    });
    write({ type: "message_end", message: { role: "assistant", stopReason: "toolUse" } });
  }
  for (const [i, call] of (turn.calls ?? []).entries()) {
    const toolCallId = `call-${i}`;
    write({ type: "tool_execution_start", toolCallId, toolName: call.toolName, args: call.input });
    const verdict = await Promise.race([
      gate?.({ toolCallId, toolName: call.toolName, input: call.input }, ctx),
      abortP,
    ]);
    if (verdict === "aborted" || aborted) {
      write({ type: "agent_settled", aborted: true });
      return;
    }
    if (verdict !== undefined) {
      write({ type: "tool_execution_end", toolCallId, toolName: call.toolName, isError: true });
      process.stderr.write(`blocked: ${verdict.reason}\n`);
      results.push(`blocked: ${verdict.reason}`);
      continue;
    }
    const tool = registeredTools.get(call.toolName);
    if (tool === undefined) {
      write({ type: "tool_execution_end", toolCallId, toolName: call.toolName, isError: false });
      continue;
    }
    let isError = false;
    try {
      const out = await Promise.race([tool.execute(toolCallId, call.input), abortP]);
      if (out === "aborted" || aborted) {
        write({ type: "agent_settled", aborted: true });
        return;
      }
      results.push(
        out.content.map((c) => (c.type === "text" ? c.text : `[${c.mimeType}]`)).join("\n"),
      );
    } catch (error) {
      isError = true;
      results.push(`error: ${(error as Error).message}`);
    }
    write({ type: "tool_execution_end", toolCallId, toolName: call.toolName, isError });
  }
  if (turn.steer !== undefined) {
    const came = await Promise.race([nextSteer(), abortP]);
    if (came === "aborted" || aborted || turn.steer === "hold") {
      await abortP;
      write({ type: "agent_settled", aborted: true });
      return;
    }
    if (turn.steer === "read") {
      // Like Pi: the queued messages leave the queue and reach the model at its next step.
      steered = steering.splice(0);
      queueUpdate();
      for (const text of steered) {
        write({ type: "message_start", message: { role: "user", content: text } });
        write({ type: "message_end", message: { role: "user", content: text } });
      }
    }
  }
  if (turn.error !== undefined) {
    write({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: turn.error },
    });
  } else {
    const text = (turn.reply ?? "")
      .replace("{images}", images.map((i) => i.mimeType).join(","))
      .replace("{results}", results.join("|"))
      .replace("{steers}", steered.join("|"));
    write({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: text },
    });
    write({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  }
  write({ type: "agent_end", messages: [] });
  write({ type: "agent_settled", aborted: false });
}

const splitter = new LineSplitter();
process.stdin.on("data", (chunk: Buffer) =>
  splitter.push(chunk, (line) => {
    const r = JSON.parse(line) as Record<string, unknown>;
    const respond = (data?: unknown) =>
      write({ id: r.id, type: "response", command: r.type, success: true, data });
    if (r.type !== "extension_ui_response")
      log(r.type === "set_steering_mode" ? `set_steering_mode ${String(r.mode)}` : String(r.type));
    switch (r.type) {
      case "get_state":
        respond({
          isStreaming: false,
          messageCount: markerFile !== undefined && existsSync(markerFile) ? 1 : 0,
        });
        break;
      case "set_steering_mode":
        respond();
        break;
      case "steer":
        steering.push(String(r.message));
        queueUpdate();
        respond({ disposition: "queued" });
        steerCame?.();
        steerCame = undefined;
        break;
      case "clear_queue": {
        const cleared = steering.splice(0);
        queueUpdate();
        respond({ steering: cleared, followUp: [] });
        break;
      }
      case "prompt": {
        images = (r.images as { mimeType: string }[] | undefined) ?? [];
        if (markerFile !== undefined) {
          mkdirSync(dirname(markerFile), { recursive: true });
          writeFileSync(markerFile, JSON.stringify({ turn: turnIndex }));
        }
        const turn = plan.turns?.[turnIndex] ?? plan;
        turnIndex += 1;
        respond({ disposition: "started" });
        void run(turn);
        break;
      }
      case "abort":
        aborted = true;
        abortRun?.();
        respond();
        break;
      case "extension_ui_response":
        answers.get(String(r.id))?.(r);
        break;
    }
  }),
);
process.stdin.on("end", () => process.exit(0));
