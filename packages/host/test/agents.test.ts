// Downloads of agent CLIs (catalog.ts, runtimes.ts), the Agents view and the 验证 check, against a
// local HTTP server that serves fake archives.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeChannel } from "@agentherd/channel-fake";
import { afterEach, describe, expect, it } from "vitest";
import { Agents } from "../src/agents.ts";
import type { HostEvent } from "../src/api.ts";
import { type AgentDef, agentProfile, parseDshFeed } from "../src/catalog.ts";
import { writeConfig } from "../src/config.ts";
import { Host } from "../src/host.ts";
import { type ArchiveRelease, type Release, RuntimeStore } from "../src/runtimes.ts";
import { verifyProfile } from "../src/verify.ts";

const SCRIPT = fileURLToPath(new URL("../../mock-agent/scripts/approve.yaml", import.meta.url));
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** Serves `files` (path → bytes) on localhost; returns the base URL. */
async function serve(files: Record<string, Buffer>): Promise<string> {
  const server = createServer((req, res) => {
    const body = files[req.url ?? ""];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-length": body.length }).end(body);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** An archive with tool/tool printing `reported`. */
function fakeArchive(format: "tar.gz" | "zip", reported: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "fake-agent-"));
  mkdirSync(join(dir, "tool"));
  writeFileSync(join(dir, "tool", "tool"), `#!/bin/sh\necho ${reported}\n`);
  chmodSync(join(dir, "tool", "tool"), 0o755);
  const archive = join(dir, `a.${format}`);
  if (format === "tar.gz") execFileSync("tar", ["-czf", archive, "-C", dir, "tool"]);
  else execFileSync("zip", ["-qr", archive, "tool"], { cwd: dir });
  return readFileSync(archive);
}

function release(
  base: string,
  path: string,
  bytes: Buffer,
  patch: Partial<ArchiveRelease> = {},
): ArchiveRelease {
  return {
    kind: "archive",
    id: "tool",
    version: "9.9.9",
    url: `${base}${path}`,
    digest: {
      algorithm: "sha256",
      encoding: "hex",
      value: createHash("sha256").update(bytes).digest("hex"),
    },
    bytes: bytes.length,
    format: path.endsWith(".zip") ? "zip" : "tar.gz",
    executable: "tool/tool",
    check: "exec",
    ...patch,
  };
}

describe("RuntimeStore", () => {
  it("still finds a Pi downloaded before current.json existed", () => {
    const root = mkdtempSync(join(tmpdir(), "rt-"));
    const dir = join(root, "pi", "1.5.0");
    mkdirSync(join(dir, "pi"), { recursive: true });
    writeFileSync(join(dir, "pi", "pi"), "");
    const store = new RuntimeStore(root);
    expect(store.installed("pi")).toBeUndefined();
    writeFileSync(join(dir, ".agentherd-ready"), "");
    expect(store.installed("pi")).toEqual({
      id: "pi",
      version: "1.5.0",
      path: join(dir, "pi", "pi"),
    });
    expect(store.installed("opencode")).toBeUndefined();
  });

  it("downloads, checks and unpacks a tar.gz and a zip", async () => {
    const tgz = fakeArchive("tar.gz", "9.9.9");
    const zip = fakeArchive("zip", "tool 9.9.9");
    const base = await serve({ "/a.tar.gz": tgz, "/a.zip": zip });
    const store = new RuntimeStore(mkdtempSync(join(tmpdir(), "rt-")));
    expect(store.installed("tool")).toBeUndefined();
    const progress: number[] = [];
    const first = await store.install(release(base, "/a.tar.gz", tgz), {
      onProgress: (p) => progress.push(p.received),
    });
    expect(first.path).toBe(join(store.dir("tool", "9.9.9"), "tool/tool"));
    expect(store.installed("tool")).toEqual(first);
    expect(progress.at(-1)).toBe(tgz.length);

    const next = await store.install(release(base, "/a.zip", zip, { version: "9.9.9" }));
    expect(next.version).toBe("9.9.9");
    const newer = fakeArchive("zip", "10.0.0");
    const base2 = await serve({ "/b.zip": newer });
    const updated = await store.install(release(base2, "/b.zip", newer, { version: "10.0.0" }));
    expect(store.installed("tool")).toEqual(updated);
    store.remove("tool");
    expect(store.installed("tool")).toBeUndefined();
  });

  it("refuses a download whose digest does not match", async () => {
    const tgz = fakeArchive("tar.gz", "9.9.9");
    const base = await serve({ "/a.tar.gz": tgz });
    const store = new RuntimeStore(mkdtempSync(join(tmpdir(), "rt-")));
    const bad = release(base, "/a.tar.gz", tgz, {
      digest: { algorithm: "sha256", encoding: "hex", value: "0".repeat(64) },
    });
    await expect(store.install(bad)).rejects.toThrow(/does not match its SHA256/);
    expect(store.installed("tool")).toBeUndefined();
  });

  it("refuses a build that reports another version", async () => {
    const tgz = fakeArchive("tar.gz", "1.0.0");
    const base = await serve({ "/a.tar.gz": tgz });
    const store = new RuntimeStore(mkdtempSync(join(tmpdir(), "rt-")));
    await expect(store.install(release(base, "/a.tar.gz", tgz))).rejects.toThrow(
      /reports version "1.0.0"/,
    );
  });

  it("needs npm for npm packages", async () => {
    const store = new RuntimeStore(mkdtempSync(join(tmpdir(), "rt-")));
    await expect(
      store.install({ kind: "npm", id: "x", version: "1.0.0", package: "x", executable: "i.js" }),
    ).rejects.toThrow(/npm is not available/);
  });
});

describe("catalog", () => {
  it("reads DeepSeek Harness's update feed with folded values", () => {
    const feed = [
      "version: 0.2.2-rc.1",
      "files:",
      "  - url: >-",
      "      https://download.example/dsh/deepseek-harness-0.2.2-rc.1-mac-arm64.zip",
      "    sha512: >-",
      "      abc+/==",
      "    size: 353501474",
      "path: >-",
      "  https://download.example/dsh/deepseek-harness-0.2.2-rc.1-mac-arm64.zip",
      "releaseDate: '2026-11-04T09:24:35.800Z'",
    ].join("\n");
    expect(parseDshFeed(feed, "https://download.example/feeds/nightly-mac.yml")).toEqual({
      version: "0.2.2-rc.1",
      url: "https://download.example/dsh/deepseek-harness-0.2.2-rc.1-mac-arm64.zip",
      sha512: "abc+/==",
      size: 353501474,
    });
  });

  it("runs scripts with Node and binaries directly, with the agent's ask-first env", () => {
    const def: AgentDef = {
      id: "codex",
      name: "Codex",
      envVar: "X",
      systemNames: [],
      acpArgs: [],
      env: { INITIAL_AGENT_MODE: "read-only" },
    };
    const script = agentProfile(def, "/r/node_modules/x/dist/index.js");
    expect(script.command).toEqual([process.execPath, "/r/node_modules/x/dist/index.js"]);
    expect(script.env).toMatchObject({ INITIAL_AGENT_MODE: "read-only" });
    const bin = agentProfile({ ...def, acpArgs: ["acp"] }, "/r/opencode");
    expect(bin.command).toEqual(["/r/opencode", "acp"]);
  });
});

describe("Codex with the Codex app's CLI", () => {
  const CLI = "C:\\Apps\\OpenAI.Codex\\app\\resources\\codex.exe";
  const codex: AgentDef = {
    id: "codex",
    name: "Codex",
    envVar: "AGENTHERD_CODEX",
    systemNames: [],
    acpArgs: [],
    env: {},
    latest: async () => ({
      kind: "npm",
      id: "codex",
      version: "2.5.0",
      package: "codex-acp",
      executable: "node_modules/codex-acp/dist/index.js",
    }),
    npm: true,
  };
  const fetchers = {
    json: async () => ({ version: "12.0.0", dist: { tarball: "t", integrity: "sha512-x" } }),
    text: async () => "",
  };

  async function installWith(codexApps: string[], env: NodeJS.ProcessEnv = {}) {
    const installed: Release[] = [];
    const store = {
      installed: () => undefined,
      install: async (r: Release) => {
        installed.push(r);
        return { id: r.id, version: r.version, path: r.id };
      },
    } as unknown as RuntimeStore;
    const agents = new Agents({
      store,
      env,
      catalog: [codex],
      fetchers,
      platform: "win32",
      exists: (p) => p === CLI,
      codexApps,
      onChange() {},
    });
    agents.install("codex");
    await agents.idle();
    return { agents, release: installed.find((r) => r.id === "codex") };
  }

  it("skips the CLI build npm would download and hands codex-acp the app's CLI", async () => {
    const { agents, release } = await installWith([CLI]);
    expect(release).toMatchObject({ kind: "npm", omitOptional: true });
    expect(agents.extraEnv("codex")).toEqual({ CODEX_PATH: CLI });
  });
  it("installs everything without the app, or when the owner names a CLI", async () => {
    expect((await installWith([])).release).not.toHaveProperty("omitOptional");
    const own = await installWith([CLI], { CODEX_PATH: "C:\\mine\\codex.exe" });
    expect(own.release).not.toHaveProperty("omitOptional");
  });
});

function testCatalog(rel: () => ArchiveRelease): AgentDef[] {
  return [
    {
      id: "tool",
      name: "Tool",
      envVar: "AGENTHERD_TOOL",
      systemNames: ["tool"],
      acpArgs: ["acp"],
      env: {},
      latest: async () => rel(),
    },
    { id: "app-only", name: "App only", envVar: "X_APP", systemNames: [], acpArgs: [], env: {} },
  ];
}

function makeHost(home: string, catalog: AgentDef[], extra: { script?: string } = {}) {
  return new Host({
    home,
    userHome: home,
    secrets: { get: () => undefined, set() {}, delete() {} },
    env: { PATH: "" },
    createChannel: () => new FakeChannel(),
    runtimes: new RuntimeStore(join(home, "runtimes")),
    catalog,
    exists: () => false,
    ...extra,
  });
}

describe("Host agents", () => {
  it("downloads the latest release from the GUI; removing it takes it away", async () => {
    const tgz = fakeArchive("tar.gz", "9.9.9");
    const base = await serve({ "/a.tar.gz": tgz });
    const home = mkdtempSync(join(tmpdir(), "ah-"));
    writeConfig(home, { channel: { channelId: "fake", ownerId: "owner", data: {} } });
    const events: HostEvent[] = [];
    const host = makeHost(
      home,
      testCatalog(() => release(base, "/a.tar.gz", tgz)),
    );
    host.onEvent((e) => events.push(e));
    await host.start();
    try {
      expect(host.agents().map((a) => [a.id, a.state, a.canInstall])).toEqual([
        ["tool", "missing", true],
        ["app-only", "missing", false],
      ]);
      expect(host.installAgent("tool").find((a) => a.id === "tool")?.state).toBe("installing");
      await host.agentsIdle();
      expect(host.agents().find((a) => a.id === "tool")).toMatchObject({
        state: "ready",
        source: "managed",
        version: "9.9.9",
        canRemove: true,
        canInstall: true,
      });
      expect(events.some((e) => e.topic === "agents")).toBe(true);

      host.removeAgent("tool");
      expect(host.agents().find((a) => a.id === "tool")?.state).toBe("missing");
      expect(() => host.removeAgent("app-only")).toThrow(/not downloaded/);
      expect(() => host.installAgent("app-only")).toThrow(/cannot download/);
    } finally {
      await host.stop();
    }
  });

  it("shows a failed download and lets the owner try again", async () => {
    const base = await serve({});
    const tgz = fakeArchive("tar.gz", "9.9.9");
    const home = mkdtempSync(join(tmpdir(), "ah-"));
    const host = makeHost(
      home,
      testCatalog(() => release(base, "/missing.tar.gz", tgz)),
    );
    host.installAgent("tool");
    await host.agentsIdle();
    expect(host.agents().find((a) => a.id === "tool")).toMatchObject({
      state: "missing",
      canInstall: true,
      error: expect.stringMatching(/HTTP 404/),
    });
    await host.stop();
  });

  it("checks an agent by starting it and opening a session", async () => {
    const home = mkdtempSync(join(tmpdir(), "ah-"));
    const host = makeHost(home, [], { script: SCRIPT });
    await host.start();
    try {
      const check = await host.verifyAgent("mock");
      expect(check).toMatchObject({ id: "mock", ok: true, needsLogin: false });
      expect(await host.verifyAgent("nope")).toMatchObject({ ok: false, error: "not installed" });
    } finally {
      await host.stop();
    }
  });
});

describe("verifyProfile", () => {
  it("reports a CLI that exits at once, with its stderr", async () => {
    const check = await verifyProfile({
      id: "broken",
      name: "Broken",
      command: ["/bin/sh", "-c", "echo 'please run login first' >&2; exit 3"],
      env: {},
      exporter: null,
    });
    expect(check.ok).toBe(false);
    expect(check.needsLogin).toBe(true);
    expect(check.error).toMatch(/login/);
  });

  it("gives up after the timeout", async () => {
    const check = await verifyProfile(
      { id: "slow", name: "Slow", command: ["/bin/sleep", "30"], env: {}, exporter: null },
      { timeoutMs: 300 },
    );
    expect(check).toMatchObject({ ok: false, error: expect.stringMatching(/no answer within/) });
  });
});
