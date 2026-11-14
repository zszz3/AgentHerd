// E2E for ADR 0061: small news goes on the task board, not to the owner's phone, and a message a
// task never read comes back instead of vanishing. A real mock agent speaks ACP; the Herder is a
// stand-in.

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
const dir = mkdtempSync(join(tmpdir(), "agentherd-tiers-"));
let herds: Herd[] = [];

afterEach(async () => {
  await Promise.all(herds.map((h) => h.stop()));
  herds = [];
});

const TWO_TURNS = `
turns:
  - - message: "Opened the PR."
    - end_turn: end_turn
  - - message: "Renamed it."
    - end_turn: end_turn
`;

const SLOW = `
turns:
  - - sleep: 400
    - message: "Done."
    - end_turn: end_turn
  - - message: "Picked it up again."
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

async function setup(script: string, withHerder = true) {
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
    ...(withHerder
      ? {
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
        }
      : {}),
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
const lastReport = (herd: Herd, taskId: string) =>
  herd.tasks().find((t) => t.id === taskId)?.lastReport;

describe("E2E-NOTICE-TIERS", () => {
  it("a turn its pull request woke goes on the board, without the Herder's words", async () => {
    const { channel, herd, store, asked, events } = await setup(TWO_TURNS);
    const { taskId, turn } = await herd.startTask("mock", dir, "Open a PR");
    await turn;
    expect(channel.ofKind("report")).toHaveLength(1);
    await herd.promptTask(taskId, "(AgentHerd) alice commented: rename foo", [], "pull-request");
    expect(channel.ofKind("report")).toHaveLength(1);
    expect(asked).toHaveLength(1);
    expect(lastReport(herd, taskId)).toBe("Renamed it.");
    expect(events.filter((e) => e.kind === "task-reported")).toMatchObject([
      { taskId, text: "Renamed it.", shown: "board" },
    ]);
    expect(store.auditRows("report.unpushed")).toMatchObject([{ data: { level: "board" } }]);
  });

  it("the one-line ack of a task the Herder started goes on the board", async () => {
    const { channel, herd, store, tokens } = await setup(SLOW);
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
    await until(() => tokens.length > 0);
    const ack = await herd.mcp(tokens[0] as string, call("herd_ack", { text: "Running them" }));
    expect(ack?.result).toEqual({ content: [{ type: "text", text: "sent" }] });
    expect(texts(channel)).toEqual([]);
    expect(lastReport(herd, taskId)).toBe("Running them");
    expect(store.auditRows("notice")).toMatchObject([
      { data: { kind: "task-ack", level: "board", taskId } },
    ]);
    await turn;
    // The result the owner asked for (through the Herder) is still pushed.
    expect(channel.ofKind("report")).toHaveLength(1);
  });
});

describe("E2E-UNREAD", () => {
  it("the owner's message a task never read goes back to the Herder", async () => {
    const { channel, herd, store, events, owner } = await setup(SLOW);
    const { taskId, turn } = await herd.startTask("mock", dir, "Fix the tests");
    const queued = herd.promptTask(taskId, "Also fix lint");
    const failed = queued.then(
      () => "",
      (e: Error) => e.message,
    );
    await until(() => store.transcript(taskId).some((e) => e.role === "prompt"));
    await herd.endTask(taskId, "the owner closed it");
    await turn.catch(() => {});
    expect(await failed).toBe("the task ended: the owner closed it");
    expect(owner).toEqual([{ text: "Also fix lint", images: [] }]);
    expect(events.filter((e) => e.kind === "unread")).toEqual([
      {
        kind: "unread",
        taskId,
        title: "Fix the tests",
        text: "Also fix lint",
        why: "the owner closed it",
        shown: "none",
      },
    ]);
    expect(texts(channel).filter((t) => t.startsWith("Not delivered"))).toEqual([]);
    expect(store.auditRows("task.unread")).toMatchObject([{ data: { to: "herder" } }]);
  });

  it("the Herder's message a task never read is shown to the owner; a reply opens the task again", async () => {
    const { channel, herd, store, events } = await setup(SLOW);
    const { taskId, turn } = await herd.startTask("mock", dir, "Fix the tests");
    const queued = herd.promptTask(
      taskId,
      "[Message from the Herder, not from the owner]\nAlso update the docs\n\n[Context added by the Herder, for reference]\nThe docs live in docs/.",
      [],
      "herder",
    );
    void queued.catch(() => {});
    await until(() => store.transcript(taskId).some((e) => e.role === "prompt"));
    await herd.endTask(taskId, "the owner closed it");
    await turn.catch(() => {});
    const notice = channel
      .ofKind("text")
      .find((m) => (m.view as TextView).text.startsWith("Not delivered"));
    expect((notice?.view as TextView | undefined)?.text).toBe(
      'Not delivered: the task ended before it read this (the owner closed it).\n"Also update the docs"\nTo go on, reply to this message and the task opens again.',
    );
    expect(events.filter((e) => e.kind === "unread")).toMatchObject([
      { taskId, text: "Also update the docs", why: "the owner closed it" },
    ]);
    expect(events.find((e) => e.kind === "unread")?.shown).toBeUndefined();
    // A reply to that notice goes to the task, which opens again.
    if (notice?.ref === undefined) throw new Error("no notice");
    void channel.reply(notice.ref, "Yes, update the docs");
    await until(() =>
      store
        .transcript(taskId)
        .some((e) => e.role === "prompt" && e.text.includes("update the docs")),
    );
    expect(
      store.transcript(taskId).some((e) => e.role === "prompt" && e.text.includes("Yes, update")),
    ).toBe(true);
  });

  it("without a Herder, the owner's own message comes back to the owner", async () => {
    const { channel, herd, store } = await setup(SLOW, false);
    const { taskId, turn } = await herd.startTask("mock", dir, "Fix the tests");
    void herd.promptTask(taskId, "Also fix lint").catch(() => {});
    await until(() => store.transcript(taskId).some((e) => e.role === "prompt"));
    await herd.endTask(taskId, "the owner closed it");
    await turn.catch(() => {});
    expect(texts(channel).filter((t) => t.startsWith("Not delivered"))).toEqual([
      'Not delivered: the task ended before it read this (the owner closed it).\n"Also fix lint"\nTo go on, reply to this message and the task opens again.',
    ]);
    expect(store.auditRows("task.unread")).toMatchObject([{ data: { to: "owner" } }]);
  });

  it("when AgentHerd itself stops, the owner hears it, not the Herder", async () => {
    const { channel, herd, store, owner } = await setup(SLOW);
    const { taskId, turn } = await herd.startTask("mock", dir, "Fix the tests");
    void turn.catch(() => {});
    void herd.promptTask(taskId, "Also fix lint").catch(() => {});
    await until(() => store.transcript(taskId).some((e) => e.role === "prompt"));
    await herd.stop();
    herds = herds.filter((h) => h !== herd);
    // The Herder is stopping too, so the owner gets the message back, with a reply opening the
    // task after the restart.
    expect(owner).toEqual([]);
    expect(store.auditRows("task.unread")).toMatchObject([{ data: { to: "owner" } }]);
    expect(texts(channel).some((t) => t.startsWith("Not delivered"))).toBe(true);
  });
});
