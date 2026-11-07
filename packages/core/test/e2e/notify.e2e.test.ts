// E2E for telling the owner at the right time (docs/spec/04-herder.md "Delivery", "Background
// work"): background work holds the report back, waiting/blocked/failed reach the owner at once,
// herd_ack sends one line, and messages the channel did not take are retried.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StdioMcpServer } from "@agentherd/acp-client";
import { FakeChannel } from "@agentherd/channel-fake";
import type { AgentProfile, TextView, View } from "@agentherd/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/clock.ts";
import { Herd } from "../../src/herd.ts";
import { Store } from "../../src/store.ts";

const BIN = fileURLToPath(new URL("../../../mock-agent/bin/mock-agent.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "agentherd-notify-"));
let herds: Herd[] = [];

afterEach(async () => {
  await Promise.all(herds.map((h) => h.stop()));
  herds = [];
});

const SLOW = `
turns:
  - - sleep: 400
    - message: "Done."
    - end_turn: end_turn
`;

const BACKGROUND = `
turns:
  - - sleep: 400
    - message: "Started the build."
    - end_turn: end_turn
  - - message: "The build passed."
    - end_turn: end_turn
`;

function profile(script: string): AgentProfile {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(file, script);
  return {
    id: "mock",
    name: "Mock",
    command: [process.execPath, BIN, "--script", file],
    env: {},
    exporter: null,
  };
}

async function setup(p: AgentProfile) {
  const tokens: string[] = [];
  const channel = new FakeChannel("owner");
  const clock = new FakeClock();
  const store = Store.open(":memory:");
  const herd = new Herd({
    home: dir,
    userHome: "/Users/me",
    channel,
    binding: { channelId: "fake", ownerId: "owner", data: {} },
    mode: "assist",
    locale: "en",
    profiles: [p],
    store,
    clock,
    boardDebounceMs: 10,
    backgroundCheckMinutes: 1,
    mcpServer: (token): StdioMcpServer => {
      tokens.push(token);
      return { name: "agentherd", command: "relay", args: [], env: [{ name: "T", value: token }] };
    },
  });
  herds.push(herd);
  await herd.start();
  return { herd, tokens, channel, clock, store };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
}

const call = (name: string, args: unknown) => ({
  jsonrpc: "2.0" as const,
  id: 1,
  method: "tools/call",
  params: { name, arguments: args },
});

const reports = (channel: FakeChannel) => channel.messages.filter((m) => m.view.kind === "report");
const texts = (channel: FakeChannel) =>
  channel.messages.filter((m) => m.view.kind === "text").map((m) => (m.view as TextView).text);

describe("E2E-NOTIFY", () => {
  it("work left running in the background holds the report until the agent is done", async () => {
    const { herd, tokens, channel, clock } = await setup(profile(BACKGROUND));
    const { taskId, turn } = await herd.startTask("mock", dir, "Build it");
    await until(() => tokens.length > 0);
    await herd.mcp(
      tokens[0] as string,
      call("herd_report", { state: "progress", summary: "build running" }),
    );
    await turn;
    const task = () => herd.tasks().find((t) => t.id === taskId);
    expect(reports(channel)).toEqual([]);
    expect(task()?.stage).toBe("working");
    expect(task()?.lastReport).toBe("Still running in the background: build running");
    await clock.advance(60_000);
    await until(() => reports(channel).length > 0);
    expect(reports(channel)).toHaveLength(1);
    expect(task()?.stage).toBe("done");
  });

  it("an owner prompt during the wait gets its normal report", async () => {
    const { herd, tokens, channel, clock } = await setup(profile(BACKGROUND));
    const { taskId, turn } = await herd.startTask("mock", dir, "Build it");
    await until(() => tokens.length > 0);
    await herd.mcp(
      tokens[0] as string,
      call("herd_report", { state: "progress", summary: "build running" }),
    );
    await turn;
    await herd.promptTask(taskId, "How is it going?");
    expect(reports(channel)).toHaveLength(1);
    await clock.advance(10 * 60_000);
    expect(reports(channel)).toHaveLength(1);
  });

  it("an agent that needs the owner reaches them at once, and only once", async () => {
    const { herd, tokens, channel } = await setup(profile(SLOW));
    const { turn } = await herd.startTask("mock", dir, "Deploy");
    await until(() => tokens.length > 0);
    await herd.mcp(
      tokens[0] as string,
      call("herd_report", { state: "waiting", summary: "need the API key" }),
    );
    await until(() => texts(channel).length > 0);
    expect(texts(channel)).toContain("Needs you: need the API key");
    await turn;
    expect(reports(channel)).toEqual([]);
    expect(herd.tasks()[0]?.stage).toBe("needs-owner");
  });

  it("herd_ack sends one line to the owner, once per turn", async () => {
    const { herd, tokens, channel } = await setup(profile(SLOW));
    const { turn } = await herd.startTask("mock", dir, "Fix the tests");
    await until(() => tokens.length > 0);
    const token = tokens[0] as string;
    const list = await herd.mcp(token, { jsonrpc: "2.0", id: 9, method: "tools/list" });
    expect(list?.result).toMatchObject({
      tools: [{ name: "herd_report" }, { name: "herd_ack" }],
    });
    const first = await herd.mcp(token, call("herd_ack", { text: "Running the tests first" }));
    expect(first?.result).toEqual({ content: [{ type: "text", text: "sent" }] });
    const second = await herd.mcp(token, call("herd_ack", { text: "Again" }));
    expect(second?.result).toMatchObject({ isError: true });
    await until(() => texts(channel).length > 0);
    expect(texts(channel)).toEqual(["Running the tests first"]);
    await turn;
    expect(reports(channel)).toHaveLength(1);
  });

  it("a report the channel did not take is sent again later", async () => {
    const { herd, channel, clock, store } = await setup(profile(SLOW));
    const send = channel.send.bind(channel);
    let offline = true;
    channel.send = async (view: View) => {
      if (offline) throw new Error("offline");
      return send(view);
    };
    await herd.run("mock", dir, "Look around");
    expect(reports(channel)).toEqual([]);
    expect(store.outbox().some((r) => r.view.kind === "report")).toBe(true);
    offline = false;
    await clock.advance(60_000);
    await until(() => reports(channel).length > 0);
    expect(reports(channel)).toHaveLength(1);
    expect(store.outbox()).toEqual([]);
  });
});
