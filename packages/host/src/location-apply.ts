import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  acquireLocationLease,
  type LocationContext,
  type LocationRecord,
  readLocationRecord,
  resolveLocation,
  takeLocationRequest,
  writeLocationRecord,
} from "./data-location.ts";
import { LocationBusyError } from "./location-gate.ts";
import { checkTargetParent, createPrivateFolder, verifyPrivateFolder } from "./location-target.ts";
import { isHostRunning, socketPath } from "./server.ts";

export type ApplyFailure =
  | "busy"
  | "host-running"
  | "env-override"
  | "invalid-target"
  | "worktrees"
  | "copy-failed"
  | "corrupt-request";
export type ApplyResult =
  | { kind: "none" }
  | { kind: "applied"; record: LocationRecord }
  | { kind: "failed"; code: ApplyFailure };

const dbName = "herd.db";
const walName = `${dbName}-wal`;
const journalName = `${dbName}-journal`;
const skipped = new Set([
  walName,
  `${dbName}-shm`,
  journalName,
  "run/herd.sock",
  "run/mcp.sock",
  "run/qr.png",
]);
const fail = (code: ApplyFailure): ApplyResult => ({ kind: "failed", code });

export function canCopy(home: string): boolean {
  const worktrees = join(home, "worktrees");
  try {
    const stats = lstatSync(worktrees, { throwIfNoEntry: false });
    return stats === undefined || (stats.isDirectory() && readdirSync(worktrees).length === 0);
  } catch {
    return false;
  }
}

function copyFile(source: string, destination: string): void {
  if (!lstatSync(source).isFile()) throw new Error("Expected an ordinary data file.");
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
}

function rebase(path: string, from: string, to: string): string {
  if (!isAbsolute(path)) return path;
  const tail = relative(join(from, "tasks"), path);
  return tail && tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail)
    ? join(to, "tasks", tail)
    : path;
}

function rebaseDatabase(db: DatabaseSync, from: string, to: string): void {
  db.exec("BEGIN");
  for (const table of ["tasks", "sessions", "items"]) {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table))
      continue;
    const patch = db.prepare(`UPDATE ${table} SET cwd=? WHERE rowid=?`);
    for (const row of db.prepare(`SELECT rowid AS id, cwd FROM ${table}`).all()) {
      if (typeof row.cwd !== "string" || typeof row.id !== "number") continue;
      const cwd = rebase(row.cwd, from, to);
      if (cwd !== row.cwd) patch.run(cwd, row.id);
    }
  }
  if (db.prepare("SELECT 1 FROM pragma_table_info('tasks') WHERE name='workspace_json'").get()) {
    const patch = db.prepare("UPDATE tasks SET workspace_json=? WHERE rowid=?");
    for (const row of db
      .prepare("SELECT rowid AS id, workspace_json FROM tasks WHERE workspace_json IS NOT NULL")
      .all()) {
      if (typeof row.workspace_json !== "string" || typeof row.id !== "number") continue;
      const workspace: unknown = JSON.parse(row.workspace_json);
      if (
        typeof workspace !== "object" ||
        workspace === null ||
        !("cwd" in workspace) ||
        typeof workspace.cwd !== "string"
      )
        continue;
      const cwd = rebase(workspace.cwd, from, to);
      if (cwd !== workspace.cwd) patch.run(JSON.stringify({ ...workspace, cwd }), row.id);
    }
  }
  db.exec("COMMIT");
  const check = db.prepare("PRAGMA quick_check").all();
  if (check.length !== 1 || check[0]?.quick_check !== "ok")
    throw new Error("The copied database did not pass quick_check.");
}

function copyDatabase(from: string, to: string): void {
  // A read-only WAL connection can still write source SHM. Recover and vacuum a private
  // snapshot instead. The exclusive gate prevents participating writers during the snapshot.
  const scratch = mkdtempSync(join(to, ".sqlite-copy-"));
  const snapshot = join(scratch, dbName);
  copyFile(join(from, dbName), snapshot);
  for (const name of [walName, journalName]) {
    if (lstatSync(join(from, name), { throwIfNoEntry: false }))
      copyFile(join(from, name), join(scratch, name));
  }
  const source = new DatabaseSync(snapshot);
  try {
    source.prepare("VACUUM INTO ?").run(join(to, dbName));
  } finally {
    source.close();
  }
  const destination = new DatabaseSync(join(to, dbName));
  try {
    rebaseDatabase(destination, from, to);
  } finally {
    destination.close();
  }
  // Only internal scratch on success; leave an unused destination intact on failure.
  rmSync(scratch, { recursive: true });
}

function copyHome(from: string, to: string, progress: (files: number) => void): void {
  const root = lstatSync(from, { throwIfNoEntry: false });
  if (!root) return;
  if (!root.isDirectory()) throw new Error("Expected a data directory.");
  let files = 0;
  function walk(path: string[]): void {
    for (const name of readdirSync(join(from, ...path))) {
      const parts = [...path, name];
      const key = parts.join("/");
      const source = join(from, ...parts);
      const destination = join(to, ...parts);
      if (skipped.has(key)) {
        if (lstatSync(source).isDirectory()) throw new Error("A transient path is a directory.");
        continue;
      }
      const stats = lstatSync(source);
      if (key === dbName) {
        copyDatabase(from, to);
        progress(++files);
      } else if (stats.isDirectory()) {
        mkdirSync(destination, { mode: 0o700 });
        walk(parts);
      } else {
        copyFile(source, destination);
        progress(++files);
      }
    }
  }
  walk([]);
}

export async function applyLocationRequest(
  ctx: LocationContext,
  progress: (files: number) => void,
): Promise<ApplyResult> {
  let lease: ReturnType<typeof acquireLocationLease>;
  try {
    lease = acquireLocationLease(ctx.base, "exclusive");
  } catch (error) {
    if (!(error instanceof LocationBusyError)) throw error;
    return takeLocationRequest(ctx) === undefined ? { kind: "none" } : fail("busy");
  }
  try {
    const request = takeLocationRequest(ctx);
    if (request === undefined) return { kind: "none" };
    if (request === "corrupt") return fail("corrupt-request");
    const { home, source, protectedPaths } = resolveLocation(ctx);
    if (source === "env") return fail("env-override");
    if (await isHostRunning(socketPath(home))) return fail("host-running");
    let target: string;
    try {
      target = await checkTargetParent(request.parent, protectedPaths);
      if (request.mode === "copy" && !canCopy(home)) return fail("worktrees");
      await createPrivateFolder(target);
    } catch {
      return fail("invalid-target");
    }
    try {
      if (request.mode === "copy") copyHome(home, target, progress);
      await verifyPrivateFolder(target);
      const saved = readLocationRecord(ctx);
      const retained = [
        ...new Set([
          home,
          ...(saved?.previous ? [saved.previous] : []),
          ...(saved?.retained ?? []),
        ]),
      ].filter((path) => path !== target);
      const record: LocationRecord = { version: 1, active: target, previous: home, retained };
      writeLocationRecord(ctx, record, lease);
      return { kind: "applied", record };
    } catch {
      return fail("copy-failed");
    }
  } finally {
    lease.release();
  }
}
