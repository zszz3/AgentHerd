// E2E for ADR 0063: a message for a task whose turn is running goes into that turn when the agent
// takes it, so the agent reads it at its next step instead of after the whole turn. A real mock
// agent speaks ACP with AgentHerd's steer extension; the Herder is a stand-in.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeChannel } from "@agentherd/channel-fake";
import type { AgentProfile, TextView } from "@agentherd/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Herd } from "../../src/herd.ts";
import type { HerderEvent, OwnerImage, VoiceRequest } from "../../src/herder-port.ts";
import { Store } from "../../src/store.ts";

const BIN = fileURLToPath(new URL("../../../mock-agent/bin/mock-agent.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "agentherd-steer-"));
let herds: Herd[] = [];

afterEach(async () => {
  await Promise.all(herds.map((h) => h.stop()));
  herds = [];
});

/** Reads what came during the turn, then finishes it; a second turn only if one is asked for. */
const READS = `
steer: true
turns:
  - - message: "Working on it. "
    - read_steers: 3000
    - message: " Done."
    - end_turn: end_turn
  - - message: "Next turn."
    - end_turn: end_turn
`;

/** Reads what came, then works a while longer. */
const READS_SLOWLY = `
steer: true
turns:
  - - read_steers: 3000
    - sleep: 400
    - message: "Done."
    - end_turn: end_turn
`;

/** Never reads during the turn; the next turn shows its prompt. */
const MISSES = `
steer: true
turns:
  - - message: "Working."
    - sleep: 400
    - end_turn: end_turn
  - - echo_prompt: true
    - end_turn: end_turn
`;

/** An agent without the extension. */
const NO_STEER = `
turns:
  - - message: "Working."
    - sleep: 400
    - end_turn: end_turn
  - - message: "Next turn."
    - end_turn: end_turn
`;

const LONG = `
steer: true
turns:
  - - sleep: 5000
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

async function setup(script: string) {
  const channel = new FakeChannel("owner");
  const store = Store.open(":memory:");
  const asked: VoiceRequest[] = [];
  const events: HerderEvent[] = [];
  const owner: { text: string; images: OwnerImage[] | undefined }[] = [];
  const tokens: string[] = [];
  const herd = new Herd({
    home: dir,
    userHome: "/Users/me",
    channel,
    binding: { channelId: "fake", ownerId: "owner", data: {} },
    mode: "assist",
    locale: "en",
    profiles: [profile(script)],
    store,
    boardDebounceMs: 10,
    mcpServer: (token) => {
      tokens.push(token);
      return { name: "agentherd", command: "relay", args: [], env: [] };
    },
    herder: () => ({
      ownerMessage: (text: string, images?: OwnerImage[]) => owner.push({ text, images }),
      ownerAnswer: () => {},
      event: (e: HerderEvent) => events.push(e),
      voice: async (request: VoiceRequest) => {
        asked.push(request);
        return `Herder: ${request.reply}`;
      },
      stop: async () => {},
    }),
  });
  herds.push(herd);
  await herd.start();
  return { channel, herd, store, asked, events, owner, tokens };
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

const texts = (c: FakeChannel) => c.ofKind("text").map((m) => (m.view as TextView).text);
const prompts = (store: Store, taskId: string) =>
  store
    .transcript(taskId)
    .filter((e) => e.role === "prompt")
    .map((e) => e.text);
/** The turn is running: its prompt went to the agent. */
const running = (store: Store, taskId: string) => () => prompts(store, taskId).length > 0;

describe("E2E-STEER", () => {
  it("the owner's reply goes into the running turn, which answers it", async () => {
    const { channel, herd, store, asked, tokens } = await setup(READS);
    const { taskId, turn } = await herd.startTask("mock", dir, "Fix the tests");
    await until(running(store, taskId));
    // The owner replies to the task's ack line while the turn runs.
    await herd.mcp(tokens[0] as string, call("herd_ack", { text: "On it" }));
    const ack = channel.ofKind("text").find((m) => (m.view as TextView).text === "On it");
    if (ack?.ref === undefined) throw new Error("no ack");
    void channel.reply(ack.ref, "Also fix lint");
    await turn;
    expect(texts(channel)).toContain("Passed on: the agent sees this after the step it is on.");
    expect(prompts(store, taskId)).toEqual(["Fix the tests", "Also fix lint"]);
    // One turn, one report, which covers both messages.
    expect(channel.ofKind("report")).toHaveLength(1);
    expect(asked.map((a) => a.reply)).toEqual(["Working on it. Read: Also fix lint Done."]);
    expect(store.transcript(taskId).some((e) => e.text.includes("Next turn"))).toBe(false);
    const agent = store.transcript(taskId).filter((e) => e.role === "agent");
    expect(agent.at(-1)?.text).toContain("Read: Also fix lint");
    expect(store.auditRows("task.steered")).toMatchObject([{ data: { taskId, from: "owner" } }]);
  });

  it("the owner's word makes the turn theirs: a Herder-started task's ack reaches the phone", async () => {
    const { channel, herd, store, tokens } = await setup(READS_SLOWLY);
    const { taskId, turn } = await herd.startTask(
      "mock",
      dir,
      "Fix the tests",
      undefined,
      undefined,
      [],
      undefined,
      "herder",
    );
    await until(running(store, taskId));
    const read = herd.promptTask(taskId, "Also fix lint");
    await until(() => store.auditRows("task.steered").length > 0);
    await herd.mcp(tokens[0] as string, call("herd_ack", { text: "Fixing lint too" }));
    expect(texts(channel)).toContain("Fixing lint too");
    expect(await read).toMatchObject({ stopReason: "end_turn" });
    await turn;
    expect(channel.ofKind("report")).toHaveLength(1);
  });

  it("a message the turn ended before reading goes first as the next prompt", async () => {
    const { herd, store } = await setup(MISSES);
    const { taskId, turn } = await herd.startTask("mock", dir, "Fix the tests");
    await until(running(store, taskId));
    const next = herd.promptTask(taskId, "Also fix lint");
    await turn;
    expect(await next).toMatchObject({ stopReason: "end_turn" });
    expect(prompts(store, taskId)).toEqual(["Fix the tests", "Also fix lint"]);
    expect(store.auditRows("task.steer-missed")).toHaveLength(1);
    expect(store.auditRows("task.steered")).toHaveLength(0);
    const agent = store.transcript(taskId).filter((e) => e.role === "agent");
    expect(agent.at(-1)?.text).toContain("Also fix lint");
  });

  it("an agent without it gets the message after the turn, and the owner hears so", async () => {
    const { channel, herd, store, tokens } = await setup(NO_STEER);
    const { taskId, turn } = await herd.startTask("mock", dir, "Fix the tests");
    await until(running(store, taskId));
    await herd.mcp(tokens[0] as string, call("herd_ack", { text: "On it" }));
    const ack = channel.ofKind("text").find((m) => (m.view as TextView).text === "On it");
    if (ack?.ref === undefined) throw new Error("no ack");
    void channel.reply(ack.ref, "Also fix lint");
    await turn;
    await until(() => store.transcript(taskId).some((e) => e.text.includes("Next turn")));
    expect(texts(channel)).toContain("Queued: the agent gets this when its turn ends.");
    expect(prompts(store, taskId)).toEqual(["Fix the tests", "Also fix lint"]);
    expect(store.auditRows("task.steered")).toHaveLength(0);
  });

  it("a message still waiting when the task ends goes back to the Herder", async () => {
    const { herd, store, owner, events } = await setup(LONG);
    const { taskId, turn } = await herd.startTask("mock", dir, "Fix the tests");
    void turn.catch(() => {});
    await until(running(store, taskId));
    const failed = herd.promptTask(taskId, "Also fix lint").then(
      () => "",
      (e: Error) => e.message,
    );
    // The message waits in the agent, which does not read it before the task ends.
    await new Promise((r) => setTimeout(r, 100));
    await herd.endTask(taskId, "the owner closed it");
    expect(await failed).toBe("the task ended: the owner closed it");
    await until(() => owner.length > 0);
    expect(owner).toEqual([{ text: "Also fix lint", images: [] }]);
    expect(events.filter((e) => e.kind === "unread")).toMatchObject([
      { taskId, text: "Also fix lint", why: "the owner closed it", shown: "none" },
    ]);
  });
});
