import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  acquireLocationLease,
  readLocationRecord,
  writeLocationRecord,
  writeLocationRequest,
} from "@agentherd/host/data-location";
import { applyLocationRequest } from "@agentherd/host/location-apply";
import { afterEach, expect, test, vi } from "vitest";
import { changeConfirmation, DataDirectory } from "../src/main/data-directory.ts";

const roots: string[] = [];
const controllers: DataDirectory[] = [];
afterEach(() => {
  // A failed assertion must not leave a lease that blocks removing the fixture.
  for (const controller of controllers.splice(0)) controller.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(env: NodeJS.ProcessEnv = {}) {
  const base = mkdtempSync(join(homedir(), ".agentherd-desktop-test-"));
  roots.push(base);
  const ctx = { base, env };
  const parent = join(base, "parent");
  mkdirSync(parent);
  const ports = {
    pick: vi.fn<() => Promise<string | undefined>>(async () => undefined),
    confirm: vi.fn<() => Promise<"empty" | "copy" | undefined>>(async () => undefined),
    confirmPrevious: vi.fn(async () => true),
    restart: vi.fn(),
    ready: vi.fn(),
    changed: vi.fn(),
    checkParent: vi.fn(async () => join(parent, "AgentHerd")),
    apply: vi.fn((progress: (files: number) => void) => applyLocationRequest(ctx, progress)),
  };
  const controller = new DataDirectory(ctx, ports);
  controllers.push(controller);
  return {
    ctx,
    parent,
    ports,
    controller,
    save(active: string, previous?: string, retained: string[] = []) {
      const lease = acquireLocationLease(base, "exclusive");
      try {
        writeLocationRecord(
          ctx,
          { version: 1, active, ...(previous ? { previous } : {}), retained },
          lease,
        );
      } finally {
        lease.release();
      }
    },
  };
}

test("cancel changes nothing; override does not open the picker", async () => {
  const a = fixture();
  await a.controller.start();
  expect(await a.controller.change()).toEqual({ ok: true, state: "cancelled" });
  expect(a.ports.restart).not.toHaveBeenCalled();
  expect(readdirSync(a.ctx.base)).not.toContain(".agentherd-location-request.json");
  a.controller.close();
  const b = fixture({ AGENTHERD_HOME: a.parent });
  await b.controller.start();
  expect(b.controller.status()).toMatchObject({ state: "override", canCopy: false });
  expect(await b.controller.change()).toEqual({ ok: false, code: "env-override" });
  expect(b.ports.pick).not.toHaveBeenCalled();
  b.controller.close();
});

test("hides copy with worktrees and requests a restart only after confirmation", async () => {
  const { ctx, parent, ports, controller } = fixture();
  const home = join(ctx.base, ".agentherd");
  mkdirSync(join(home, "worktrees", "in-use"), { recursive: true });
  await controller.start();
  ports.pick.mockResolvedValue(parent);
  expect(await controller.change()).toEqual({ ok: true, state: "cancelled" });
  expect(ports.confirm).toHaveBeenCalledWith(home, join(parent, "AgentHerd"), false);
  ports.confirm.mockResolvedValue("empty");
  ports.restart.mockImplementation(() =>
    expect(readdirSync(ctx.base)).toContain(".agentherd-location-request.json"),
  );
  expect(await controller.change()).toEqual({ ok: true, state: "restarting" });
  expect(ports.restart).toHaveBeenCalledOnce();
  controller.close();
});

test("publishes moving progress before starting host, and failed apply runs on old home", async () => {
  const { ctx, ports, controller } = fixture();
  ports.apply.mockImplementation(async (progress) => {
    expect(controller.status().state).toBe("moving");
    expect(ports.ready).not.toHaveBeenCalled();
    progress(7);
    return { kind: "failed", code: "copy-failed" };
  });
  await controller.start();
  expect(ports.changed).toHaveBeenCalledWith(7);
  expect(controller.status()).toMatchObject({ state: "failed", failure: "copy-failed" });
  expect(ports.ready).toHaveBeenCalledWith(join(ctx.base, ".agentherd"));
  controller.close();
});

test.each(["previous", "pick"] as const)(
  "unavailable request does not start a host; %s preserves known roots",
  async (choice) => {
    const { ctx, parent, ports, controller, save } = fixture();
    const active = join(ctx.base, "disconnected");
    const previous = join(ctx.base, "old");
    const retained = join(ctx.base, "retained");
    mkdirSync(previous);
    writeFileSync(join(parent, "herd.db"), "");
    save(active, previous, [retained]);
    writeLocationRequest(ctx, { version: 1, parent, mode: "empty" });
    await controller.start();
    expect(controller.status()).toMatchObject({ state: "unavailable", home: active, previous });
    expect(ports.ready).not.toHaveBeenCalled();
    expect(await controller.recover("retry")).toEqual({ ok: false, code: "location-unavailable" });
    expect(readLocationRecord(ctx)?.active).toBe(active);
    ports.pick.mockResolvedValue(parent);
    const target = choice === "previous" ? previous : parent;
    const before = readdirSync(target);
    expect(await controller.recover(choice)).toEqual({ ok: true, state: "recovered" });
    expect(readLocationRecord(ctx)).toMatchObject({
      active: target,
      retained: expect.arrayContaining([active, retained]),
    });
    expect(readdirSync(target)).toEqual(before);
    expect(ports.ready).toHaveBeenCalledWith(target);
    controller.close();
  },
);

test("pick accepts only an existing AgentHerd directory at its real path", async () => {
  const { ctx, parent, ports, controller } = fixture();
  writeFileSync(join(ctx.base, ".agentherd-location.json"), "not json");
  await controller.start();
  expect(controller.status()).toMatchObject({ state: "unavailable", canCopy: false });
  expect(controller.status().home).toBeUndefined();
  const record = readFileSync(join(ctx.base, ".agentherd-location.json"), "utf8");
  ports.pick.mockResolvedValue(parent);
  expect(await controller.recover("pick")).toEqual({ ok: false, code: "not-agentherd" });
  const link = join(ctx.base, "link");
  writeFileSync(join(parent, "herd.db"), "");
  symlinkSync(parent, link, process.platform === "win32" ? "junction" : "dir");
  ports.pick.mockResolvedValue(link);
  expect(await controller.recover("pick")).toEqual({ ok: false, code: "not-agentherd" });
  expect(readFileSync(join(ctx.base, ".agentherd-location.json"), "utf8")).toBe(record);
  expect(ports.ready).not.toHaveBeenCalled();
  ports.pick.mockResolvedValue(parent);
  expect(await controller.recover("pick")).toEqual({ ok: true, state: "recovered" });
  expect(readLocationRecord(ctx)).toEqual({ version: 1, active: parent, retained: [] });
  controller.close();
});

test("the environment wins over a corrupt record and a pending request", async () => {
  const override = mkdtempSync(join(homedir(), ".agentherd-desktop-env-"));
  roots.push(override);
  const { ctx, parent, ports, controller } = fixture({ AGENTHERD_HOME: override });
  writeFileSync(join(ctx.base, ".agentherd-location.json"), "not json");
  writeLocationRequest(ctx, { version: 1, parent, mode: "empty" });
  await controller.start();
  expect(controller.status()).toMatchObject({
    state: "failed",
    failure: "env-override",
    home: override,
    canCopy: false,
  });
  expect(ports.ready).toHaveBeenCalledWith(override);
  expect(readFileSync(join(ctx.base, ".agentherd-location.json"), "utf8")).toBe("not json");
  expect(await controller.change()).toEqual({ ok: false, code: "env-override" });
  expect(ports.pick).not.toHaveBeenCalled();
  controller.close();
});

test("the change confirmation names everything the owner must know", () => {
  const copy = changeConfirmation("/old", "/new/AgentHerd", true);
  for (const text of [
    "/old",
    "/new/AgentHerd",
    "运行中的任务",
    "旧目录",
    "旧版 AgentHerd",
    "命令行",
    "没有账号和历史",
  ])
    expect(copy.detail).toContain(text);
  expect(copy.buttons).toEqual(["取消", "使用空目录并重启", "复制并重启"]);
  const blocked = changeConfirmation("/old", "/new/AgentHerd", false);
  expect(blocked.detail).toContain("worktrees");
  expect(blocked.buttons).toEqual(["取消", "使用空目录并重启"]);
});
