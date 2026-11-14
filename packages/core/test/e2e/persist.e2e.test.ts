// E2E for ADR 0039: tasks are saved in herd.db, come back after a restart, and an ended task is
// continued in the same folder. A real mock agent speaks ACP.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeChannel } from "@agentherd/channel-fake";
import type { AgentProfile, AskView } from "@agentherd/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Herd } from "../../src/herd.ts";
import { Store } from "../../src/store.ts";
import { historyText } from "../../src/task-runner.ts";

const BIN = fileURLToPath(new URL("../../../mock-agent/bin/mock-agent.ts", import.meta.url));
let open: { herd: Herd; store: Store }[] = [];

afterEach(async () => {
  for (const o of open) {
    await o.herd.stop();
    o.store.close();
  }
  open = [];
});

function profile(dir: string, script: string): AgentProfile {
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

/** A Herd on `<dir>/herd.db`, as after an AgentHerd start. */
async function boot(dir: string, script: string, answers?: [string, string][]) {
  const store = Store.open(join(dir, "herd.db"));
  const channel = new FakeChannel("owner");
  const herd = new Herd({
    ...(answers === undefined
      ? {}
      : {
          herder: () => ({
            ownerMessage: () => {},
            ownerAnswer: (q: string, a: string) => {
              answers.push([q, a]);
            },
            event: () => {},
            stop: async () => {},
          }),
        }),
    home: dir,
    userHome: "/Users/me",
    channel,
    binding: { channelId: "fake", ownerId: "owner", data: {} },
    mode: "assist",
    locale: "en",
    profiles: [profile(dir, script)],
    store,
    boardDebounceMs: 10,
  });
  const o = { herd, store, channel };
  open.push(o);
  await herd.start();
  return o;
}

async function shutDown(o: { herd: Herd; store: Store }) {
  await o.herd.stop();
  o.store.close();
  open = open.filter((x) => x !== o);
}

const FIRST = `
turns:
  - - message: "Fixed it."
    - end_turn: end_turn
`;

describe("E2E-TASKS-KEPT (ADR 0039)", () => {
  it("shows tasks from before a restart, ended", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentherd-persist-"));
    const first = await boot(dir, FIRST);
    const { taskId, turn } = await first.herd.startTask("mock", dir, "Fix the flaky test");
    await turn;
    first.herd.board.changed();
    await shutDown(first);

    const second = await boot(dir, FIRST);
    expect(second.herd.openTasks()).toEqual([]);
    const [task] = second.herd.tasks();
    expect(task).toMatchObject({ id: taskId, title: "Fix the flaky test", agent: "Mock" });
    expect(second.herd.transcript(taskId).entries.map((e) => e.role)).toEqual(["prompt", "agent"]);
  });

  it("continues an ended task with the earlier conversation when the agent cannot load it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentherd-persist-"));
    const first = await boot(dir, FIRST);
    const { taskId, turn } = await first.herd.startTask("mock", dir, "Fix the flaky test");
    await turn;
    await shutDown(first);

    const second = await boot(dir, "turns:\n  - - echo_prompt: true\n    - end_turn: end_turn\n");
    await second.herd.promptTask(taskId, "Now add a test for it");
    expect(second.herd.openTasks().map((t) => t.id)).toEqual([taskId]);
    const entries = second.herd.transcript(taskId).entries;
    // The long echo is summarized after, so look for it rather than taking the last line.
    const echoed =
      entries.find((e) => e.role === "agent" && e.text.includes("Now add a test"))?.text ?? "";
    expect(echoed).toContain("This continues an earlier task");
    expect(echoed).toContain("AgentHerd: Fix the flaky test");
    expect(echoed).toContain("you: Fixed it.");
    expect(echoed).toContain("Now add a test for it");
    expect(
      entries.some((e) => e.role === "note" && e.text.startsWith("Continuing: restarted Mock")),
    ).toBe(true);
  });

  it("opens the agent's own session when it can, without the history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentherd-persist-"));
    const first = await boot(dir, `load_session: true\n${FIRST}`);
    const { taskId, turn } = await first.herd.startTask("mock", dir, "Fix the flaky test");
    await turn;
    await shutDown(first);

    const second = await boot(
      dir,
      "load_session: true\nturns:\n  - - echo_prompt: true\n    - end_turn: end_turn\n",
    );
    await second.herd.promptTask(taskId, "Now add a test for it");
    const entries = second.herd.transcript(taskId).entries;
    const echoed = entries.at(-1)?.text ?? "";
    expect(echoed).toContain("Now add a test for it");
    expect(echoed).not.toContain("This continues an earlier task");
    expect(second.store.auditRows("task.reopened").at(-1)?.data).toMatchObject({
      loaded: true,
      agentSessionId: "mock-1",
    });
  });

  it("ends a task that was running when AgentHerd went away", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentherd-persist-"));
    const store = Store.open(join(dir, "herd.db"));
    const now = new Date().toISOString();
    store.saveTask({
      task: {
        id: "t-crash",
        title: "Long job",
        project: "p",
        agent: "Mock",
        stage: "working",
        lastReport: "working",
        startedAt: now,
        updatedAt: now,
        automaticDecisions: [],
      },
      cwd: dir,
      profileId: "mock",
      failed: false,
    });
    store.addTranscript("t-crash", "prompt", "Long job");
    store.addTranscript("t-crash", "agent", "Halfway.");
    store.close();

    const second = await boot(dir, FIRST);
    expect(second.herd.tasks()[0]).toMatchObject({ id: "t-crash", stage: "failed" });
    expect(second.store.task("t-crash")?.endedAt).toBeDefined();
    // AgentHerd going away is not the task's fault: no lesson (ADR 0054).
    expect(second.store.memory.jobs()).toEqual([]);
  });
});

describe("E2E-RESUME-ASK (ADR 0040)", () => {
  it("asks the owner about a task the stop cut off, and passes the answer to the Herder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentherd-persist-"));
    const first = await boot(dir, "turns:\n  - - sleep: 5000\n    - message: late\n");
    const { taskId, turn } = await first.herd.startTask("mock", dir, "Long refactor");
    const cut = turn.catch(() => undefined); // the stop ends this turn
    await new Promise((r) => setTimeout(r, 300));
    await first.herd.stop();
    await cut;
    await shutDown(first);

    const answers: [string, string][] = [];
    const second = await boot(dir, FIRST, answers);
    const asks = second.channel.ofKind("ask").map((m) => m.view as AskView);
    expect(asks).toHaveLength(1);
    const ask = asks[0] as AskView;
    expect(ask.text).toContain("Long refactor");
    expect(ask.options.map((o) => o.label)).toEqual(["Continue", "No", "Other"]);
    expect(second.store.auditRows("tasks.resume-asked").at(-1)?.data).toMatchObject({
      taskIds: [taskId],
    });
    await second.herd.handle({
      kind: "action",
      from: "owner",
      target: ask.askId,
      action: "0",
    } as never);
    expect(answers).toEqual([[ask.text, "Continue"]]);
    await shutDown(second);

    // Asked once: the next start has nothing to ask.
    const third = await boot(dir, FIRST, []);
    expect(third.channel.ofKind("ask")).toEqual([]);
  });

  it("does not ask about tasks that had finished, or without a Herder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentherd-persist-"));
    const first = await boot(dir, FIRST);
    const { turn } = await first.herd.startTask("mock", dir, "Quick fix");
    await turn;
    await shutDown(first);
    const second = await boot(dir, FIRST, []);
    expect(second.channel.ofKind("ask")).toEqual([]);
  });
});

describe("historyText", () => {
  it("keeps prompts and replies, newest when long, and says what is left out (ADR 0062)", () => {
    const at = "2026-01-01T00:00:00Z";
    const text = historyText(
      [
        { id: 1, at, role: "prompt", text: "Fix it" },
        { id: 2, at, role: "tool", text: "npm test" },
        { id: 3, at, role: "agent", text: "Fixed." },
      ],
      100,
    );
    expect(text).toBe("AgentHerd: Fix it\n\nyou: Fixed.");
    expect(historyText([{ id: 1, at, role: "agent", text: "x".repeat(50) }], 10)).toBe(
      `[… the earlier 45 characters are left out …]\n${"x".repeat(10)}`,
    );
  });
});
