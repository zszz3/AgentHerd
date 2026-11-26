import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeChannel } from "@agentherd/channel-fake";
import {
  coreTexts,
  FakeClock,
  Herd,
  Inbox,
  type JsonRpcMessage,
  McpGateway,
  Store,
} from "@agentherd/core";
import { Herder } from "@agentherd/herder";
import type { ItemView } from "@agentherd/protocol";
import { afterEach, expect, it, vi } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  streamSimple,
} from "../../herder/test/faux-provider.ts";
import type { MijiaAccount } from "../src/mijia-account.ts";
import { MijiaControl } from "../src/mijia-control.ts";
import type { MijiaControlWorker } from "../src/mijia-control-worker.ts";
import { mijiaTools } from "../src/mijia-tools.ts";
import { PetFeed } from "../src/pet.ts";

const mockAgent = fileURLToPath(new URL("../../mock-agent/bin/mock-agent.ts", import.meta.url));
const tool = "mijia_set_property";
const args = {
  homeId: "fixture-home-id",
  deviceId: "fixture-lamp-id",
  siid: 2,
  piid: 3,
  value: true,
};
const urn = "urn:miot-spec-v2:device:light:0000A001:fixture:1";
const actionInputs = Array.from({ length: 24 }, (_, i) => ({
  iid: i + 10,
  description: `Parameter <${i + 1}> [text](link)`,
  value: `Fixture **value ${i + 1}** <not markup> ${"x".repeat(65)}`,
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(startupFallback = false) {
  const home = mkdtempSync(join(tmpdir(), "agentherd-mijia-approval-"));
  const yaml = join(home, "agent.yaml");
  const { serveMcp, mcpSocketPath, mcpServerFor } = await import("../src/mcp-socket.ts");
  const path = mcpSocketPath(home);
  const channel = new FakeChannel();
  const kept = vi.fn();
  const pet = new PetFeed({ changed: () => {}, keep: kept });
  const clock = new FakeClock();
  const store = Store.open(":memory:");
  const faux = registerFauxProvider();
  const session = {};
  const worker = {
    inventory: vi.fn<MijiaControlWorker["inventory"]>().mockResolvedValue({
      devices: [
        {
          ...args,
          urn,
          home: "Home & family",
          room: "Den",
          name: "Lamp <literal>",
          sharedOnly: false,
        },
      ],
      scenes: [],
    }),
    descriptor: vi.fn<MijiaControlWorker["descriptor"]>().mockResolvedValue({
      type: urn,
      services: [
        {
          iid: 2,
          description: "Light",
          properties: [
            { iid: 3, description: "Power", format: "bool", access: ["read", "write"] },
            ...actionInputs.map(({ iid, description, value }) => ({
              iid,
              description,
              format: "string",
              access: [],
              "value-list": [{ value, description: "[Exact] <choice>" }],
            })),
          ],
          actions: [
            { iid: 5, description: "[Program] <lamp>", in: actionInputs.map(({ iid }) => iid) },
          ],
        },
      ],
    }),
    mutate: vi.fn<MijiaControlWorker["mutate"]>().mockResolvedValue("acknowledged"),
    readProperty: vi.fn<MijiaControlWorker["readProperty"]>().mockResolvedValue(true),
  } satisfies MijiaControlWorker;
  const control = new MijiaControl({
    current: () => ({ session, worker }),
    clock: { wall: () => clock.now().getTime(), monotonic: () => clock.now().getTime() },
  });
  const account = { view: () => ({ state: "connected" }) } as MijiaAccount;
  const scan = new AbortController();
  const route = mijiaTools(account, control, () => scan.signal);
  let token = "";
  let started!: () => void;
  const inPrompt = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  const herd = new Herd({
    home,
    userHome: home,
    channel: pet.wrap(channel),
    binding: { channelId: channel.id, ownerId: "owner", data: {} },
    store,
    clock,
    mode: "auto",
    profiles: [
      {
        id: "mock",
        name: "Mock",
        command: startupFallback
          ? [join(home, "missing-agent")]
          : [process.execPath, mockAgent, "--script", yaml],
        env: {},
        exporter: null,
      },
      {
        id: "fallback",
        name: "Fallback",
        command: [process.execPath, mockAgent, "--script", yaml],
        env: {},
        exporter: null,
      },
    ],
    agentModels: {
      list: () => [
        { ref: "test/default", agents: ["mock"] },
        { ref: "test/fallback", agents: ["fallback"] },
      ],
      launchFor: () => ({ env: {} }),
      check: async () => ({ ok: true }),
      next: async () => ({ profileId: "fallback", model: "test/fallback" }),
    },
    apps: () => route,
    herder: (host) =>
      new Herder({ host, model: faux.getModel(), streamFn: streamSimple, sleep: async () => {} }),
    mcpServer: (t) => {
      token = t;
      return mcpServerFor(path, t);
    },
  });
  // The real ACP prompt calls herd_ack through this fixture relay, then waits for stdin reply.
  // A local named pipe keeps it active without timing or production credentials.
  const socket = await serveMcp(path, async (t, request) => {
    if (request.id !== "fixture-control" && request.method === "tools/call") {
      started();
      await pause;
    }
    return herd.mcp(t, request);
  });
  cleanups.push(async () => {
    release();
    await herd.stop();
    await socket.close();
    faux.unregister();
    rmSync(home, { recursive: true, force: true });
  });
  writeFileSync(
    yaml,
    "turns:\n  - - mcp_call:\n        tool: herd_ack\n        arguments: {text: Checking}\n    - end_turn: end_turn\n",
  );
  await herd.start();
  const call = (name = tool, input: unknown = args) =>
    new Promise<JsonRpcMessage>((resolve, reject) => {
      const client = createConnection(path, () => {
        const request = {
          jsonrpc: "2.0",
          id: "fixture-control",
          method: "tools/call",
          params: { name, arguments: input },
        };
        client.write(`${JSON.stringify({ token })}\n${JSON.stringify(request)}\n`);
      }).setEncoding("utf8");
      let line = "";
      client.on("data", (chunk: string) => {
        line += chunk;
        const newline = line.indexOf("\n");
        if (newline < 0) return;
        try {
          resolve(JSON.parse(line.slice(0, newline)) as JsonRpcMessage);
        } catch (error) {
          reject(error);
        } finally {
          client.destroy();
        }
      });
      client.once("error", reject);
      client.once("close", () =>
        reject(new Error("Fixture MCP connection closed without an answer")),
      );
    });
  const ask = async (native: boolean) => {
    const words = `In ${home}, turn on the lamp.`;
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("session_start", {
            name: "Lamp",
            project: home,
            profile: "mock",
            ownerText: words,
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Started."),
    ]);
    if (native) await channel.say(words);
    else await herd.handle({ kind: "message", nativeText: true, from: "owner", text: words });
    await inPrompt;
  };
  const card = async (pending: ReturnType<typeof call>) =>
    (
      await Promise.race([
        channel.waitFor(({ view }) => view.kind === "item" && view.final === undefined),
        pending.then((value) => {
          throw new Error(
            `Tool returned before its exact owner card: ${JSON.stringify(value?.result)}`,
          );
        }),
      ])
    ).view as ItemView;
  const rule = (action: "allow" | "deny") =>
    herd.addRule({
      id: action,
      action,
      match: { toolKind: "app", command: tool },
      createdAt: "2026-11-25T00:00:00Z",
      createdBy: "owner",
    });
  return {
    home,
    herd,
    store,
    worker,
    channel,
    clock,
    ask,
    call,
    card,
    rule,
    release,
    scan,
    inPrompt,
    pet,
    kept,
  };
}

it("requires a live native owner task and a bound-owner click on the exact card", async () => {
  const { herd, store, worker, channel, ask, call, card, rule, pet, kept } = await setup();
  await ask(true);
  rule("allow");
  const pending = call();
  const view = await card(pending);
  expect(view).toMatchObject({ exactApproval: expect.stringContaining("Lamp <literal>") });
  expect(view.exactApproval).toContain("Home & family");
  expect(view.exactApproval).toContain("Power");
  expect(view.exactApproval).toContain("true");
  expect(store.getItem(view.itemId)).toMatchObject({ body: "", toolCall: { command: tool } });
  const persisted = JSON.stringify([store.getItem(view.itemId), store.auditRows()]);
  for (const secret of [args.homeId, args.deviceId, "Lamp <literal>", "Home & family"]) {
    expect(persisted).not.toContain(secret);
  }
  expect(pet.pending()).not.toContainEqual(expect.objectContaining({ target: view.itemId }));
  expect(JSON.stringify(kept.mock.calls)).not.toContain("Lamp <literal>");
  await pet.say("allow all");
  await channel.tap(view.itemId, "allow", "other");
  await channel.tap(view.itemId, "allow-all");
  await channel.say("allow all");
  await herd.handle({ kind: "action", from: "owner", action: "allow", target: view.itemId });
  expect(worker.mutate).not.toHaveBeenCalled();
  worker.mutate.mockImplementationOnce(async () => {
    expect(store.getItem(view.itemId)?.state).toBe("decided");
    expect(store.decisionsFor(view.itemId)).toEqual([expect.objectContaining({ action: "allow" })]);
    expect(store.auditRows("app.exact-approval")).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ result: "allow" }) }),
    ]);
    return "acknowledged";
  });
  await channel.tap(view.itemId, "allow");
  expect((await pending)?.result).not.toMatchObject({ isError: true });
  expect(worker.mutate.mock.calls).toEqual([[{ kind: "property", ...args }]]);
  await channel.tap(view.itemId, "allow");
  expect(worker.mutate).toHaveBeenCalledTimes(1);
});

it.each(["insertDecision", "updateItem", "audit"] as const)(
  "closes and rolls back the exact approval when %s fails",
  async (method) => {
    const { ask, call, card, channel, store, worker } = await setup();
    await ask(true);
    const pending = call();
    const view = await card(pending);
    const failure = "fixture storage unavailable";
    const write = vi.spyOn(store, method).mockImplementationOnce(() => {
      throw new Error(failure);
    });
    try {
      await channel.tap(view.itemId, "allow");
      const response = JSON.stringify((await pending)?.result);
      expect(response).toContain("not-sent");
      expect(response).not.toContain(failure);
      const finalized = await channel.waitFor(
        ({ view: next }) =>
          next.kind === "item" && next.itemId === view.itemId && next.final !== undefined,
      );
      expect(finalized.view).toMatchObject({ options: [], final: expect.any(String) });
      const texts = coreTexts("zh-CN");
      expect(finalized.view).not.toMatchObject({ final: texts.allowedByYou });
      expect(finalized.view).not.toMatchObject({ final: coreTexts("en").allowedByYou });
      expect(write).toHaveBeenCalled();
      expect(store.getItem(view.itemId)?.state).toBe("open");
      expect(store.decisionsFor(view.itemId)).toEqual([]);
      expect(store.auditRows("app.exact-approval")).toEqual([]);
      await channel.tap(view.itemId, "allow");
      expect(worker.mutate).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  },
);

it("reports a read-back mismatch without the fixture read-back value", async () => {
  const { ask, call, card, channel, store, worker } = await setup();
  await ask(true);
  const readBack = "fixture read-back";
  worker.readProperty.mockResolvedValueOnce(readBack);
  const pending = call();
  const view = await card(pending);
  await channel.tap(view.itemId, "allow");
  expect((await pending)?.result).toEqual({
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ state: "mismatch" }) }],
  });
  expect(JSON.stringify(store.auditRows())).not.toContain(readBack);
});

it("activates the live owner attempt on the first ACP prompt after a startup fallback", async () => {
  const begin = vi.spyOn(McpGateway.prototype, "beginOwnerAttempt");
  try {
    const { ask, store, worker } = await setup(true);
    await ask(true);
    expect(store.auditRows("task.model-switched")).toHaveLength(1);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(begin.mock.calls[0]?.[1].signal.aborted).toBe(false);
    expect(worker.mutate).not.toHaveBeenCalled();
  } finally {
    begin.mockRestore();
  }
});

it("approves a long action only after its complete literal arguments reach the owner", async () => {
  const { worker, channel, ask, call, card } = await setup();
  await ask(true);
  const input = {
    homeId: args.homeId,
    deviceId: args.deviceId,
    siid: args.siid,
    aiid: 5,
    inputs: actionInputs.map(({ value }) => value),
  };
  const approve = vi.spyOn(Inbox.prototype, "approveExact");
  let view: ItemView;
  const pending = call("mijia_run_action", input);
  try {
    view = await card(pending);
    const preview = approve.mock.calls[0]?.[1];
    expect(preview?.text).toBe(view.exactApproval);
    expect(preview?.source).toHaveLength(4 + 3 * actionInputs.length);
    expect(preview?.source).toEqual(
      expect.arrayContaining([
        "Home & family",
        "Den",
        "Lamp <literal>",
        "Action: Light: [Program] <lamp>",
        ...actionInputs.flatMap(({ description, value }) => [
          description,
          value,
          "[Exact] <choice>",
        ]),
      ]),
    );
  } finally {
    approve.mockRestore();
  }
  expect(view.exactApproval?.length).toBeGreaterThan(3_000);
  expect(view.exactApproval).toContain("[Program] <lamp>");
  for (const { description, value } of actionInputs) {
    expect(view.exactApproval).toContain(
      `${JSON.stringify(description)}: ${JSON.stringify(value)}`,
    );
  }
  expect(worker.mutate).not.toHaveBeenCalled();
  await channel.tap(view.itemId, "allow");
  expect((await pending)?.result).not.toMatchObject({ isError: true });
  expect(worker.mutate.mock.calls).toEqual([[{ kind: "action", ...input }]]);
});

const gate = () => {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
};

it.each(["refusal", "expiry", "disconnect", "deny rule", "task end", "queued prompt"])(
  "does not dispatch after %s",
  async (reason) => {
    const { herd, store, worker, channel, clock, ask, call, card, rule, scan, release } =
      await setup();
    await ask(true);
    const pending = call();
    const view = await card(pending);
    const item = store.getItem(view.itemId);
    if (item === undefined) throw new Error("Missing exact approval item");
    switch (reason) {
      case "refusal":
        await channel.tap(view.itemId, "deny");
        break;
      case "expiry":
        await clock.advance(5 * 60 * 1000);
        break;
      case "disconnect":
        scan.abort();
        break;
      case "deny rule":
        rule("deny");
        await channel.tap(view.itemId, "allow");
        break;
      case "task end":
        release();
        await herd.endTask(item.sessionId, "fixture stop");
        break;
      case "queued prompt":
        void herd.promptTask(item.sessionId, "Follow up").catch(() => {});
        break;
    }
    const response = (await pending)?.result;
    expect(response).toMatchObject({ isError: true });
    expect(JSON.stringify(response).includes("not-sent")).toBe(reason !== "refusal");
    await channel.tap(view.itemId, "allow");
    expect(worker.mutate).not.toHaveBeenCalled();
    expect(
      channel.ofKind("item").find(({ view: card }) => card.itemId === view.itemId)?.view.options,
    ).toEqual([]);
  },
);

it("rejects before the worker reads when a deny rule already applies", async () => {
  const { worker, ask, call, rule, channel } = await setup();
  await ask(true);
  rule("deny");
  expect((await call())?.result).toMatchObject({ isError: true });
  expect(worker.inventory).not.toHaveBeenCalled();
  expect(channel.ofKind("item")).toHaveLength(0);
});

it("rechecks deny policy after the async confirmation refresh", async () => {
  const { worker, ask, call, card, channel, rule } = await setup();
  await ask(true);
  const pending = call();
  const view = await card(pending);
  const entered = gate();
  const refresh = gate();
  const descriptor = await worker.descriptor(urn);
  worker.descriptor.mockImplementationOnce(async () => {
    entered.open();
    await refresh.wait;
    return descriptor;
  });
  await channel.tap(view.itemId, "allow");
  await entered.wait;
  rule("deny");
  refresh.open();
  expect(JSON.stringify((await pending)?.result)).toContain("not-sent");
  expect(worker.mutate).not.toHaveBeenCalled();
});

it("distinguishes unknown after dispatch and never retries", async () => {
  const { worker, ask, call, card, channel } = await setup();
  await ask(true);
  worker.mutate.mockRejectedValueOnce(new Error("fixture lost dispatch response"));
  const pending = call();
  const view = await card(pending);
  await channel.tap(view.itemId, "allow");
  expect(JSON.stringify((await pending)?.result)).toContain("unknown");
  await channel.tap(view.itemId, "allow");
  expect(worker.mutate).toHaveBeenCalledTimes(1);
});

it("releases the call when disconnected during pending preparation", async () => {
  const { worker, channel, ask, call, scan } = await setup();
  await ask(true);
  const inventory = await worker.inventory();
  const entered = gate();
  const read = gate();
  worker.inventory.mockImplementationOnce(async () => {
    entered.open();
    await read.wait;
    return inventory;
  });
  const pending = call();
  await entered.wait;
  cleanups.unshift(async () => {
    read.open();
  });
  scan.abort();
  // Do not finish the read until the socket already has its response.
  expect(await pending).toMatchObject({ result: { isError: true } });
  read.open();
  expect(worker.descriptor).not.toHaveBeenCalled();
  expect(channel.ofKind("item")).toHaveLength(0);
});

it("closes a card whose delivery reference arrives after prompt invalidation", async () => {
  const { herd, store, worker, ask, call, channel } = await setup();
  await ask(true);
  const send = channel.send.bind(channel);
  const delivery = gate();
  vi.spyOn(channel, "send").mockImplementation(async (view) => {
    const ref = await send(view);
    if (view.kind === "item" && view.exactApproval !== undefined) await delivery.wait;
    return ref;
  });
  const pending = call();
  const { view } = await channel.waitFor(
    ({ view }) => view.kind === "item" && view.exactApproval !== undefined,
  );
  if (view.kind !== "item") throw new Error("Expected an item");
  const closed = channel.waitFor(
    ({ view: candidate }) =>
      candidate.kind === "item" &&
      candidate.itemId === view.itemId &&
      candidate.final !== undefined,
  );
  try {
    await channel.tap(view.itemId, "allow"); // The send has not bound its callback reference yet.
    expect(worker.mutate).not.toHaveBeenCalled();
    const item = store.getItem(view.itemId);
    if (item === undefined) throw new Error("Missing exact approval item");
    void herd.promptTask(item.sessionId, "Later turn").catch(() => {});
    expect((await pending)?.result).toMatchObject({ isError: true });
  } finally {
    delivery.open();
  }
  await closed;
  await channel.tap(view.itemId, "allow");
  expect(worker.mutate).not.toHaveBeenCalled();
});

it("does not let a public direct task start grant write provenance", async () => {
  const { home, herd, inPrompt, worker, call } = await setup();
  const { turn } = await herd.startTask("mock", home, "Direct", "Turn on the lamp");
  void turn.catch(() => {});
  await inPrompt;
  expect((await call())?.result).toMatchObject({ isError: true });
  expect(worker.inventory).not.toHaveBeenCalled();
});

it("does not carry provenance past the first real prompt", async () => {
  const { herd, worker, channel, ask, call, release } = await setup();
  await ask(true);
  const [task] = herd.tasks();
  if (task === undefined) throw new Error("Missing task");
  const finished = channel.waitFor(({ view }) => view.kind === "report");
  release();
  await finished;
  expect((await call())?.result).toMatchObject({ isError: true });
  await herd.promptTask(task.id, "Follow up");
  expect((await call())?.result).toMatchObject({ isError: true });
  expect(worker.inventory).not.toHaveBeenCalled();
});

it("does not let socket-style owner input grant task write provenance", async () => {
  const { worker, ask, call } = await setup();
  await ask(false);
  expect((await call())?.result).toMatchObject({ isError: true });
  expect(worker.inventory).not.toHaveBeenCalled();
  expect(worker.mutate).not.toHaveBeenCalled();
});
