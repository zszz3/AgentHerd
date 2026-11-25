import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { API_VERSION, type HostApi } from "../src/api.ts";
import { MijiaControl } from "../src/mijia-control.ts";
import type { ControlRequest } from "../src/mijia-control-types.ts";
import { attachMijiaDesktopBridge } from "../src/mijia-desktop-bridge.ts";
import { serveApi, socketPath } from "../src/server.ts";

const urn = "urn:miot-spec-v2:device:light:0000A001:fictional-lamp:1";
const request = {
  kind: "property",
  homeId: "home-a",
  deviceId: "lamp-a",
  siid: 2,
  piid: 3,
  value: true,
} as const;

function fixture(allowFixture = true) {
  let label = "Fictional lamp";
  let holdRead: Promise<void> | undefined;
  let rejectReceipt = false;
  const mutations: ControlRequest[] = [];
  const control = new MijiaControl({
    current: () => ({ session, worker }),
  });
  const session = {};
  const worker = {
    inventory: vi.fn(async () => {
      await holdRead;
      return {
        devices: [
          {
            homeId: "home-a",
            deviceId: "lamp-a",
            urn,
            home: "Fictional home",
            name: label,
            sharedOnly: false,
          },
        ],
        scenes: [],
      };
    }),
    descriptor: vi.fn(async () => {
      return {
        type: urn,
        services: [
          {
            iid: 2,
            description: "Light",
            properties: [
              { iid: 3, description: "Power", format: "bool", access: ["read", "write"] },
            ],
          },
        ],
      };
    }),
    async mutate(input: ControlRequest) {
      mutations.push(input);
      if (rejectReceipt) throw new Error("Fictional lost result");
      return "acknowledged" as const;
    },
    async readProperty() {
      return "FICTITIOUS_TEST_VALUE";
    },
  };
  let receive!: (message: { data: unknown }) => void;
  let challenge: ((id: number, generation: number) => void) | undefined;
  const grant = (id: number, generation: number, granted = true) =>
    receive({ data: { type: "mijia-desktop:authorization", id, generation, granted } });
  const waiting = new Map<number, (reply: { ok: boolean; value?: unknown }) => void>();
  const stop = attachMijiaDesktopBridge(
    {
      on(_event, listener) {
        receive = listener;
      },
      postMessage(message) {
        if (message.type === "mijia-desktop:reply") {
          waiting.get(message.id)?.(message);
          waiting.delete(message.id);
        } else if (message.type === "mijia-desktop:authorize") {
          if (challenge) challenge(message.id, message.generation);
          else grant(message.id, message.generation);
        }
      },
    },
    control,
    () => ({ TEST_PASSWORD: "FICTITIOUS_TEST_VALUE" }),
    allowFixture
      ? (resolved) => resolved.request.kind === "property" && resolved.model === urn
      : undefined,
  );
  let next = 0;
  function send(method: string, args: unknown[] = [], generation = 1) {
    return new Promise<{ ok: boolean; value?: unknown }>((resolve) => {
      const id = ++next;
      waiting.set(id, resolve);
      receive({ data: { type: "mijia-desktop:request", id, generation, method, args } });
    });
  }
  function revoke(generation = 1) {
    receive({ data: { type: "mijia-desktop:revoke", generation } });
  }
  async function prepare(generation = 1) {
    const reply = await send("prepare", [request], generation);
    expect(reply).toMatchObject({ ok: true, value: { preview: { target: label } } });
    return (reply.value as { id: string }).id;
  }
  return {
    send,
    prepare,
    revoke,
    stop,
    grant,
    nextChallenge: () =>
      new Promise<{ id: number; generation: number }>((resolve) => {
        challenge = (id, generation) => resolve({ id, generation });
      }),
    worker,
    mutations,
    setLabel: (value: string) => {
      label = value;
    },
    loseReceipt: () => {
      rejectReceipt = true;
    },
    pauseRead: () => {
      let resume!: () => void;
      holdRead = new Promise<void>((resolve) => {
        resume = resolve;
      });
      return resume;
    },
  };
}

it("never writes for preview or cancel, consumes one confirmation, and omits mismatch text", async () => {
  const f = await fixture();
  const cancelled = await f.prepare();
  expect(f.mutations).toEqual([]);
  expect(await f.send("cancel", [cancelled])).toMatchObject({ ok: true });
  expect((await f.send("confirm", [cancelled])).value).toEqual({
    state: "not-sent",
    reason: "cancelled",
  });
  expect(f.mutations).toEqual([]);
  const id = await f.prepare();
  expect((await f.send("confirm", [id])).value).toEqual({ state: "mismatch" });
  expect((await f.send("confirm", [id])).value).toEqual({ state: "not-sent", reason: "cancelled" });
  expect(f.mutations).toEqual([request]);
  f.stop();
});

it("discards previews whose exact text would change under the shared redactor", async () => {
  const f = await fixture();
  f.setLabel("FICTITIOUS_TEST_VALUE");
  expect(await f.send("prepare", [request])).toEqual({
    type: "mijia-desktop:reply",
    id: 1,
    generation: 1,
    ok: false,
  });
  f.setLabel("Bearer entirely-fictional-value");
  expect(await f.send("prepare", [request])).toMatchObject({ ok: false });
  expect(f.mutations).toEqual([]);
  f.stop();
});

it("fails closed on unmatched commands and a retired renderer generation", async () => {
  const f = await fixture();
  expect(
    await f.send("prepare", [{ ...request, kind: "scene", sceneId: "unreviewed" }]),
  ).toMatchObject({ ok: false });
  const id = await f.prepare();
  const resume = f.pauseRead();
  const crossed = f.send("confirm", [id]);
  f.revoke();
  resume();
  expect(await crossed).toMatchObject({ ok: false });
  expect((await f.send("confirm", [id], 2)).value).toEqual({
    state: "not-sent",
    reason: "cancelled",
  });
  expect(await f.send("prepare", [request], 1)).toMatchObject({ ok: false });
  expect(f.mutations).toEqual([]);
  f.stop();
});

it("revokes a queued confirmation synchronously on shutdown", async () => {
  const f = await fixture();
  const id = await f.prepare();
  const resume = f.pauseRead();
  const pending = f.send("confirm", [id]);
  f.stop();
  resume();
  expect(await pending).toMatchObject({ ok: false });
  expect(await f.send("confirm", [id])).toMatchObject({ ok: false });
  expect(f.mutations).toEqual([]);
});

it("binds one authorization to the current confirmation and drops it on retirement", async () => {
  const f = fixture();
  const first = await f.prepare();
  const firstChallenge = f.nextChallenge();
  const firstReply = f.send("confirm", [first]);
  const retired = await firstChallenge;
  f.revoke();
  expect(await firstReply).toMatchObject({ ok: false });

  const second = await f.prepare(2);
  const secondChallenge = f.nextChallenge();
  const secondReply = f.send("confirm", [second], 2);
  const current = await secondChallenge;
  f.grant(retired.id, retired.generation);
  f.grant(retired.id, current.generation);
  f.grant(current.id, retired.generation);
  // An explicit denial of the current pair must still settle it without dispatch.
  f.grant(current.id, current.generation, false);
  expect((await secondReply).value).toEqual({ state: "not-sent", reason: "cancelled" });
  expect(f.mutations).toEqual([]);
  f.stop();
});

it("drops a pending authorization on shutdown even if its reply arrives later", async () => {
  const f = fixture();
  const id = await f.prepare();
  const challenge = f.nextChallenge();
  const pending = f.send("confirm", [id]);
  const { id: requestId, generation } = await challenge;
  f.stop();
  f.grant(requestId, generation);
  expect(await pending).toMatchObject({ ok: false });
  expect(f.mutations).toEqual([]);
});

it("keeps control discovery off the worker when there is no eligibility policy", async () => {
  const f = fixture(false);
  try {
    const inventory = await f.send("inventory");
    const capabilities = await f.send("capabilities", ["home-a", "lamp-a"]);
    const proposal = await f.send("prepare", [request]);
    expect(f.worker.inventory).not.toHaveBeenCalled();
    expect(f.worker.descriptor).not.toHaveBeenCalled();
    expect(inventory).toMatchObject({ ok: true, value: { devices: [], scenes: [] } });
    expect(capabilities).toMatchObject({ ok: true, value: { urn: "", services: [] } });
    expect(proposal).toMatchObject({ ok: false });
    expect(f.mutations).toEqual([]);
  } finally {
    f.stop();
  }
});

it("does not register the private control on the public API", async () => {
  const home = mkdtempSync(join(tmpdir(), "mijia-api-"));
  const api = { onEvent: () => () => {} } as HostApi & { onEvent(): () => void };
  try {
    const server = await serveApi(api, socketPath(home));
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = createConnection(server.path);
        socket.setTimeout(2000, () => socket.destroy(new Error("Fixture timed out")));
        socket.once("error", reject);
        socket.once("connect", () =>
          socket.write(
            `${JSON.stringify({ type: "call", v: API_VERSION, id: 1, method: "mijia-desktop:confirm", params: [] })}\n`,
          ),
        );
        socket.once("data", (data: Buffer) => {
          socket.destroy();
          resolve(data.toString());
        });
      });
      expect(JSON.parse(reply)).toMatchObject({
        ok: false,
        error: 'unknown method "mijia-desktop:confirm"',
      });
    } finally {
      await server.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("reports receipt loss as unknown without replay", async () => {
  const f = await fixture();
  const id = await f.prepare();
  f.loseReceipt();
  expect((await f.send("confirm", [id])).value).toEqual({ state: "unknown" });
  expect((await f.send("confirm", [id])).value).toEqual({ state: "not-sent", reason: "cancelled" });
  expect(f.mutations).toEqual([request]);
  f.stop();
});
