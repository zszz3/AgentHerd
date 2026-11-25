import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { MijiaAccount, type MijiaRuntime } from "../src/mijia-account.ts";
import type { ControlRequest } from "../src/mijia-control-types.ts";
import { parseMijiaSpec } from "../src/mijia-schema.ts";

const light = {
  kind: "property",
  homeId: "home-a",
  deviceId: "light-a",
  siid: 2,
  piid: 3,
  value: 40,
} satisfies ControlRequest;
const urn = "urn:miot-spec-v2:device:light:0000A001:fixture:1";
const reply = (result: unknown) => ({ structuredContent: { result: JSON.stringify(result) } });
const text = (text: string) => ({ content: [{ type: "text", text }] });

function accountFixture() {
  const dir = mkdtempSync(join(tmpdir(), "mijia-worker-test-"));
  const control = vi.fn<(name: string, args: Record<string, unknown>) => Promise<unknown>>();
  const call = vi.fn<ReturnType<MijiaRuntime["open"]>["call"]>();
  call.mockImplementation(async (name, args) => {
    if (name === "login") return text("二维码图片链接: https://account.xiaomi.com/pass/qr/fixture");
    if (name === "login_status") return text("登录成功，已切换为新凭证，可继续调用其他工具");
    return control(name, args);
  });
  const descriptor = vi.fn<(urn: string) => Promise<unknown>>();
  const runtime = {
    open: vi.fn(() => ({ call, close: async () => {} })),
    picture: async () => "data:image/png;base64,fixture",
    descriptor,
  } satisfies MijiaRuntime;
  const account = new MijiaAccount(dir, runtime);
  return {
    account,
    control,
    descriptor,
    async dispose() {
      await account.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

it("uses a narrow port bound to only the authenticated account session", async () => {
  const { account, control, dispose } = accountFixture();
  try {
    expect(account.controlWorker()).toBeUndefined();
    await account.start();
    expect(account.controlWorker()).toBeUndefined();
    await account.poll();
    const worker = account.controlWorker();
    expect(worker).toBeDefined();
    if (!worker) throw new Error("Missing control worker");
    expect(Object.keys(worker).sort()).toEqual([
      "descriptor",
      "inventory",
      "mutate",
      "readProperty",
    ]);
    control.mockResolvedValue(reply("acknowledged"));
    expect(await worker.mutate({ ...light, url: "not-an-option" } as ControlRequest)).toBe(
      "acknowledged",
    );
    expect(control).toHaveBeenLastCalledWith("agentherd_set_property", {
      did: "light-a",
      siid: 2,
      piid: 3,
      value: 40,
    });
    expect(
      await worker.mutate({
        kind: "action",
        homeId: "home-a",
        deviceId: "light-a",
        siid: 2,
        aiid: 4,
        inputs: [false, "x"],
      }),
    ).toBe("acknowledged");
    expect(control).toHaveBeenLastCalledWith("agentherd_run_action", {
      did: "light-a",
      siid: 2,
      aiid: 4,
      inputs: [false, "x"],
    });
    expect(await worker.mutate({ kind: "scene", homeId: "home-a", sceneId: "scene-a" })).toBe(
      "acknowledged",
    );
    expect(control).toHaveBeenLastCalledWith("agentherd_run_scene", {
      home_id: "home-a",
      scene_id: "scene-a",
    });
    expect(control).toHaveBeenCalledTimes(3);
    let resolve!: (value: unknown) => void;
    control.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = worker.mutate(light);
    await account.disconnect();
    await account.start();
    await account.poll();
    resolve(reply("acknowledged"));
    await expect(pending).resolves.toBe("unknown");
    await expect(worker.mutate(light)).resolves.toBe("unknown");
    await expect(worker.inventory()).rejects.toThrow();
    expect(control).toHaveBeenCalledTimes(4);
  } finally {
    await dispose();
  }
});

it("consumes only projected records, read scalars, and understood statuses", async () => {
  const { account, control, descriptor, dispose } = accountFixture();
  try {
    await account.start();
    await account.poll();
    const worker = account.controlWorker();
    if (!worker) throw new Error("Missing control worker");
    control.mockResolvedValueOnce(
      reply({
        devices: [
          {
            homeId: "home-a",
            deviceId: "light-a",
            urn,
            home: "Home",
            name: "Light",
            sharedOnly: false,
            token: "raw-sentinel",
          },
        ],
        scenes: [],
      }),
    );
    expect(await worker.inventory()).toEqual({
      devices: [
        {
          homeId: "home-a",
          deviceId: "light-a",
          urn,
          home: "Home",
          name: "Light",
          sharedOnly: false,
        },
      ],
      scenes: [],
    });
    const prop = {
      iid: 3,
      description: "Light",
      format: "uint8",
      access: ["read", "write"],
      "value-range": [0, 100, 1],
    };
    descriptor.mockResolvedValueOnce({
      type: urn,
      token: "raw-sentinel",
      services: [
        {
          iid: 2,
          description: "Light",
          properties: [
            prop,
            { ...prop, iid: 4, "value-unknown": 1 },
            { ...prop, iid: 7, format: "float", "value-range": [0, 1e20, 1e18] },
            {
              iid: 8,
              description: "Preset",
              format: "float",
              access: ["read", "write"],
              "value-list": [{ value: 1e20, description: "Large" }],
            },
          ],
          actions: [
            { iid: 5, description: "No signature" },
            { iid: 6, description: "Signed", in: [] },
          ],
        },
      ],
    });
    const metadata = await worker.descriptor(urn);
    expect(JSON.stringify(metadata)).not.toContain("raw-sentinel");
    expect(parseMijiaSpec(urn, metadata).services[0]).toMatchObject({
      properties: [
        { piid: 3 },
        { piid: 7, range: [0, 1e20, 1e18] },
        { piid: 8, choices: [{ value: 1e20, label: "Large" }] },
      ],
      actions: [{ aiid: 6 }],
    });
    control.mockResolvedValueOnce(reply(false));
    expect(await worker.readProperty(light)).toBe(false);
    expect(control).toHaveBeenLastCalledWith("agentherd_read_property", {
      did: "light-a",
      siid: 2,
      piid: 3,
    });
    control.mockResolvedValueOnce(reply({ code: 0, token: "raw-sentinel" }));
    expect(await worker.mutate(light)).toBe("unknown");
    control.mockRejectedValue(new Error("raw-sentinel"));
    await expect(worker.mutate(light)).resolves.toBe("unknown");
    await expect(worker.readProperty(light)).resolves.toBeUndefined();
    await expect(worker.inventory()).rejects.toThrow(/^Mi Home control data unavailable$/);
  } finally {
    await dispose();
  }
});

const testPython = process.env.AGENTHERD_TEST_MIJIA_PYTHON;
const python = testPython ?? (process.platform === "win32" ? undefined : "python3");
const canRunPythonFixture =
  testPython ||
  (python &&
    spawnSync(python, ["-I", "-B", "-c", "import requests; from pydantic import StrictInt"], {
      timeout: 5_000,
    }).status === 0);

function runPythonFixture(fixtureName: string) {
  if (!python) throw new Error("Missing fixture interpreter");
  const fixture = fileURLToPath(new URL(`fixtures/${fixtureName}`, import.meta.url));
  const worker = fileURLToPath(new URL("../bin/mijia-worker.py", import.meta.url));
  expect(existsSync(worker), "Python adapter must exist").toBe(true);
  const run = spawnSync(python, ["-I", "-B", fixture, worker], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(run.error).toBeUndefined();
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout).toBe("");
}

it.skipIf(!canRunPythonFixture)(
  "projects pinned provider data and dispatches each mutation once after refresh without redirects or retries",
  () => runPythonFixture("mijia-worker-test.py"),
);

it.skipIf(!testPython)("rejects invalid member IDs through the real FastMCP wrapper", () =>
  runPythonFixture("mijia-worker-fastmcp-test.py"),
);
