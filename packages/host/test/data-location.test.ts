import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type LocationContext,
  LocationError,
  type LocationRecord,
  readLocationRecord,
  resolveLocation,
  takeLocationRequest,
  withLocation,
  writeLocationRecord,
  writeLocationRequest,
} from "../src/data-location.ts";
import { acquireLocationLease, type LocationLease } from "../src/location-gate.ts";

let ctx: LocationContext;
let recordPath: string;
let requestPath: string;
let saved: string;
let record: LocationRecord;

beforeEach(() => {
  // The gate needs a protected local profile; on Windows the temp folder may not qualify.
  const parent = realpathSync.native(process.platform === "win32" ? homedir() : tmpdir());
  ctx = { base: mkdtempSync(join(parent, "agentherd-location-")), env: {} };
  recordPath = join(ctx.base, ".agentherd-location.json");
  requestPath = join(ctx.base, ".agentherd-location-request.json");
  saved = join(ctx.base, "Herd 数据 dir");
  record = {
    version: 1,
    active: saved,
    previous: join(ctx.base, "previous"),
    retained: [join(ctx.base, "retained")],
  };
});

afterEach(() => rmSync(ctx.base, { recursive: true, force: true, maxRetries: 3 }));

function put(value: unknown): void {
  writeFileSync(recordPath, typeof value === "string" ? value : JSON.stringify(value));
}

function locationError(work: () => unknown): LocationError {
  try {
    work();
  } catch (error) {
    if (error instanceof LocationError) return error;
    throw error;
  }
  throw new Error("expected a LocationError");
}

describe("resolve the data location", () => {
  it("uses the default when there is no record, without creating anything", () => {
    expect(resolveLocation(ctx)).toMatchObject({
      home: join(ctx.base, ".agentherd"),
      source: "default",
    });
    expect(readLocationRecord(ctx)).toBeUndefined();
    expect(readdirSync(ctx.base)).toEqual([]);
  });

  it("uses a saved path with Unicode and spaces and protects every known root", () => {
    mkdirSync(saved);
    put(record);
    expect(readLocationRecord(ctx)).toEqual(record);
    const snapshot = resolveLocation(ctx);
    expect(snapshot).toMatchObject({ home: saved, source: "saved" });
    expect(snapshot.protectedPaths).toEqual(
      expect.arrayContaining([
        saved,
        join(ctx.base, ".agentherd"),
        join(ctx.base, "previous"),
        join(ctx.base, "retained"),
        recordPath,
        requestPath,
        join(ctx.base, ".agentherd-location.lock.sqlite"),
      ]),
    );
  });

  it("lets AGENTHERD_HOME win even over a corrupt record, leaving it untouched", () => {
    const override = join(ctx.base, "override");
    ctx.env.AGENTHERD_HOME = override;
    put("{corrupt");
    expect(resolveLocation(ctx)).toMatchObject({ home: override, source: "env" });
    expect(readFileSync(recordPath, "utf8")).toBe("{corrupt");
  });

  it.each([
    ["invalid JSON", () => "{corrupt"],
    ["not an object", () => "[]"],
    ["another version", () => JSON.stringify({ ...record, version: 2 })],
    ["a relative path", () => JSON.stringify({ ...record, active: "relative" })],
    ["a non-canonical path", () => JSON.stringify({ ...record, retained: [`${saved}/../alias`] })],
    ["invalid UTF-8", () => Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d])],
    ["an oversized file", () => " ".repeat(1024 * 1024)],
  ])("refuses a record with %s and creates nothing", (_name, bytes) => {
    writeFileSync(recordPath, bytes());
    expect(locationError(() => resolveLocation(ctx)).code).toBe("record-corrupt");
    expect(readdirSync(ctx.base)).toEqual([".agentherd-location.json"]);
  });

  it("refuses a missing or non-directory saved location without creating it", () => {
    put(record);
    expect(locationError(() => resolveLocation(ctx)).code).toBe("location-unavailable");
    expect(readdirSync(ctx.base)).toEqual([".agentherd-location.json"]);
    writeFileSync(saved, "not a directory");
    expect(locationError(() => resolveLocation(ctx)).code).toBe("location-unavailable");
  });

  it("holds a shared lease across await and releases it when the work rejects", async () => {
    await expect(
      withLocation(ctx, async ({ home }) => {
        await Promise.resolve();
        expect(home).toBe(join(ctx.base, ".agentherd"));
        expect(() => acquireLocationLease(ctx.base, "exclusive")).toThrow(/in use/);
        throw new Error("fixture rejection");
      }),
    ).rejects.toThrow("fixture rejection");
    acquireLocationLease(ctx.base, "exclusive").release();
  });
});

describe("write the location record", () => {
  it("rejects a fabricated, released or shared lease", () => {
    const fake: LocationLease = { mode: "exclusive", release() {} };
    const released = acquireLocationLease(ctx.base, "exclusive");
    released.release();
    const shared = acquireLocationLease(ctx.base, "shared");
    try {
      for (const lease of [fake, released, shared]) {
        expect(() => writeLocationRecord(ctx, record, lease)).toThrow(/exclusive/);
      }
    } finally {
      shared.release();
    }
    expect(readdirSync(ctx.base)).not.toContain(".agentherd-location.json");
  });

  it("replaces the record under a live exclusive lease", () => {
    put("{corrupt");
    const lease = acquireLocationLease(ctx.base, "exclusive");
    try {
      writeLocationRecord(ctx, record, lease);
      const next = { version: 1 as const, active: saved, retained: [] };
      writeLocationRecord(ctx, next, lease);
      expect(readLocationRecord(ctx)).toEqual(next);
    } finally {
      lease.release();
    }
    expect(readdirSync(ctx.base).sort()).toEqual(
      [".agentherd-location.json", ".agentherd-location.lock.sqlite"].sort(),
    );
  });
});

describe("the location request", () => {
  it("round-trips once and is deleted when taken", () => {
    expect(takeLocationRequest(ctx)).toBeUndefined();
    const request = { version: 1 as const, parent: join(ctx.base, "D 盘"), mode: "copy" as const };
    writeLocationRequest(ctx, request);
    expect(takeLocationRequest(ctx)).toEqual(request);
    expect(readdirSync(ctx.base)).toEqual([]);
    expect(takeLocationRequest(ctx)).toBeUndefined();
  });

  it("is deleted even when corrupt", () => {
    writeFileSync(requestPath, JSON.stringify({ version: 1, parent: "relative", mode: "copy" }));
    expect(takeLocationRequest(ctx)).toBe("corrupt");
    expect(readdirSync(ctx.base)).toEqual([]);
  });
});
