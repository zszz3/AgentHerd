// E2E for ADR 0025: a task started with a model gets that model's env, and the board and the
// report show the model. A real mock agent speaks ACP; a wrapper records its env.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FakeChannel } from "@agentherd/channel-fake";
import type { AgentProfile, ReportView } from "@agentherd/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentModels } from "../../src/herd.ts";
import { Herd } from "../../src/herd.ts";
import { Store } from "../../src/store.ts";

const BIN = fileURLToPath(new URL("../../../mock-agent/bin/mock-agent.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "agentherd-model-"));
let herds: Herd[] = [];

afterEach(async () => {
  await Promise.all(herds.map((h) => h.stop()));
  herds = [];
});

const ONE_TURN = `
turns:
  - - message: "done"
    - end_turn: end_turn
`;

/** A profile whose agent writes TEST_MODEL from its env to `out`, then runs the mock agent. */
function profile(out: string): AgentProfile {
  const script = join(dir, "one.yaml");
  writeFileSync(script, ONE_TURN);
  const wrapper = join(dir, "wrap.mjs");
  writeFileSync(
    wrapper,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(out)}, process.env.TEST_MODEL ?? "(none)");
await import(${JSON.stringify(pathToFileURL(BIN).href)});
`,
  );
  return {
    id: "mock",
    name: "Mock",
    command: [process.execPath, wrapper, "--script", script],
    env: { TEST_MODEL: "agent default" },
    exporter: null,
  };
}

const models: AgentModels = {
  list: () => [{ ref: "svc/fast", agents: ["mock"] }],
  launchFor: (profileId, ref) => {
    if (profileId !== "mock" || ref !== "svc/fast") throw new Error(`cannot run ${ref}`);
    return { env: { TEST_MODEL: ref } };
  },
};

async function setup(out: string, agentModels: AgentModels = models) {
  const channel = new FakeChannel("owner");
  const herd = new Herd({
    home: dir,
    userHome: "/Users/me",
    channel,
    binding: { channelId: "fake", ownerId: "owner", data: {} },
    mode: "assist",
    profiles: [profile(out)],
    store: Store.open(":memory:"),
    boardDebounceMs: 10,
    agentModels,
  });
  herds.push(herd);
  await herd.start();
  return { channel, herd };
}

describe("E2E-MODEL-PER-TASK", () => {
  it("runs the agent with the chosen model and shows it", async () => {
    const out = join(dir, "env-1.txt");
    const { channel, herd } = await setup(out);
    const { taskId, turn } = await herd.startTask("mock", dir, "fix it", "fix it", "svc/fast");
    await turn;
    expect(readFileSync(out, "utf8")).toBe("svc/fast");
    const task = herd.tasks().find((t) => t.id === taskId);
    expect(task?.model).toBe("svc/fast");
    expect(task?.agent).toBe("Mock · svc/fast");
    const report = channel.ofKind("report").map((m) => m.view as ReportView)[0];
    expect(report?.subtitle).toContain("Mock · svc/fast");
  });

  it("selects a configured model without an explicit choice, and refuses unsupported models", async () => {
    const out = join(dir, "env-2.txt");
    const { herd } = await setup(out);
    const { turn } = await herd.startTask("mock", dir, "fix it");
    await turn;
    expect(readFileSync(out, "utf8")).toBe("svc/fast");
    await expect(herd.startTask("mock", dir, "fix it", "fix it", "svc/other")).rejects.toThrow(
      /cannot run svc\/other/,
    );
  });
});

describe("configured model enforcement", () => {
  it("rejects an explicit model outside the configured list even if the adapter accepts it", async () => {
    const { herd } = await setup(join(dir, "unlisted.txt"), {
      ...models,
      launchFor: (_p, ref) => ({ env: { TEST_MODEL: ref } }),
    });
    await expect(herd.startTask("mock", dir, "fix it", "fix it", "external/model")).rejects.toThrow(
      /cannot run/,
    );
    expect(herd.tasks()).toEqual([]);
  });

  it("does not start a task when the configured list is empty", async () => {
    const { herd } = await setup(join(dir, "empty.txt"), { ...models, list: () => [] });
    await expect(herd.startTask("mock", dir, "fix it")).rejects.toThrow(/no configured model/);
    expect(herd.tasks()).toEqual([]);
  });

  it("selects a configured model when continuing a legacy task without one", async () => {
    const out = join(dir, "legacy.txt");
    const { herd } = await setup(out);
    const { taskId, turn } = await herd.startTask("mock", dir, "fix it", "fix it", "svc/fast");
    await turn;
    await herd.endTask(taskId, "done");
    // Simulate a saved task from before per-task model selection.
    const following = herd.tasks().find((t) => t.id === taskId);
    if (following === undefined) throw new Error("missing task");
    delete following.model;
    await herd.promptTask(taskId, "continue");
    expect(readFileSync(out, "utf8")).toBe("svc/fast");
    expect(herd.tasks().find((t) => t.id === taskId)?.model).toBe("svc/fast");
  });
});

describe("E2E-MODEL-FALLBACK", () => {
  /** An agent that crashes before saying anything when its model is svc/broken. */
  function switching(): AgentProfile {
    const good = join(dir, "good.yaml");
    writeFileSync(good, ONE_TURN);
    const bad = join(dir, "bad.yaml");
    writeFileSync(bad, "turns:\n  - - crash: 1\n");
    const wrapper = join(dir, "switch.mjs");
    writeFileSync(
      wrapper,
      `process.argv.push("--script", process.env.TEST_MODEL === "svc/broken" ? ${JSON.stringify(bad)} : ${JSON.stringify(good)});
await import(${JSON.stringify(pathToFileURL(BIN).href)});
`,
    );
    return {
      id: "mock",
      name: "Mock",
      command: [process.execPath, wrapper],
      env: {},
      exporter: null,
    };
  }

  async function start(next: AgentModels["next"]) {
    const channel = new FakeChannel("owner");
    const store = Store.open(":memory:");
    const herd = new Herd({
      home: dir,
      userHome: "/Users/me",
      channel,
      binding: { channelId: "fake", ownerId: "owner", data: {} },
      mode: "assist",
      locale: "en",
      profiles: [
        switching(),
        {
          id: "dead",
          name: "Dead",
          command: [join(dir, "no-such-agent")],
          env: {},
          exporter: null,
        },
      ],
      store,
      boardDebounceMs: 10,
      agentModels: {
        list: () => [
          { ref: "svc/broken", agents: ["mock"] },
          { ref: "svc/good", agents: ["mock", "dead"] },
        ],
        launchFor: (_p, ref) => ({ env: { TEST_MODEL: ref } }),
        ...(next === undefined ? {} : { next }),
      },
    });
    herds.push(herd);
    await herd.start();
    return { channel, store, herd };
  }

  it("runs the turn again on the next model when the first broke before doing anything", async () => {
    const asked: string[][] = [];
    const { channel, store, herd } = await start(async (_p, failed, tried) => {
      asked.push([failed, ...tried]);
      return { profileId: "mock", model: "svc/good" };
    });
    const { taskId, turn } = await herd.startTask("mock", dir, "fix it", "fix it", "svc/broken");
    expect((await turn).stopReason).toBe("end_turn");
    expect(asked).toEqual([["svc/broken", "svc/broken"]]);
    const task = herd.tasks().find((t) => t.id === taskId);
    expect(task?.model).toBe("svc/good");
    expect(store.auditRows("task.model-switched")).toHaveLength(1);
    const notes = channel.ofKind("text").map((m) => JSON.stringify(m.view));
    expect(notes.some((n) => n.includes("running again with Mock · svc/good"))).toBe(true);
    const report = channel.ofKind("report").map((m) => m.view as ReportView)[0];
    expect(report?.subtitle).toContain("Mock · svc/good");
  });

  it("moves the same model to another agent when the first agent does not start (ADR 0031)", async () => {
    const { channel, herd } = await start(async (profileId, failed) =>
      profileId === "dead" ? { profileId: "mock", model: failed } : undefined,
    );
    const { taskId, turn } = await herd.startTask("dead", dir, "fix it", "fix it", "svc/good");
    expect((await turn).stopReason).toBe("end_turn");
    const task = herd.tasks().find((t) => t.id === taskId);
    expect(task?.agent).toBe("Mock · svc/good");
    const notes = channel.ofKind("text").map((m) => JSON.stringify(m.view));
    expect(notes.some((n) => n.includes("Dead · svc/good") && n.includes("Mock · svc/good"))).toBe(
      true,
    );
  });

  it("fails as before when no other model answers", async () => {
    const { herd } = await start(async () => undefined);
    const { turn } = await herd.startTask("mock", dir, "fix it", "fix it", "svc/broken");
    await expect(turn).rejects.toThrow();
  });
});
