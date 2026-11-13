#!/usr/bin/env node
// A fake `pi --mode rpc` for tests. It loads the real gate extension (`-e <path>`) and plays
// FAKE_PI (JSON): { calls: [{ toolName, input }], reply, error?, startFail? }.
// Each prompt runs every call through the gate, then replies. "{images}" in the reply becomes
// the mime types of the images the prompt carried.

import { pathToFileURL } from "node:url";
import { type GateApi, LineSplitter } from "../src/index.ts";

interface Plan {
  calls: { toolName: string; input: Record<string, unknown> }[];
  reply: string;
  error?: string;
  startFail?: boolean;
}

const plan = JSON.parse(process.env.FAKE_PI ?? '{"calls":[],"reply":"ok"}') as Plan;
if (plan.startFail === true) {
  process.stderr.write("fake pi: no model configured\n");
  process.exit(1);
}
const write = (r: object) => process.stdout.write(`${JSON.stringify(r)}\n`);
const ext = process.argv[process.argv.indexOf("-e") + 1] ?? "";
const answers = new Map<string, (r: Record<string, unknown>) => void>();
let nextUi = 1;
let images: { mimeType: string }[] = [];
let aborted = false;
let abortRun: (() => void) | undefined;

type Handler = Parameters<GateApi["on"]>[1];
let gate: Handler | undefined;
const mod = (await import(pathToFileURL(ext).href)) as { default: (pi: GateApi) => void };
mod.default({
  on: (_e, h) => {
    gate = h;
  },
});

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

async function run(): Promise<void> {
  aborted = false;
  const abortP = new Promise<"aborted">((r) => (abortRun = () => r("aborted")));
  for (const [i, call] of plan.calls.entries()) {
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
    write({
      type: "tool_execution_end",
      toolCallId,
      toolName: call.toolName,
      isError: verdict !== undefined,
    });
    if (verdict !== undefined) process.stderr.write(`blocked: ${verdict.reason}\n`);
  }
  if (plan.error !== undefined) {
    write({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: plan.error },
    });
  } else {
    write({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: plan.reply.replace("{images}", images.map((i) => i.mimeType).join(",")),
      },
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
    switch (r.type) {
      case "get_state":
        respond({ isStreaming: false });
        break;
      case "prompt":
        images = (r.images as { mimeType: string }[] | undefined) ?? [];
        respond({ disposition: "started" });
        void run();
        break;
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
