import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireLocationLease,
  checkWindowsProfile,
  type LocationMode,
} from "../src/location-gate.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});

const actualExecFileSync = (
  await vi.importActual<typeof import("node:child_process")>("node:child_process")
).execFileSync;
const actualOpenSync = (await vi.importActual<typeof import("node:fs")>("node:fs")).openSync;
const gateModule = new URL("../src/location-gate.ts", import.meta.url).href;

function startWorkerAtCreation(root: string) {
  const state = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(
    `
      const { parentPort, workerData: { root, gateModule, state } } = require('node:worker_threads');
      (async () => {
        const { acquireLocationLease } = await import(gateModule);
        Atomics.wait(state, 0, 0, 5000);
        if (Atomics.load(state, 0) !== 1) throw new Error('Gate was not published');
        const lease = acquireLocationLease(root, 'shared');
        parentPort.once('message', () => lease.release());
        Atomics.store(state, 0, 2);
        Atomics.notify(state, 0);
      })().catch((error) => {
        Atomics.store(state, 0, -1);
        Atomics.notify(state, 0);
        throw error;
      });
    `,
    { eval: true, workerData: { root, gateModule, state } },
  );
  let error: Error | undefined;
  worker.on("error", (cause) => {
    error = cause;
  });
  const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
  return {
    acquire() {
      Atomics.store(state, 0, 1);
      Atomics.notify(state, 0);
      Atomics.wait(state, 0, 1, 5_000);
    },
    async release() {
      worker.postMessage("release");
      const code = await exited;
      if (error) throw error;
      expect(code).toBe(0);
    },
    terminate: () => worker.terminate(),
    isHolding: () => Atomics.load(state, 0) === 2,
  };
}

const fixture = fileURLToPath(new URL("./fixtures/location-gate-child.ts", import.meta.url));
const gateName = ".agentherd-location.lock.sqlite";
// Several child launches and Windows ACL checks share one test deadline.
const ipcTimeout = 15_000;
let base: string;
let gate: string;

function startChild(mode: LocationMode) {
  const child = spawn(process.execPath, [fixture, base, mode], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  function waitForMessage<T extends string>(allowed: readonly T[]): Promise<T> {
    return new Promise((resolve, reject) => {
      function clear() {
        child.off("message", receive);
        child.off("error", fail);
        child.off("close", earlyClose);
      }
      function receive(message: unknown) {
        for (const accepted of allowed) {
          if (message !== accepted) continue;
          clear();
          resolve(accepted);
          return;
        }
        fail(new Error(`Expected ${allowed.join(" or ")}; received ${String(message)}`));
      }
      function fail(error: Error) {
        clear();
        reject(error);
      }
      function earlyClose(code: number | null, signal: NodeJS.Signals | null) {
        fail(
          new Error(`Child closed before ${allowed.join(" or ")} (${code ?? signal}): ${stderr}`),
        );
      }
      child.once("message", receive);
      child.once("error", fail);
      child.once("close", earlyClose);
    });
  }
  const ready = waitForMessage(["ready"]);
  children.set(child, closed);
  return {
    ready,
    acquire() {
      const result = waitForMessage(["held", "busy"] as const);
      child.send("acquire");
      return result;
    },
    async release() {
      child.send("release");
      await this.expectExit();
    },
    async expectExit() {
      expect(await closed).toEqual({ code: 0, signal: null });
      expect(stderr).not.toMatch(/Error:/);
    },
    async terminateAndWait() {
      expect(child.kill("SIGKILL")).toBe(true);
      expect(await closed).toEqual({ code: null, signal: "SIGKILL" });
    },
  };
}

const children = new Map<ChildProcess, Promise<unknown>>();

async function holder(mode: LocationMode) {
  const child = startChild(mode);
  await child.ready;
  expect(await child.acquire()).toBe("held");
  return child;
}

async function tryInChild(mode: LocationMode) {
  const child = startChild(mode);
  await child.ready;
  const result = await child.acquire();
  if (result === "held") await child.release();
  else await child.expectExit();
  return result;
}

beforeEach(() => {
  // The Windows TEMP subtree can have different ACLs from the profile root.
  const temp = process.platform === "win32" ? homedir() : tmpdir();
  base = mkdtempSync(join(realpathSync(temp), "agentherd-location-test-"));
  gate = join(base, gateName);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.mocked(execFileSync).mockReset();
  vi.mocked(openSync).mockReset();
  for (const [child, closed] of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
  children.clear();
  rmSync(base, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
});

function prepareGate(sql: string): void {
  writeFileSync(gate, "", { mode: 0o600 });
  const database = new DatabaseSync(gate);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
}

function expectGateFailure(root = base): void {
  expect(() => acquireLocationLease(root, "shared").release()).toThrowError(
    /location gate(?!.*in use)/i,
  );
}

describe("location gate", () => {
  it(
    "admits two readers, but not a switch until even the killed reader has exited",
    async () => {
      const first = await holder("shared");
      const second = await holder("shared");
      expect(() => acquireLocationLease(base, "exclusive")).toThrowError(/in use/);
      await first.release();
      expect(() => acquireLocationLease(base, "exclusive")).toThrowError(/in use/);
      await second.terminateAndWait();
      const switcher = acquireLocationLease(base, "exclusive");
      try {
        expect(await tryInChild("shared")).toBe("busy");
      } finally {
        switcher.release();
      }
      expect(await tryInChild("shared")).toBe("held");
    },
    ipcTimeout,
  );

  it(
    "releases an exclusive lease when the switcher is killed",
    async () => {
      const switcher = await holder("exclusive");
      expect(() => acquireLocationLease(base, "shared")).toThrowError(/in use/);
      await switcher.terminateAndWait();
      expect(await tryInChild("exclusive")).toBe("held");
    },
    ipcTimeout,
  );

  it(
    "does not admit both exclusive contenders on simultaneous first use",
    async () => {
      const first = startChild("exclusive");
      const second = startChild("exclusive");
      await Promise.all([first.ready, second.ready]);
      const results = await Promise.all([first.acquire(), second.acquire()]);
      // With a zero busy timeout, both contenders can see contention during
      // handoff from initialization to the requested lease. Neither can bypass it.
      expect(results.filter((result) => result === "held").length).toBeLessThanOrEqual(1);
      for (const [child, result] of [
        [first, results[0]],
        [second, results[1]],
      ] as const) {
        if (result === "held") await child.release();
        else await child.expectExit();
      }
      expect(await tryInChild("shared")).toBe("held");
    },
    ipcTimeout,
  );

  it.skipIf(process.platform === "win32")(
    "preserves a worker's lease acquired as the gate is first published",
    async () => {
      const worker = startWorkerAtCreation(base);
      // Pause legacy in-process creation after the exclusive open, before close.
      vi.mocked(openSync).mockImplementation((...args) => {
        const fd = actualOpenSync(...args);
        if (args[0] === gate && args[1] === "wx") worker.acquire();
        return fd;
      });
      // The POSIX creator's close now belongs to another PID. Acquiring before
      // returning its result still overlaps the parent-side creation boundary.
      vi.mocked(execFileSync).mockImplementation((file, args, options) => {
        const result = actualExecFileSync(file, args, options);
        if (file === process.execPath && args?.at(-1) === gate) worker.acquire();
        return result;
      });
      try {
        acquireLocationLease(base, "shared").release();
        expect(worker.isHolding()).toBe(true);
        expect(await tryInChild("exclusive")).toBe("busy");
        await worker.release();
        expect(await tryInChild("exclusive")).toBe("held");
      } finally {
        await worker.terminate();
      }
    },
    ipcTimeout,
  );

  it("releases twice safely without replacing the gate file", () => {
    const lease = acquireLocationLease(base, "shared");
    const first = statSync(gate, { bigint: true });
    lease.release();
    const next = acquireLocationLease(base, "exclusive");
    try {
      lease.release();
      expect(next.mode).toBe("exclusive");
      expect(statSync(gate, { bigint: true }).ino).toBe(first.ino);
      expect(() => acquireLocationLease(base, "shared")).toThrowError(/in use/);
    } finally {
      next.release();
    }
  });

  it("initializes an empty regular gate left by interrupted first use", () => {
    writeFileSync(gate, "", { mode: 0o600 });
    acquireLocationLease(base, "shared").release();
    const db = new DatabaseSync(gate);
    try {
      expect(db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
      expect(db.prepare("SELECT id, v FROM location_gate").all()).toEqual([{ id: 1, v: 1 }]);
    } finally {
      db.close();
    }
  });

  it.skipIf(process.platform === "win32")("creates the gate with private mode", () => {
    acquireLocationLease(base, "shared").release();
    expect(statSync(gate).mode & 0o777).toBe(0o600);
  });

  it("leaves a corrupt gate intact", () => {
    const bytes = Buffer.from("not a SQLite gate");
    writeFileSync(gate, bytes, { mode: 0o600 });
    expectGateFailure();
    expect(readFileSync(gate)).toEqual(bytes);
  });

  it.each([
    ["version zero with a schema", "CREATE TABLE unrelated (id INTEGER)"],
    ["version one without a sentinel", "PRAGMA user_version = 1"],
    ["unknown version", "PRAGMA user_version = 2"],
    [
      "wrong sentinel row",
      "CREATE TABLE location_gate (id INTEGER PRIMARY KEY, v INTEGER NOT NULL); INSERT INTO location_gate VALUES (1, 2); PRAGMA user_version = 1",
    ],
    [
      "extra sentinel row",
      "CREATE TABLE location_gate (id INTEGER PRIMARY KEY, v INTEGER NOT NULL); INSERT INTO location_gate VALUES (1, 1), (2, 1); PRAGMA user_version = 1",
    ],
    [
      "view instead of sentinel table",
      "CREATE VIEW location_gate AS SELECT 1 AS id, 1 AS v; PRAGMA user_version = 1",
    ],
    ["WAL mode", "PRAGMA journal_mode = WAL"],
  ])("rejects %s without changing the gate bytes", (_name, sql) => {
    prepareGate(sql);
    const bytes = readFileSync(gate);
    expectGateFailure();
    expect(readFileSync(gate)).toEqual(bytes);
  });

  it("rejects a directory at the gate path", () => {
    mkdirSync(gate);
    expectGateFailure();
  });

  it("rejects a multiply linked gate", () => {
    writeFileSync(join(base, "other-file"), "", { mode: 0o600 });
    linkSync(join(base, "other-file"), gate);
    expectGateFailure();
  });

  it("rejects a linked gate and an aliased base without following them", () => {
    const real = join(base, "real");
    mkdirSync(real, { mode: 0o700 });
    const kind = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(real, gate, kind);
    expectGateFailure();
    expectGateFailure(gate);
  });

  it.skipIf(process.platform === "win32").each([
    ["missing journal", "journal", true, "No such file or directory", true],
    ["journal still present", "journal", false, "No such file or directory", false],
    ["permission error on a vanished journal", "journal", true, "Permission denied", false],
    ["missing gate", "gate", true, "No such file or directory", false],
  ])("handles the macOS ACL lookup for %s", (_name, target, remove, diagnostic, allowed) => {
    writeFileSync(gate, "", { mode: 0o600 });
    const journal = `${gate}-journal`;
    writeFileSync(journal, "", { mode: 0o600 });
    const failedPath = target === "journal" ? journal : gate;
    vi.stubGlobal("process", Object.create(process, { platform: { value: "darwin" } }));
    let checked = false;
    vi.mocked(execFileSync).mockImplementation((file, args) => {
      if (file === "/bin/df") return "header\n/dev/disk1s1 apfs 1 1 1 1% /\n";
      if (file !== "/bin/ls" || args?.[0] !== "-blde") throw new Error("Unexpected ACL tool");
      if (args?.[1] !== failedPath) return "no ACL entries\n";
      checked = true;
      if (remove) rmSync(failedPath);
      throw Object.assign(new Error("ls failed"), {
        status: 1,
        signal: null,
        stderr: `ls: ${failedPath}: ${diagnostic}\n`,
      });
    });
    if (allowed) acquireLocationLease(base, "shared").release();
    else expectGateFailure();
    expect(checked).toBe(true);
  });

  it("rejects a nonregular rollback journal", () => {
    writeFileSync(gate, "", { mode: 0o600 });
    mkdirSync(`${gate}-journal`);
    expectGateFailure();
  });

  it.skipIf(process.platform === "win32")("rejects a base writable by other users", () => {
    chmodSync(base, 0o777);
    expectGateFailure();
  });

  // Windows creates profile folders owned by SYSTEM, and an elevated admin's files are
  // owned by Administrators. Both already hold full control, so either may own the profile.
  it.runIf(process.platform === "win32")("accepts the current user's real profile", () => {
    expect(() => checkWindowsProfile(realpathSync.native(homedir()), [])).not.toThrow();
  });

  it("does not accept a missing, relative, or noncanonical base", () => {
    expectGateFailure(join(base, "missing"));
    expectGateFailure(join(".", dirname(gateName), "relative"));
    expectGateFailure(`${base}/missing/..`);
  });
});
