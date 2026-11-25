// E2E scenarios for M1 (docs/spec/07-delivery.md): a real mock agent process speaks ACP,
// the core decides, and a fake channel plays the owner.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeChannel, type SentMessage } from "@agentherd/channel-fake";
import type { AgentProfile, ItemView } from "@agentherd/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/clock.ts";
import { Herd } from "../../src/herd.ts";
import type { HerderEvent } from "../../src/herder-port.ts";
import { Store } from "../../src/store.ts";

const BIN = fileURLToPath(new URL("../../../mock-agent/bin/mock-agent.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "agentherd-e2e-"));
let herds: Herd[] = [];

afterEach(async () => {
  await Promise.all(herds.map((h) => h.stop()));
  herds = [];
});

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

async function setup(
  script: string,
  opts: { remindMinutes?: number; clock?: FakeClock; events?: HerderEvent[] } = {},
) {
  const channel = new FakeChannel("owner");
  const store = Store.open(":memory:");
  const herd = new Herd({
    home: dir,
    userHome: "/Users/me",
    channel,
    binding: { channelId: "fake", ownerId: "owner", data: {} },
    mode: "assist",
    locale: "en",
    profiles: [profile(script)],
    store,
    ...(opts.clock === undefined ? {} : { clock: opts.clock }),
    ...(opts.remindMinutes === undefined ? {} : { remindMinutes: opts.remindMinutes }),
    ...(opts.events === undefined
      ? {}
      : {
          herder: () => ({
            ownerMessage: () => {},
            ownerAnswer: () => {},
            event: (e: HerderEvent) => opts.events?.push(e),
            stop: async () => {},
          }),
        }),
  });
  herds.push(herd);
  await herd.start();
  return { channel, store, herd };
}

const isOpenItem = (m: SentMessage) =>
  m.view.kind === "item" && (m.view as ItemView).final === undefined;

// Only a mass delete reaches the owner (ADR 0029); a plain command is approved by AgentHerd.
const ONE_PERMISSION = (expect: string, command = "rm -rf ./*") => `
turns:
  - - tool_call: { id: t1, title: "Run ${command}", kind: execute, command: "${command}", status: pending }
    - request_permission:
        toolCall: { id: t1, title: "Run ${command}", kind: execute, command: "${command}" }
        expect: ${expect}
    - message: "done"
    - end_turn: end_turn
`;

describe("E2E-APPROVAL-TOLD (ADR 0057)", () => {
  it("the Herder hears how each card was answered", async () => {
    const events: HerderEvent[] = [];
    const { channel, herd } = await setup(ONE_PERMISSION("deny"), { events });
    const run = herd.run("mock", dir, "go");
    const card = await channel.waitFor(isOpenItem);
    await channel.tap((card.view as ItemView).itemId, "skip");
    await run;
    expect(events.filter((e) => e.kind === "approval")).toMatchObject([
      { kind: "approval", outcome: "skipped", title: "go", text: "Run rm -rf ./*" },
    ]);
  });
});

describe("E2E-APPROVE", () => {
  it("the owner's Allow reaches the agent and the card shows the result", async () => {
    const { channel, store, herd } = await setup(ONE_PERMISSION("allow"));
    const run = herd.run("mock", dir, "go");
    const card = await channel.waitFor(isOpenItem);
    const view = card.view as ItemView;
    expect(view.body).toContain("rm -rf ./*");
    expect(view.reason).toBe("deletes a lot at once; needs your confirmation");
    await channel.tap(view.itemId, "allow");
    const result = await run;
    expect(result.stopReason).toBe("end_turn");
    expect((card.view as ItemView).final).toBe("Allowed by you");
    expect((card.view as ItemView).options).toEqual([]);
    const decisions = store.decisionsFor(view.itemId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ action: "allow", source: "human", ownerId: "owner" });
    expect(store.getItem(view.itemId)?.state).toBe("decided");
  });

  it("Deny reaches the agent", async () => {
    const { channel, herd } = await setup(ONE_PERMISSION("deny"));
    const run = herd.run("mock", dir, "go");
    const card = await channel.waitFor(isOpenItem);
    await channel.tap((card.view as ItemView).itemId, "deny");
    await run;
    expect((card.view as ItemView).final).toBe("Denied by you");
  });

  it("a command that is not a mass delete is approved without a card", async () => {
    const { channel, store, herd } = await setup(ONE_PERMISSION("allow", "pnpm test"));
    await herd.run("mock", dir, "go");
    expect(channel.ofKind("item")).toHaveLength(0);
    expect(store.auditRows("item.decided")).toHaveLength(1);
  });

  it("a wrapped Windows shell mass delete (execute + rawInput.command) asks the owner; a scoped one is approved", async () => {
    const massCmd = 'powershell -NoProfile -Command \\"Remove-Item -Recurse -Force .\\"';
    const { channel, store, herd } = await setup(ONE_PERMISSION("allow", massCmd));
    const run = herd.run("mock", dir, "go");
    const card = await channel.waitFor(isOpenItem);
    const view = card.view as ItemView;
    expect(view.reason).toBe("deletes a lot at once; needs your confirmation");
    await channel.tap(view.itemId, "allow");
    const result = await run;
    expect(result.stopReason).toBe("end_turn");
    expect(store.decisionsFor(view.itemId)[0]).toMatchObject({ action: "allow", source: "human" });

    const safeCmd = 'cmd /c \\"rd /s /q dist\\"';
    const safe = await setup(ONE_PERMISSION("allow", safeCmd));
    await safe.herd.run("mock", dir, "go");
    expect(safe.channel.ofKind("item")).toHaveLength(0);
  });

  it("an owner's deny rule answers without a card", async () => {
    const { channel, store, herd } = await setup(ONE_PERMISSION("deny", "pnpm test"));
    herd.addRule({
      id: "r1",
      action: "deny",
      match: { command: "pnpm test" },
      createdAt: "2026-11-04T00:00:00Z",
      createdBy: "owner",
    });
    await herd.run("mock", dir, "go");
    expect(channel.ofKind("item")).toHaveLength(0);
    expect(store.auditRows("item.decided")).toHaveLength(1);
  });
});

describe("E2E-OWNER-ONLY", () => {
  it("a tap from someone else changes nothing", async () => {
    const { channel, store, herd } = await setup(ONE_PERMISSION("allow"));
    const run = herd.run("mock", dir, "go");
    const card = await channel.waitFor(isOpenItem);
    const itemId = (card.view as ItemView).itemId;
    await channel.tap(itemId, "allow", "intruder");
    expect((card.view as ItemView).final).toBeUndefined();
    expect(store.decisionsFor(itemId)).toHaveLength(0);
    expect(store.auditRows("inbound.dropped")).toHaveLength(1);
    await channel.tap(itemId, "allow");
    await run;
    expect(store.decisionsFor(itemId)).toHaveLength(1);
  });
});

describe("E2E-DUPLICATE-ACTION", () => {
  it("a second tap is dropped", async () => {
    const { channel, store, herd } = await setup(ONE_PERMISSION("allow"));
    const run = herd.run("mock", dir, "go");
    const card = await channel.waitFor(isOpenItem);
    const itemId = (card.view as ItemView).itemId;
    await Promise.all([channel.tap(itemId, "allow"), channel.tap(itemId, "deny")]);
    await run;
    expect(store.decisionsFor(itemId)).toHaveLength(1);
    expect((card.view as ItemView).final).toBe("Allowed by you");
    await channel.tap(itemId, "deny");
    expect(store.decisionsFor(itemId)).toHaveLength(1);
  });
});

describe("E2E-REMIND (ADR 0056)", () => {
  it("an open item gets one reminder, then closes as not done after an hour", async () => {
    const clock = new FakeClock();
    const { channel, store, herd } = await setup(ONE_PERMISSION("deny"), { clock });
    const run = herd.run("mock", dir, "go");
    const card = await channel.waitFor(isOpenItem);
    const itemId = (card.view as ItemView).itemId;
    await clock.advance(29 * 60_000);
    expect(channel.ofKind("text")).toHaveLength(0);
    await clock.advance(2 * 60_000);
    await new Promise((r) => setImmediate(r));
    const reminders = channel.ofKind("text");
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.view.text).toContain("Still waiting for you: Run rm -rf ./*");
    expect(store.getItem(itemId)?.state).toBe("open");
    await clock.advance(30 * 60_000);
    const result = await run;
    expect(result.stopReason).toBe("end_turn");
    expect(store.decisionsFor(itemId)[0]).toMatchObject({
      action: "deny",
      reason: "no answer in time",
    });
    expect((card.view as ItemView).final).toBe("No answer in 1 hour; the step was not done");
    expect(channel.ofKind("text")).toHaveLength(1);
  });

  it("「先不管」 closes it at once as not done", async () => {
    const { channel, store, herd } = await setup(ONE_PERMISSION("deny"));
    const run = herd.run("mock", dir, "go");
    const card = await channel.waitFor(isOpenItem);
    const itemId = (card.view as ItemView).itemId;
    await channel.tap(itemId, "skip");
    await run;
    expect(store.decisionsFor(itemId)[0]).toMatchObject({
      action: "deny",
      reason: "owner: not now",
    });
    expect((card.view as ItemView).final).toBe("Left by you: the step was not done");
  });
});

describe("E2E-BATCH (ADR 0056)", () => {
  it("approvals of two tasks share one card; 「allow 2」 and 「allow all」 answer them", async () => {
    const { channel, store, herd } = await setup(ONE_PERMISSION("allow"));
    const first = herd.run("mock", dir, "one");
    const card = await channel.waitFor(isOpenItem);
    const second = herd.run("mock", dir, "two");
    await channel.waitFor((m) => m === card && (m.view as ItemView).lines?.length === 2);
    expect(channel.ofKind("item")).toHaveLength(1);
    const view = card.view as ItemView;
    expect(view.title).toBe("2 requests waiting for you");
    expect(view.options.map((o) => o.action)).toEqual(["allow-all", "skip-all"]);
    const [one, two] = view.lines ?? [];
    await channel.say("allow 2");
    await second;
    expect(store.getItem(two?.itemId as string)?.state).toBe("decided");
    expect(store.getItem(one?.itemId as string)?.state).toBe("open");
    expect((card.view as ItemView).lines?.[1]?.final).toBe("Allowed by you");
    await channel.tap(view.itemId, "allow-all");
    await first;
    expect((card.view as ItemView).final).toBe("All handled");
    expect(store.decisionsFor(one?.itemId as string)[0]?.action).toBe("allow");
  });
});

describe("E2E-LEAVES-MAC (ADR 0056)", () => {
  it("git push asks the owner", async () => {
    const { channel, herd } = await setup(ONE_PERMISSION("allow", "git push origin main"));
    const run = herd.run("mock", dir, "go");
    const card = await channel.waitFor(isOpenItem);
    expect((card.view as ItemView).reason).toBe(
      "leaves your Mac: pushes to a remote; needs your confirmation",
    );
    await channel.tap((card.view as ItemView).itemId, "allow");
    await run;
  });

  it("a push the owner allowed for the task runs without a card, and is kept on the task", async () => {
    const { channel, store, herd } = await setup(ONE_PERMISSION("allow", "git push origin main"));
    const { taskId, turn } = await herd.startTask(
      "mock",
      dir,
      "fix it and push",
      undefined,
      undefined,
      undefined,
      ["push"],
    );
    expect((await turn).stopReason).toBe("end_turn");
    expect(channel.ofKind("item")).toHaveLength(0);
    expect(store.task(taskId)?.task.allowedSteps).toEqual(["push"]);
  });
});
