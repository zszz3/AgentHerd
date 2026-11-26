import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type LocationContext,
  resolveLocation,
  writeLocationRequest,
} from "../src/data-location.ts";
import { applyLocationRequest } from "../src/location-apply.ts";
import { createPrivateFolder, verifyPrivateFolder } from "../src/location-target.ts";

import { socketPath } from "../src/server.ts";
import { XHS_VERSION, xhsAsset } from "../src/xiaohongshu.ts";

const sourceMissing = vi.hoisted(() => new Set<string>());
const destinationAliases = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    lstatSync: ((...args: Parameters<typeof fs.lstatSync>) => {
      const [path, options] = args;
      if (typeof path !== "string") return fs.lstatSync(...args);
      if (sourceMissing.has(path)) return undefined;
      return fs.lstatSync(destinationAliases.get(path) ?? path, options);
    }) as typeof fs.lstatSync,
  };
});

const supported = process.platform === "win32" || process.platform === "darwin";
let tmp: string;
let ctx: LocationContext;
let parent: string;
let old: string;
let target: string;
const apply = (progress = (_count: number) => {}) => applyLocationRequest(ctx, progress);
const record = () => join(ctx.base, ".agentherd-location.json");
const request = () => join(ctx.base, ".agentherd-location-request.json");

describe.runIf(supported)("applyLocationRequest", () => {
  beforeEach(async () => {
    if (process.platform === "win32") {
      const root = parse(process.env.SystemRoot ?? "C:\\Windows").root;
      tmp = join(root, `ah-apply-${randomUUID()}`);
      await createPrivateFolder(tmp);
    } else {
      tmp = mkdtempSync(join(realpathSync.native(tmpdir()), "ah-apply-"));
    }
    ctx = { base: join(tmp, "base"), env: {} };
    parent = join(tmp, "picked");
    old = join(ctx.base, ".agentherd");
    target = join(parent, "AgentHerd");
    mkdirSync(old, { recursive: true, mode: 0o700 });
    mkdirSync(parent, { mode: 0o700 });
  });
  afterEach(() => {
    sourceMissing.clear();
    destinationAliases.clear();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("does nothing without a request, drops corrupt requests and honors an override", async () => {
    expect(await apply()).toEqual({ kind: "none" });
    writeFileSync(request(), "{", { mode: 0o600 });
    expect(await apply()).toEqual({ kind: "failed", code: "corrupt-request" });
    writeLocationRequest(ctx, { version: 1, parent, mode: "empty" });
    ctx.env.AGENTHERD_HOME = old;
    expect(await apply()).toEqual({ kind: "failed", code: "env-override" });
    expect(existsSync(request())).toBe(false);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(record())).toBe(false);
  });

  it("starts empty even with worktrees and keeps the old directory", async () => {
    mkdirSync(join(old, "worktrees"));
    writeFileSync(join(old, "worktrees", "witness"), "retained");
    writeLocationRequest(ctx, { version: 1, parent, mode: "copy" });
    expect(await apply()).toEqual({ kind: "failed", code: "worktrees" });
    expect(existsSync(target)).toBe(false);
    writeLocationRequest(ctx, { version: 1, parent, mode: "empty" });
    expect(await apply()).toEqual({
      kind: "applied",
      record: { version: 1, active: target, previous: old, retained: [old] },
    });
    expect(readdirSync(target)).toEqual([]);
    await verifyPrivateFolder(target);
    expect(readFileSync(join(old, "worktrees", "witness"), "utf8")).toBe("retained");
  }, 20_000);

  it.runIf(process.platform === "win32" && Boolean(process.env.AGENTHERD_TEST_OTHER_DRIVE))(
    "copies to a private parent on another NTFS drive",
    async () => {
      const root = process.env.AGENTHERD_TEST_OTHER_DRIVE ?? "";
      expect(root).toMatch(/^[a-z]:\\$/i);
      expect(root.toLowerCase()).not.toBe(parse(old).root.toLowerCase());
      const picked = join(root, `ah-cross-volume-${randomUUID()}`);
      await createPrivateFolder(picked);
      try {
        writeFileSync(join(old, "fixture.json"), "fixture");
        writeLocationRequest(ctx, { version: 1, parent: picked, mode: "copy" });
        const result = await apply();
        expect(result).toMatchObject({ kind: "applied", record: { previous: old } });
        expect(readFileSync(join(picked, "AgentHerd", "fixture.json"), "utf8")).toBe("fixture");
        expect(readFileSync(join(old, "fixture.json"), "utf8")).toBe("fixture");
      } finally {
        rmSync(picked, { recursive: true });
      }
    },
    20_000,
  );

  it("does not reuse a private empty destination", async () => {
    await createPrivateFolder(target);
    writeLocationRequest(ctx, { version: 1, parent, mode: "copy" });
    expect(await apply()).toEqual({ kind: "failed", code: "invalid-target" });
    expect(readdirSync(target)).toEqual([]);
    await verifyPrivateFolder(target);
    expect(existsSync(record())).toBe(false);
  }, 20_000);

  it("drops a request blocked by a shared lease", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/location-gate-child.ts", import.meta.url));
    const child = fork(fixture, [ctx.base, "shared"], { execArgv: [], silent: true });
    const closed = once(child, "close");
    try {
      expect((await once(child, "message"))[0]).toBe("ready");
      const held = once(child, "message");
      child.send("acquire");
      expect((await held)[0]).toBe("held");
      writeLocationRequest(ctx, { version: 1, parent, mode: "empty" });
      expect(await apply()).toEqual({ kind: "failed", code: "busy" });
      expect(existsSync(request())).toBe(false);
      expect(existsSync(record())).toBe(false);
      child.send("release");
      expect(await closed).toEqual([0, null]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
  }, 20_000);

  it("refuses a host listening on the old socket", async () => {
    mkdirSync(join(old, "run"));
    const server = createServer((peer) => peer.end()).listen(socketPath(old));
    try {
      await once(server, "listening");
      writeLocationRequest(ctx, { version: 1, parent, mode: "copy" });
      expect(await apply()).toEqual({ kind: "failed", code: "host-running" });
      expect(existsSync(request())).toBe(false);
      expect(existsSync(target)).toBe(false);
      expect(resolveLocation(ctx).home).toBe(old);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it("leaves an unused destination and the old selection on a copy error", async () => {
    writeFileSync(join(old, "secrets.json"), "fixture");
    writeLocationRequest(ctx, { version: 1, parent, mode: "copy" });
    expect(
      await apply(() => {
        throw new Error("interrupted");
      }),
    ).toEqual({ kind: "failed", code: "copy-failed" });
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(join(old, "secrets.json"), "utf8")).toBe("fixture");
    expect(resolveLocation(ctx).home).toBe(old);
    expect(existsSync(record())).toBe(false);
  }, 20_000);

  it("does not copy an unexpected link", async () => {
    symlinkSync(parent, join(old, "unexpected"), process.platform === "win32" ? "junction" : "dir");
    writeLocationRequest(ctx, { version: 1, parent, mode: "copy" });
    expect(await apply()).toEqual({ kind: "failed", code: "copy-failed" });
    expect(existsSync(record())).toBe(false);
  }, 20_000);

  it("uses source-volume lookup for database and transient names", async () => {
    const sourceDb = join(old, "HERD.DB");
    const run = join(old, "RUN");
    mkdirSync(run);
    writeFileSync(join(run, "QR.PNG"), "fixture");
    const db = new DatabaseSync(sourceDb);
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        CREATE TABLE tasks (cwd TEXT); PRAGMA wal_checkpoint(TRUNCATE)`);
      const cwd = join(old, "tasks", "fixture");
      db.prepare("INSERT INTO tasks VALUES (?)").run(cwd);
      const names = ["HERD.DB", "HERD.DB-wal", "HERD.DB-shm", "RUN/QR.PNG"];
      const before = names.map((name) => readFileSync(join(old, name)));
      const insensitive = existsSync(join(old, "herd.db"));
      writeLocationRequest(ctx, { version: 1, parent, mode: "copy" });
      expect(await apply()).toMatchObject({ kind: "applied" });
      expect(names.map((name) => readFileSync(join(old, name)))).toEqual(before);
      if (insensitive) {
        expect(readdirSync(target).sort()).toEqual(["herd.db", "run"]);
        expect(readdirSync(join(target, "run"))).toEqual([]);
        const copied = new DatabaseSync(join(target, "herd.db"), { readOnly: true });
        try {
          expect(copied.prepare("SELECT cwd FROM tasks").get()?.cwd).toBe(
            join(target, "tasks", "fixture"),
          );
        } finally {
          copied.close();
        }
      } else {
        expect(readFileSync(join(target, "RUN", "QR.PNG"), "utf8")).toBe("fixture");
        expect(readFileSync(join(target, "HERD.DB"))).toEqual(before[0]);
      }
    } finally {
      db.close();
    }
  }, 20_000);

  it("refuses an ordinary file that the destination resolves as a reserved transient", async () => {
    mkdirSync(join(old, "run"));
    const ordinary = join(old, "run", "QR.PNG");
    const canonical = join(old, "run", "qr.png");
    writeFileSync(ordinary, "ordinary fixture");
    // Model just the source lookup on a case-sensitive volume. The destination lookup is real.
    sourceMissing.add(canonical);
    writeLocationRequest(ctx, { version: 1, parent, mode: "copy" });
    const result = await apply();
    expect(readFileSync(ordinary, "utf8")).toBe("ordinary fixture");
    if (existsSync(canonical)) {
      expect(result).toEqual({ kind: "failed", code: "copy-failed" });
      expect(existsSync(record())).toBe(false);
      expect(resolveLocation(ctx).home).toBe(old);
    } else {
      expect(result).toMatchObject({ kind: "applied" });
      expect(readFileSync(join(target, "run", "QR.PNG"), "utf8")).toBe("ordinary fixture");
    }
  }, 20_000);

  it.each([
    ["CONFIG.JSON", "config.json"],
    ["SECRETS.JSON", "secrets.json"],
    ["WORKTREES", "worktrees"],
    ["feeds/TOLD.JSON", "feeds/told.json"],
    ["plugins/CATALOG.JSON", "plugins/catalog.json"],
    ["logs/HOST.LOG", "logs/host.log"],
  ])(
    "does not give ordinary %s a reserved destination meaning",
    async (alias, key) => {
      const parts = alias.split("/");
      const ordinary = join(old, ...parts);
      const canonical = join(old, key);
      mkdirSync(join(old, ...parts.slice(0, -1)), { recursive: true });
      writeFileSync(ordinary, "fixture");
      const aliasesOnTarget = existsSync(canonical);
      sourceMissing.add(canonical);
      writeLocationRequest(ctx, { version: 1, parent, mode: "copy" });
      const result = await apply();
      expect(readFileSync(ordinary, "utf8")).toBe("fixture");
      if (aliasesOnTarget) {
        expect(result).toEqual({ kind: "failed", code: "copy-failed" });
        expect(existsSync(record())).toBe(false);
        expect(resolveLocation(ctx).home).toBe(old);
      } else {
        expect(result).toMatchObject({ kind: "applied" });
        expect(readFileSync(join(target, ...parts), "utf8")).toBe("fixture");
      }
    },
    20_000,
  );

  const wecomFiles = [
    "credentials.enc",
    "bot.enc",
    "token.enc",
    ".encryption_key",
    "config.json",
    "disconnect-pending",
  ];

  it.each(["wecom-cli", ...wecomFiles.map((name) => `wecom-cli/${name}`)])(
    "does not give ordinary data the fixed WeCom meaning %s",
    async (key) => {
      const parts = key.split("/");
      const alias = [...parts.slice(0, -1), parts.at(-1)?.toUpperCase() ?? ""];
      // For the root case, put an ordinary file inside the uppercase directory.
      const suffix = parts.length === 1 ? ["note.txt"] : [];
      const ordinary = join(old, ...alias, ...suffix);
      const selection = JSON.stringify({ version: 1, active: old, retained: [] });
      mkdirSync(join(old, ...[...alias, ...suffix].slice(0, -1)), { recursive: true });
      writeFileSync(ordinary, "ordinary text fixture");
      writeFileSync(record(), selection, { mode: 0o600 });
      // Simulate only the two name-lookup results on mixed-sensitivity volumes.
      sourceMissing.add(join(old, key));
      destinationAliases.set(join(target, key), join(target, ...alias));
      writeLocationRequest(ctx, { version: 1, parent, mode: "copy" });

      expect(await apply()).toEqual({ kind: "failed", code: "copy-failed" });
      expect(readFileSync(ordinary, "utf8")).toBe("ordinary text fixture");
      expect(readFileSync(record(), "utf8")).toBe(selection);
      expect(resolveLocation(ctx)).toMatchObject({ source: "saved", home: old });
    },
    20_000,
  );

  it("keeps WeCom app files and the pending disconnect, leaving external data in place", async () => {
    const external = join(ctx.base, ".config", "wecom");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "external.txt"), "external text fixture");
    mkdirSync(join(old, "wecom-cli"));
    for (const name of wecomFiles) {
      writeFileSync(join(old, "wecom-cli", name), `inert fixture: ${name}`);
    }
    writeLocationRequest(ctx, { version: 1, parent, mode: "copy" });

    expect(await apply()).toMatchObject({ kind: "applied" });
    for (const name of wecomFiles) {
      expect(readFileSync(join(target, "wecom-cli", name), "utf8")).toBe(`inert fixture: ${name}`);
      expect(readFileSync(join(old, "wecom-cli", name), "utf8")).toBe(`inert fixture: ${name}`);
    }
    expect(readFileSync(join(external, "external.txt"), "utf8")).toBe("external text fixture");
    expect(readdirSync(target)).toEqual(["wecom-cli"]);
  }, 20_000);

  it.each([
    "dingtalk-dws",
    "dingtalk-dws/config",
    "dingtalk-dws/config/.data.lock",
    "dingtalk-dws/credentials",
    "dingtalk-dws/reset-pending",
  ])(
    "does not give ordinary data the fixed DingTalk meaning %s",
    async (key) => {
      const parts = key.split("/");
      const alias = [...parts.slice(0, -1), parts.at(-1)?.toUpperCase() ?? ""];
      // For a directory, put an ordinary file inside the uppercase directory.
      const suffix =
        key === "dingtalk-dws/reset-pending" || key.endsWith(".lock") ? [] : ["note.txt"];
      const ordinary = join(old, ...alias, ...suffix);
      const selection = JSON.stringify({ version: 1, active: old, retained: [] });
      mkdirSync(join(old, ...[...alias, ...suffix].slice(0, -1)), { recursive: true });
      writeFileSync(ordinary, "ordinary text fixture");
      writeFileSync(record(), selection, { mode: 0o600 });
      // Simulate only the two name-lookup results on mixed-sensitivity volumes.
      sourceMissing.add(join(old, key));
      destinationAliases.set(join(target, key), join(target, ...alias));
      writeLocationRequest(ctx, { version: 1, parent, mode: "copy" });

      expect(await apply()).toEqual({ kind: "failed", code: "copy-failed" });
      expect(readFileSync(ordinary, "utf8")).toBe("ordinary text fixture");
      expect(readFileSync(record(), "utf8")).toBe(selection);
      expect(resolveLocation(ctx)).toMatchObject({ source: "saved", home: old });
    },
    20_000,
  );

  it("keeps the DingTalk sign-in and pending reset, skips its lock, leaves external data", async () => {
    const external = join(ctx.base, ".dws");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "external.txt"), "external text fixture");
    const state = join(old, "dingtalk-dws");
    const kept = ["config/profiles.json", "credentials/fake-token", "reset-pending"];
    mkdirSync(join(state, "config"), { recursive: true });
    mkdirSync(join(state, "credentials"));
    for (const name of kept) writeFileSync(join(state, name), `inert fixture: ${name}`);
    writeFileSync(join(state, "config", ".data.lock"), "");
    writeLocationRequest(ctx, { version: 1, parent, mode: "copy" });

    expect(await apply()).toMatchObject({ kind: "applied" });
    for (const name of kept) {
      expect(readFileSync(join(target, "dingtalk-dws", name), "utf8")).toBe(
        `inert fixture: ${name}`,
      );
      expect(readFileSync(join(state, name), "utf8")).toBe(`inert fixture: ${name}`);
    }
    expect(existsSync(join(target, "dingtalk-dws", "config", ".data.lock"))).toBe(false);
    expect(readFileSync(join(external, "external.txt"), "utf8")).toBe("external text fixture");
    expect(readdirSync(target)).toEqual(["dingtalk-dws"]);
  }, 20_000);

  it.runIf(xhsAsset() !== undefined).each(["", ".part"])(
    "refuses an ordinary file that aliases the fixed Xiaohongshu path (suffix %j)",
    async (suffix) => {
      const ext = process.platform === "win32" ? ".exe" : "";
      const name = `xiaohongshu-mcp-${XHS_VERSION}${ext}${suffix}`;
      const alias = name.toUpperCase();
      const ordinary = join(old, "bin", alias);
      const selection = JSON.stringify({ version: 1, active: old, retained: [] });
      mkdirSync(join(old, "bin"));
      writeFileSync(ordinary, "ordinary text fixture");
      writeFileSync(record(), selection, { mode: 0o600 });
      // Model mixed lookup at these two paths; only the migration decision is exercised.
      sourceMissing.add(join(old, "bin", name));
      destinationAliases.set(join(target, "bin", name), join(target, "bin", alias));
      writeLocationRequest(ctx, { version: 1, parent, mode: "copy" });

      const result = await apply();

      expect(result).toEqual({ kind: "failed", code: "copy-failed" });
      expect(readFileSync(ordinary, "utf8")).toBe("ordinary text fixture");
      expect(readFileSync(record(), "utf8")).toBe(selection);
      expect(resolveLocation(ctx)).toMatchObject({ source: "saved", home: old });
    },
    20_000,
  );

  it.runIf(xhsAsset() !== undefined)(
    "keeps the cached Xiaohongshu file and omits an incomplete download",
    async () => {
      const ext = process.platform === "win32" ? ".exe" : "";
      const name = `xiaohongshu-mcp-${XHS_VERSION}${ext}`;
      const bin = join(old, "bin", name);
      const part = `${bin}.part`;
      mkdirSync(join(old, "bin"));
      writeFileSync(bin, "cached text fixture");
      writeFileSync(part, "incomplete text fixture");
      writeLocationRequest(ctx, { version: 1, parent, mode: "copy" });

      const result = await apply();

      expect(result).toMatchObject({ kind: "applied" });
      expect(readdirSync(join(target, "bin"))).toEqual([name]);
      expect(readFileSync(join(target, "bin", name), "utf8")).toBe("cached text fixture");
      expect(readFileSync(bin, "utf8")).toBe("cached text fixture");
      expect(readFileSync(part, "utf8")).toBe("incomplete text fixture");
    },
    20_000,
  );

  it("keeps committed WAL rows and agent sessions; rebases only structured scratch paths", async () => {
    const files = [
      "secrets.json",
      "config.json",
      "feeds/told.json",
      "plugins/catalog.json",
      "run/claude/session",
      "run/codex-x/session",
      "run/qr.png",
      "run/herd.sock",
      "run/mcp.sock",
    ];
    for (const name of files) {
      const parts = name.split("/");
      mkdirSync(join(old, ...parts.slice(0, -1)), { recursive: true });
      writeFileSync(join(old, ...parts), "fixture");
    }
    mkdirSync(join(old, "logs"));
    writeFileSync(join(old, "logs", "host.log"), "fake host log");
    writeFileSync(join(old, "logs", "notes.txt"), "fake owner note");
    const db = new DatabaseSync(join(old, "herd.db"));
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        CREATE TABLE tasks (cwd TEXT, workspace_json TEXT);
        CREATE TABLE sessions (cwd TEXT);
        CREATE TABLE items (cwd TEXT);
        PRAGMA wal_checkpoint(TRUNCATE)`);
      const cwd = join(old, "tasks", "scratch");
      const next = join(target, "tasks", "scratch");
      const sibling = join(old, "tasks-external", "scratch");
      const external = join(tmp, "external");
      db.prepare("INSERT INTO tasks VALUES (?, ?)").run(
        cwd,
        JSON.stringify({ cwd, project: external, note: cwd }),
      );
      db.prepare("INSERT INTO sessions VALUES (?), (?)").run(cwd, external);
      db.prepare("INSERT INTO items VALUES (?), (?)").run(cwd, sibling);
      const sourceNames = [
        ...files,
        "logs/host.log",
        "logs/notes.txt",
        "herd.db",
        "herd.db-shm",
        "herd.db-wal",
      ];
      const bytes = sourceNames.map((name) => readFileSync(join(old, name)));
      writeLocationRequest(ctx, { version: 1, parent, mode: "copy" });
      const counts: number[] = [];
      expect((await apply((n) => counts.push(n))).kind).toBe("applied");
      expect(counts.at(-1)).toBe(9);
      expect(sourceNames.map((name) => readFileSync(join(old, name)))).toEqual(bytes);
      expect(readdirSync(join(target, "run")).sort()).toEqual(["claude", "codex-x"]);
      for (const name of files.slice(0, 6))
        expect(readFileSync(join(target, name), "utf8")).toBe("fixture");
      expect(readFileSync(join(target, "logs", "host.log"), "utf8")).toBe("fake host log");
      expect(readFileSync(join(target, "logs", "notes.txt"), "utf8")).toBe("fake owner note");
      expect(existsSync(join(target, "herd.db-wal"))).toBe(false);
      expect(existsSync(join(target, "herd.db-shm"))).toBe(false);
      await verifyPrivateFolder(target);
      const copy = new DatabaseSync(join(target, "herd.db"), { readOnly: true });
      try {
        expect(copy.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
        expect(copy.prepare("SELECT * FROM tasks").get()).toEqual({
          cwd: next,
          workspace_json: JSON.stringify({ cwd: next, project: external, note: cwd }),
        });
        expect(copy.prepare("SELECT cwd FROM sessions ORDER BY rowid").all()).toEqual([
          { cwd: next },
          { cwd: external },
        ]);
        expect(copy.prepare("SELECT cwd FROM items ORDER BY rowid").all()).toEqual([
          { cwd: next },
          { cwd: sibling },
        ]);
      } finally {
        copy.close();
      }
    } finally {
      db.close();
    }
  }, 25_000);
});
