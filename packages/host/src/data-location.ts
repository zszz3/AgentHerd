// The per-user data location (docs/specs/2026-11-22-data-directory-design.md): which directory
// AgentHerd uses, shared by the desktop app, the host process and the CLI. The record and the
// request live in the user profile, outside the movable directory, next to the location gate.

import { randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  opendirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import {
  acquireLocationLease,
  gateFile,
  isLiveExclusiveLease,
  type LocationLease,
} from "./location-gate.ts";

export { acquireLocationLease, type LocationLease, type LocationMode } from "./location-gate.ts";

export interface LocationContext {
  /** The trusted per-user base, normally `os.homedir()`. */
  base: string;
  env: NodeJS.ProcessEnv;
}

export interface LocationRecord {
  version: 1;
  active: string;
  previous?: string;
  retained: string[];
}

export interface LocationSnapshot {
  home: string;
  source: "env" | "saved" | "default";
  /** The home, the default and saved roots. */
  protectedPaths: readonly string[];
  /** Declared metadata names, protected even before the files exist. */
  protectedLocationFiles: readonly string[];
}

export interface LocationRequest {
  version: 1;
  parent: string;
  mode: "empty" | "copy";
}

export class LocationError extends Error {
  readonly code: "record-corrupt" | "location-unavailable";

  constructor(code: LocationError["code"], message: string) {
    super(message);
    this.name = "LocationError";
    this.code = code;
  }
}

const recordFile = ".agentherd-location.json";
const requestFile = ".agentherd-location-request.json";
/** Far above any valid record; a larger file is not parsed. */
const maxBytes = 64 * 1024;

export function locationContext(): LocationContext {
  return { base: homedir(), env: process.env };
}

function isPath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && normalize(value) === value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

function isRecord(value: unknown): value is LocationRecord {
  return (
    isPlainObject(value) &&
    value.version === 1 &&
    isPath(value.active) &&
    (value.previous === undefined || isPath(value.previous)) &&
    Array.isArray(value.retained) &&
    value.retained.every(isPath)
  );
}

function isRequest(value: unknown): value is LocationRequest {
  return (
    isPlainObject(value) &&
    value.version === 1 &&
    isPath(value.parent) &&
    (value.mode === "empty" || value.mode === "copy")
  );
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Parsed JSON, `undefined` when the file does not exist, or `"corrupt"`. */
function readJson(path: string): unknown {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if (isMissing(error)) return undefined;
    return "corrupt";
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > maxBytes) return "corrupt";
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (let n = 1; n > 0 && length < bytes.length; length += n) {
      n = readSync(fd, bytes, length, bytes.length - length, null);
    }
    if (length > maxBytes) return "corrupt";
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } catch {
    return "corrupt";
  } finally {
    closeSync(fd);
  }
}

/** Writes a private temporary sibling and renames it over `path`; never truncates in place. */
function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Already renamed or never written; the original error matters.
    }
    throw error;
  }
}

function canListDirectory(path: string): boolean {
  try {
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    const dir = opendirSync(path);
    try {
      dir.readSync();
      return true;
    } finally {
      dir.closeSync();
    }
  } catch {
    return false;
  }
}

/** The saved record, or `undefined` when there is none. Throws when it is unreadable. */
export function readLocationRecord(ctx: LocationContext): LocationRecord | undefined {
  const value = readJson(join(ctx.base, recordFile));
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new LocationError(
      "record-corrupt",
      `The saved AgentHerd data location in ${join(ctx.base, recordFile)} cannot be read.`,
    );
  }
  return value;
}

/** Resolves `AGENTHERD_HOME`, then the saved record, then `~/.agentherd`. Creates nothing. */
export function resolveLocation(ctx: LocationContext): LocationSnapshot {
  const fallback = join(ctx.base, ".agentherd");
  const override = ctx.env.AGENTHERD_HOME;
  let record: LocationRecord | undefined;
  let home: string;
  let source: LocationSnapshot["source"];
  if (override !== undefined) {
    // The environment wins; a corrupt record must not block it.
    try {
      record = readLocationRecord(ctx);
    } catch {
      record = undefined;
    }
    home = resolve(override);
    source = "env";
  } else {
    record = readLocationRecord(ctx);
    home = record?.active ?? fallback;
    source = record === undefined ? "default" : "saved";
    if (record !== undefined && !canListDirectory(home)) {
      throw new LocationError(
        "location-unavailable",
        `The saved AgentHerd data directory ${home} is unavailable.`,
      );
    }
  }
  const gate = join(ctx.base, gateFile);
  const paths = [
    home,
    fallback,
    ...(record === undefined ? [] : [record.active, ...record.retained]),
    ...(record?.previous === undefined ? [] : [record.previous]),
  ];
  const protectedLocationFiles = [
    join(ctx.base, recordFile),
    join(ctx.base, requestFile),
    gate,
    `${gate}-journal`,
  ];
  return { home, source, protectedPaths: [...new Set(paths)], protectedLocationFiles };
}

/** Runs `work` on the resolved location under a shared lease held until it settles. */
export async function withLocation<T>(
  ctx: LocationContext,
  work: (snapshot: LocationSnapshot) => T | Promise<T>,
): Promise<T> {
  const lease = acquireLocationLease(ctx.base, "shared");
  try {
    return await work(resolveLocation(ctx));
  } finally {
    lease.release();
  }
}

export function writeLocationRecord(
  ctx: LocationContext,
  record: LocationRecord,
  exclusive: LocationLease,
): void {
  if (!isLiveExclusiveLease(exclusive)) {
    throw new Error("Writing the data location record needs a live exclusive lease.");
  }
  if (!isRecord(record)) throw new Error("The data location record is invalid.");
  writeJson(join(ctx.base, recordFile), record);
}

export function writeLocationRequest(ctx: LocationContext, request: LocationRequest): void {
  if (!isRequest(request)) throw new Error("The data location request is invalid.");
  writeJson(join(ctx.base, requestFile), request);
}

/** Reads and deletes the pending request, so it is applied at most once. */
export function takeLocationRequest(ctx: LocationContext): LocationRequest | "corrupt" | undefined {
  const path = join(ctx.base, requestFile);
  const value = readJson(path);
  if (value === undefined) return undefined;
  unlinkSync(path);
  return isRequest(value) ? value : "corrupt";
}
