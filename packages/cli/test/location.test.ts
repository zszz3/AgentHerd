import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FeishuChannel } from "@agentherd/channel-feishu";
import QRCode from "qrcode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireLocationLease } from "../../host/src/location-gate.ts";
import { main } from "../src/main.ts";

const cliBin = fileURLToPath(new URL("../bin/agentherd.ts", import.meta.url));
const hostBin = fileURLToPath(new URL("../../host/bin/host.ts", import.meta.url));
const holder = fileURLToPath(
  new URL("../../host/test/fixtures/location-gate-child.ts", import.meta.url),
);
let base: string;
let home: string;
let env: NodeJS.ProcessEnv;
const children: ChildProcess[] = [];

beforeEach(() => {
  // The gate needs a protected local profile; on Windows the temp folder may not qualify.
  const parent = realpathSync.native(process.platform === "win32" ? homedir() : tmpdir());
  // Keep the name short: macOS tmpdir() is long and the host socket must fit in `sun_path`.
  base = mkdtempSync(join(parent, "ah-cli-"));
  home = join(base, ".agentherd");
  // os.homedir() follows these in the child processes.
  env = { ...process.env, HOME: base, USERPROFILE: base };
  delete env.AGENTHERD_HOME;
  delete env.AGENTHERD_AGENTS;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(children.splice(0).map(stopChild));
  rmSync(base, { recursive: true, force: true, maxRetries: 3 });
});

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill();
  return exited;
}

function run(bin: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    env,
    input: "",
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return { code: result.status, text: result.stdout + result.stderr };
}

/** A child process that holds the exclusive lease until it is stopped. */
async function holdExclusive(): Promise<void> {
  const child = spawn(process.execPath, [holder, base, "exclusive"], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    windowsHide: true,
  });
  children.push(child);
  await new Promise<void>((done, fail) => {
    child.on("message", (message) => {
      if (message === "ready") child.send("acquire");
      else if (message === "held") done();
      else fail(new Error(`holder answered ${String(message)}`));
    });
    child.once("exit", (code) => fail(new Error(`holder exited with ${code}`)));
  });
}

function save(active: string): void {
  writeFileSync(
    join(base, ".agentherd-location.json"),
    JSON.stringify({ version: 1, active, retained: [] }),
  );
}

describe("CLI data location", () => {
  it("prints help without touching storage", () => {
    writeFileSync(join(base, ".agentherd-location.json"), "{corrupt");
    for (const args of [["--help"], ["model", "help"]]) {
      const { code, text } = run(cliBin, ...args);
      expect(code).toBe(0);
      expect(text).toContain("Usage:");
    }
    expect(readdirSync(base)).toEqual([".agentherd-location.json"]);
  }, 15_000);

  it("fails status fast while another process holds the exclusive lease", async () => {
    await holdExclusive();
    const started = Date.now();
    const { code, text } = run(cliBin, "status");
    expect(code).toBe(1);
    expect(text).toMatch(/in use/);
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(existsSync(join(home, "herd.db"))).toBe(false);
  }, 20_000);

  it("uses the saved directory for status and leaves the default alone", () => {
    const saved = join(base, "Herd 数据");
    mkdirSync(saved);
    save(saved);
    expect(run(cliBin, "status").code).toBe(0);
    expect(existsSync(join(saved, "herd.db"))).toBe(true);
    expect(existsSync(home)).toBe(false);
  }, 15_000);

  it("points to the app for an unavailable saved directory and creates nothing", () => {
    const saved = join(base, "offline");
    save(saved);
    const { code, text } = run(cliBin, "status");
    expect(code).toBe(1);
    expect(text).toMatch(/open AgentHerd to recover/i);
    expect(existsSync(saved)).toBe(false);
    expect(existsSync(home)).toBe(false);
  }, 15_000);

  it("releases the lease after a rejected command, once its QR writes settle", async () => {
    vi.stubEnv("HOME", base);
    vi.stubEnv("USERPROFILE", base);
    vi.stubEnv("AGENTHERD_HOME", undefined);
    let finishWrite = () => {};
    const write = new Promise<void>((done) => {
      finishWrite = done;
    });
    // toFile is overloaded; the spy types only its callback form, which returns void.
    vi.spyOn(QRCode, "toFile").mockImplementation((() => write) as unknown as typeof QRCode.toFile);
    const setup = vi.spyOn(FeishuChannel.prototype, "setup").mockImplementation(async (ui) => {
      ui.showQrCode("https://example.test/fixture", 300);
      throw new Error("fixture registration failed");
    });
    const result = main(["setup", "feishu"], () => {}).catch((error: unknown) => error);
    try {
      // The registration has already failed; only the QR write is outstanding.
      await new Promise<void>((done) => setImmediate(done));
      expect(setup).toHaveBeenCalled();
      expect(() => acquireLocationLease(base, "exclusive")).toThrow(/in use/);
    } finally {
      finishWrite();
    }
    expect(await result).toEqual(new Error("fixture registration failed"));
    acquireLocationLease(base, "exclusive").release();
  }, 15_000);
});

describe("host bin data location", () => {
  it("keeps its lease until it is stopped", async () => {
    const child = spawn(process.execPath, [hostBin], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    children.push(child);
    let output = "";
    await new Promise<void>((done, fail) => {
      const seen = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("[host] API on")) done();
      };
      child.stdout?.on("data", seen);
      child.stderr?.on("data", seen);
      child.once("exit", (code) => fail(new Error(`host exited with ${code}: ${output}`)));
    });
    expect(() => acquireLocationLease(base, "exclusive")).toThrow(/in use/);
    await stopChild(child);
    acquireLocationLease(base, "exclusive").release();
  }, 30_000);

  it("refuses to start while another process holds the exclusive lease", async () => {
    await holdExclusive();
    const { code, text } = run(hostBin);
    expect(code).toBe(1);
    expect(text).toMatch(/in use/);
    expect(existsSync(home)).toBe(false);
  }, 20_000);
});
