import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { FakeChannel } from "@agentherd/channel-fake";
import {
  type Herd,
  type HerderHost,
  McpGateway,
  MIJIA_LIST,
  MIJIA_RUN_ACTION,
  MIJIA_RUN_SCENE,
  MIJIA_SET_PROPERTY,
  MIJIA_STATUS,
  MIJIA_TOOLS,
} from "@agentherd/core";
import { afterEach, expect, it, vi } from "vitest";
import { Apps } from "../src/apps.ts";
import { writeConfig } from "../src/config.ts";
import { Host } from "../src/host.ts";
import { MijiaAccount, type MijiaRuntime } from "../src/mijia-account.ts";
import type { ControlOrigin, MijiaControl } from "../src/mijia-control.ts";
import { mijiaTools } from "../src/mijia-tools.ts";
import { connectHost, serveApi, socketPath } from "../src/server.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const qr = "https://account.xiaomi.com/pass/qr/images?test=fixture";
const png = "data:image/png;base64,iVBORw0KGgo=";
const text = (value: string) => ({ content: [{ type: "text", text: value }] });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "herd-mijia-test-"));
  roots.push(root);
  const close = vi.fn(async () => {});
  const picture = vi.fn(async () => png);
  const list = vi.fn(async () =>
    text(
      JSON.stringify([
        {
          did: "lamp-1",
          name: "Lamp",
          home: "Home",
          room: "Den",
          isOnline: true,
          token: "fixture-secret",
        },
      ]),
    ),
  );
  let session = "";
  let fail = () => {};
  const controlCall = vi.fn(async (_name: string) => ({}));
  const descriptor = vi.fn<(urn: string) => Promise<unknown>>();
  const runtime = {
    picture,
    descriptor,
    open(path, onFailure) {
      session = path;
      fail = onFailure;
      return {
        close,
        async call(name, args) {
          if (name === "login") return text(`Scan\n二维码图片链接: ${qr}`);
          if (name === "login_status") return text("登录成功，已切换为新凭证，可继续调用其他工具");
          if (name === "list_devices") return list();
          if (
            name === "get_device_properties" &&
            JSON.stringify(args) === '{"did":"lamp-1","prop_names":["on","brightness"]}'
          ) {
            return text(
              JSON.stringify({
                on: true,
                brightness: "<读取失败: fixture-secret>",
                token: "fixture-secret",
              }),
            );
          }
          if (name.startsWith("agentherd_")) return controlCall(name);
          throw new Error("fixture-secret");
        },
      };
    },
  } satisfies MijiaRuntime;
  return {
    root,
    close,
    picture,
    list,
    descriptor,
    runtime,
    controlCall,
    path: () => session,
    fail: () => fail(),
  };
}

it.each(["disconnect", "worker failure"])(
  "invalidates the scan before cleanup on %s",
  async (kind) => {
    const f = fixture();
    const invalidated = vi.fn();
    const account = new MijiaAccount(f.root, f.runtime, invalidated);
    const close = deferred();
    f.close.mockImplementationOnce(() => close.promise);
    try {
      await account.start();
      expect(account.controlSession()).toBeUndefined();
      await account.poll();
      const first = account.controlSession();
      if (!first) throw new Error("Missing scan identity");
      expect(account.controlSession()?.session).toBe(first.session);
      expect(account.controlWorker()).toBe(first.worker);
      if (kind === "worker failure") {
        f.fail();
        expect(invalidated).toHaveBeenCalledOnce();
        expect(account.controlSession()).toBeUndefined();
      }
      const cleanup = account.disconnect();
      expect(invalidated).toHaveBeenCalledOnce();
      expect(account.controlSession()).toBeUndefined();
      expect(f.close).toHaveBeenCalledOnce();
      expect(invalidated.mock.invocationCallOrder[0]).toBeLessThan(
        f.close.mock.invocationCallOrder[0],
      );
      await expect(first.worker.inventory()).rejects.toThrow("Mi Home control data unavailable");
      expect(f.controlCall).not.toHaveBeenCalled();
      close.resolve();
      await cleanup;
      await account.start();
      await account.poll();
      expect(account.controlSession()?.session).not.toBe(first.session);
      await expect(first.worker.inventory()).rejects.toThrow("Mi Home control data unavailable");
    } finally {
      close.resolve();
      await account.disconnect();
    }
  },
);

it("retires Mi Home controls and cleans up the scan while Host shutdown waits for DingTalk", async () => {
  const f = fixture();
  f.controlCall.mockImplementation(async (name) => {
    if (name !== "agentherd_inventory") throw new Error("Unexpected mutation");
    return {
      structuredContent: {
        result: JSON.stringify({
          devices: [],
          scenes: [{ homeId: "home-1", sceneId: "scene-1", name: "Night", home: "Home" }],
        }),
      },
    };
  });
  const resetEntered = deferred();
  const finishReset = deferred();
  const log = vi.fn();
  const host = new Host({
    log,
    home: f.root,
    userHome: f.root,
    env: {},
    secrets: { get: () => undefined, set: () => {}, delete: () => {} },
    createChannel: () => new FakeChannel(),
    profiles: () => [],
    mijiaRuntime: f.runtime,
    dingTalkCli: {
      status: async () => undefined,
      login: async () => {},
      markResetPending: async () => {},
      async reset() {
        resetEntered.resolve();
        await finishReset.promise;
      },
      run: async () => undefined,
    },
  });
  const { mijiaControl: control } = host as unknown as { mijiaControl: MijiaControl };
  const origin: ControlOrigin = { kind: "desktop", key: {} };
  const request = { kind: "scene", homeId: "home-1", sceneId: "scene-1" };
  let resetting: Promise<unknown> | undefined;
  let stopping: Promise<void> | undefined;
  let stopped = false;
  try {
    await host.startMijiaLogin();
    const authPath = f.path();
    const attemptDir = dirname(authPath);
    writeFileSync(authPath, "inert Mi Home fixture");
    await host.pollMijiaLogin();
    const proposal = await control.prepare(origin, request);
    resetting = host.disconnectDingTalk();
    await resetEntered.promise;
    expect(existsSync(authPath)).toBe(true);
    stopping = host.stop().then(() => {
      stopped = true;
    });
    await expect(control.prepare(origin, request)).rejects.toThrow("Mi Home control unavailable");
    expect(await control.confirm(origin, proposal.id)).toEqual({
      state: "not-sent",
      reason: "cancelled",
    });
    expect(f.controlCall.mock.calls).toEqual([["agentherd_inventory"]]);
    expect(log.mock.calls).toContainEqual([
      `Mi Home control ${proposal.id} scene not-sent cancelled`,
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/home-1|scene-1|Night|fixture-secret/);

    // Drain the fake close and its cleanup continuations without releasing the reset.
    await setImmediate();
    expect(stopped).toBe(false);
    expect(f.close).toHaveBeenCalledOnce();
    expect(existsSync(authPath)).toBe(false);
    expect(existsSync(attemptDir)).toBe(false);
  } finally {
    finishReset.resolve();
    await resetting;
    await (stopping ?? host.stop());
  }
});

it("reads a public control descriptor through the bound Host and never uses a stale scan", async () => {
  const f = fixture();
  const account = new MijiaAccount(f.root, f.runtime);
  const urn = "urn:miot-spec-v2:device:light:0000A001:fixture:1";
  const service = {
    iid: 2,
    description: "Light",
    properties: [
      {
        iid: 3,
        description: "Level",
        format: "float",
        access: ["read", "write"],
        "value-range": [0, 1e20, 1e18],
      },
    ],
    actions: [],
  };
  try {
    await account.start();
    await account.poll();
    const worker = account.controlWorker();
    if (!worker) throw new Error("Missing control worker");
    f.descriptor.mockResolvedValueOnce({
      type: urn,
      token: "never expose",
      services: [{ ...service, token: "never expose" }],
    });
    await expect(worker.descriptor(urn)).resolves.toEqual({ type: urn, services: [service] });
    f.descriptor.mockResolvedValueOnce({ type: `${urn}:different`, services: [service] });
    await expect(worker.descriptor(urn)).rejects.toThrow("Mi Home control data unavailable");
    let resolve!: (value: unknown) => void;
    f.descriptor.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = expect(worker.descriptor(urn)).rejects.toThrow(
      "Mi Home control data unavailable",
    );
    await account.disconnect();
    await account.start();
    await account.poll();
    resolve({ type: urn, services: [service] });
    await pending;
    await expect(worker.descriptor(urn)).rejects.toThrow("Mi Home control data unavailable");
    expect(f.descriptor.mock.calls).toEqual([[urn], [urn], [urn]]);
  } finally {
    await account.disconnect();
  }
});

it("completes a scan on the same worker and exposes safe read-only tools until disconnect", async () => {
  const f = fixture();
  const account = new MijiaAccount(f.root, f.runtime);
  const apps = mijiaTools(account);
  expect(await apps.list()).toEqual([]);
  expect(await account.start()).toEqual({ state: "waiting", qrDataUrl: png });
  expect(f.picture).toHaveBeenCalledWith(qr);
  writeFileSync(f.path(), "fixture-secret");
  expect(await account.poll()).toEqual({ state: "connected" });
  expect((await apps.list()).map((t) => t.name)).toEqual([
    "mijia_list_devices",
    "mijia_get_device_status",
  ]);
  expect(
    (await apps.describe(["mijia_list_devices"])).get("mijia_list_devices")?.hints?.readOnly,
  ).toBe(true);
  expect(await account.devices()).toEqual([
    { id: "lamp-1", name: "Lamp", home: "Home", room: "Den", online: true },
  ]);
  expect(
    await apps.call("mijia_get_device_status", { id: "lamp-1", properties: ["on", "brightness"] }),
  ).toEqual(text(JSON.stringify({ values: { on: true }, unavailable: ["brightness"] })));
  await expect(
    apps.call("mijia_get_device_status", { id: "lamp-1", properties: ["token"] }),
  ).rejects.toThrow();
  await expect(apps.call("mijia_list_devices", { home_id: "other" })).rejects.toThrow();
  await expect(apps.call("set_device_property", {})).rejects.toThrow();
  expect(await account.disconnect()).toEqual({ state: "disconnected" });
  expect(f.close).toHaveBeenCalledOnce();
  expect(existsSync(f.path())).toBe(false);
  expect(await apps.list()).toEqual([]);
});

it("rejects a queued read after the owner replaces its login session", async () => {
  const f = fixture();
  const account = new MijiaAccount(f.root, f.runtime);
  const approve = vi.fn<() => Promise<boolean>>();
  let release = (_allowed: boolean) => {};
  approve.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const gateway = new McpGateway(() => {}, { apps: () => mijiaTools(account), approve });
  const token = gateway.register("task");
  const read = () =>
    gateway.handle(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "mijia_list_devices", arguments: {} },
    });
  try {
    await account.start();
    await account.poll();
    const pending = read();
    await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
    await account.disconnect();
    await account.start();
    await account.poll();
    release(true);
    expect(await pending).toMatchObject({ result: { isError: true } });
    expect(f.list).not.toHaveBeenCalled();
  } finally {
    release(false);
    await account.disconnect();
  }
});

it.each([false, true])(
  "never forwards Mi Home calls to the remote catalog (batch=%s)",
  async (batch) => {
    const describe = vi.fn(async () => new Map());
    const call = vi.fn(async () => ({}));
    const approve = vi.fn(async () => true);
    const gateway = new McpGateway(() => {}, {
      apps: () => ({ list: async () => [], describe, call }),
      approve,
    });
    const tool = "mijia_get_device_status";
    const args = { id: "lamp-1", properties: ["on"] };
    const reply = await gateway.handle(gateway.register("task"), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: batch
        ? {
            name: "COMPOSIO_MULTI_EXECUTE_TOOL",
            arguments: {
              tools: [
                { tool_slug: "GITHUB_LIST_REPOSITORIES", arguments: {} },
                { tool_slug: tool, arguments: args },
              ],
            },
          }
        : { name: tool, arguments: args },
    });
    expect(reply?.result).toMatchObject({ isError: true });
    expect(describe).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
  },
);

it("blocks a new scan until the failed cleanup is retried", async () => {
  const f = fixture();
  const account = new MijiaAccount(f.root, f.runtime);
  await account.start();
  await account.poll();
  const originalPath = f.path();
  writeFileSync(originalPath, "fixture-secret");
  f.close.mockRejectedValueOnce(new Error("fixture-secret"));
  expect(await account.disconnect()).toEqual({ state: "cleanup-required" });
  expect(existsSync(originalPath)).toBe(true);
  expect(await account.start()).toEqual({ state: "cleanup-required" });
  expect(f.path()).toBe(originalPath);
  expect(await account.disconnect()).toEqual({ state: "disconnected" });
  expect(existsSync(originalPath)).toBe(false);
  expect(await account.start()).toEqual({ state: "waiting", qrDataUrl: png });
  await account.cancel();
});

it("cancels an in-flight fetch and discards late scan results and credentials", async () => {
  const f = fixture();
  let resolve: (value: string) => void = () => {};
  f.picture.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const account = new MijiaAccount(f.root, f.runtime);
  const started = account.start();
  await vi.waitFor(() => expect(f.picture).toHaveBeenCalledOnce());
  writeFileSync(f.path(), "fixture-secret");
  expect(await account.cancel()).toEqual({ state: "disconnected" });
  resolve(png);
  expect(await started).toEqual({ state: "disconnected" });
  expect(existsSync(f.path())).toBe(false);
});

it("does not fetch a substituted image host or pass upstream errors to the owner", async () => {
  const f = fixture();
  f.runtime.open = () => ({
    close: f.close,
    call: async () =>
      text(`二维码图片链接: https://account.xiaomi.com.example.org/pass/qr/fixture-secret`),
  });
  const account = new MijiaAccount(f.root, f.runtime);
  const state = await account.start();
  expect(state.state).toBe("error");
  expect(JSON.stringify(state)).not.toContain("fixture-secret");
  expect(f.picture).not.toHaveBeenCalled();
});

it("E2E-MIJIA: the production Host connects, exposes only reads, and reserves control tool names", async () => {
  const f = fixture();
  const alternate = {
    list: vi.fn(async () =>
      ["fixture_other_read", ...MIJIA_TOOLS].map((name) => ({
        name,
        description: "Inert alternate tool",
        inputSchema: { type: "object" },
      })),
    ),
    describe: vi.fn(async () => new Map()),
    preflight: vi.fn(async () => undefined),
    call: vi.fn(async () => text("fixture alternate result")),
  };
  writeConfig(f.root, { channel: { channelId: "fake", ownerId: "owner", data: {} } });
  const host = new Host({
    home: f.root,
    userHome: f.root,
    env: {},
    secrets: { get: () => undefined, set: () => {}, delete: () => {} },
    createChannel: () => new FakeChannel(),
    profiles: () => [],
    mcpSocket: socketPath(f.root),
    mijiaRuntime: f.runtime,
  });
  await host.start();
  const source = vi.spyOn(Apps.prototype, "appTools").mockReturnValue(alternate);
  try {
    const herd = (host as unknown as { herd: Herd }).herd;
    // Use the gateway assembled by Host, with an inert first-prompt attempt and no agent process.
    const { mcp } = (herd as unknown as { ctx: { mcp: McpGateway } }).ctx;
    const taskId = "fixture-task";
    const token = mcp.register(taskId);
    const request = (method: string, params?: Record<string, unknown>) =>
      host.mcp(token, {
        jsonrpc: "2.0",
        id: 1,
        method,
        ...(params === undefined ? {} : { params }),
      });
    const call = async (name: string, args: Record<string, unknown>) =>
      (await request("tools/call", { name, arguments: args }))?.result;
    const discover = async () => {
      const reply = await request("tools/list");
      if (!reply?.result) throw new Error("Missing tools/list result");
      return (reply.result as { tools: { name: string }[] }).tools.map(({ name }) => name);
    };
    let port: HerderHost | undefined;
    await herd.setHerder((h) => {
      port = h;
      return {
        ownerMessage: () => {},
        ownerAnswer: () => {},
        event: () => {},
        stop: async () => {},
      };
    });
    expect(port?.apps?.()).not.toContain("米家");
    const server = await serveApi(host, socketPath(f.root));
    try {
      const client = await connectHost(server.path);
      try {
        const remote = client.host;
        for (const method of ["mijiaControl", "prepare", "confirm", "cancel", "revoke"])
          expect(remote).not.toHaveProperty(method);
        expect(await remote.mijia()).toEqual({ state: "disconnected" });
        const disconnected = await discover();
        expect(disconnected).toContain("fixture_other_read");
        expect(disconnected.filter((name) => MIJIA_TOOLS.includes(name))).toEqual([]);
        expect(await remote.startMijiaLogin()).toEqual({ state: "waiting", qrDataUrl: png });
        expect(await remote.cancelMijiaLogin()).toEqual({ state: "disconnected" });
        expect(await remote.startMijiaLogin()).toEqual({ state: "waiting", qrDataUrl: png });
        expect(await remote.pollMijiaLogin()).toEqual({ state: "connected" });
        expect(port?.apps?.()).toContain("米家");
        const devices = [{ id: "lamp-1", name: "Lamp", home: "Home", room: "Den", online: true }];
        expect(await remote.mijiaDevices()).toEqual(devices);
        expect((await discover()).filter((name) => MIJIA_TOOLS.includes(name))).toEqual([
          MIJIA_LIST,
          MIJIA_STATUS,
        ]);
        expect(await call(MIJIA_LIST, {})).toEqual(text(JSON.stringify(devices)));
        expect(
          await call(MIJIA_STATUS, { id: "lamp-1", properties: ["on", "brightness"] }),
        ).toEqual(text(JSON.stringify({ values: { on: true }, unavailable: ["brightness"] })));

        const endAttempt = mcp.beginOwnerAttempt(taskId, new AbortController());
        try {
          const target = { homeId: "fixture-home", deviceId: "lamp-1", siid: 2 };
          for (const [name, args] of [
            [MIJIA_SET_PROPERTY, { ...target, piid: 1, value: true }],
            [MIJIA_RUN_ACTION, { ...target, aiid: 1, inputs: [] }],
            [MIJIA_RUN_SCENE, { homeId: target.homeId, sceneId: "fixture-scene" }],
          ] as const) {
            expect(await call(name, args)).toEqual({
              ...text(JSON.stringify({ state: "not-sent", reason: "blocked" })),
              isError: true,
            });
          }
        } finally {
          endAttempt();
        }
        expect(alternate.list).toHaveBeenCalled();
        expect(alternate.describe).not.toHaveBeenCalled();
        expect(alternate.preflight).not.toHaveBeenCalled();
        expect(alternate.call).not.toHaveBeenCalled();
        expect(f.controlCall).not.toHaveBeenCalled();
        expect(f.descriptor).not.toHaveBeenCalled();

        writeFileSync(f.path(), "fixture-secret");
        expect(await remote.disconnectMijia()).toEqual({ state: "disconnected" });
        expect(existsSync(f.path())).toBe(false);
        await expect(remote.mijiaDevices()).rejects.toThrow("无法读取米家设备");
      } finally {
        client.close();
      }
    } finally {
      await server.close();
    }
  } finally {
    source.mockRestore();
    await host.stop();
  }
});
