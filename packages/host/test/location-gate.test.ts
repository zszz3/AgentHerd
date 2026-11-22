import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLocationLease, type LocationMode } from "../src/location-gate.ts";

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

  it("rejects a nonregular rollback journal", () => {
    writeFileSync(gate, "", { mode: 0o600 });
    mkdirSync(`${gate}-journal`);
    expectGateFailure();
  });

  it.skipIf(process.platform === "win32")("rejects a base writable by other users", () => {
    chmodSync(base, 0o777);
    expectGateFailure();
  });

  it("does not accept a missing, relative, or noncanonical base", () => {
    expectGateFailure(join(base, "missing"));
    expectGateFailure(join(".", dirname(gateName), "relative"));
    expectGateFailure(`${base}/missing/..`);
  });
});
