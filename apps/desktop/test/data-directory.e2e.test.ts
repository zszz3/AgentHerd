import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hostDataPaths } from "@agentherd/host/data-home-paths";
import { socketPath } from "@agentherd/host/server";
import { build } from "electron-vite";
import { expect, test } from "vitest";
import { runSearchFixture, SearchFixtureStillRunning } from "./search-fixture.ts";

/** macOS `sun_path` holds 104 bytes including the terminating NUL (location-target.ts). */
const MAX_MAC_SOCKET_BYTES = 103;

test.skipIf(process.platform !== "win32" && process.platform !== "darwin")(
  "copies on a second desktop lifecycle and the CLI uses the same directory",
  async () => {
    const desktop = resolve(import.meta.dirname, "..");
    const repo = resolve(desktop, "../..");
    // Short names: macOS temp folders are long, and both sockets must fit in `sun_path`.
    const profile = mkdtempSync(
      join(realpathSync.native(process.platform === "win32" ? homedir() : tmpdir()), "ah-"),
    );
    let safeToRemove = true;
    try {
      const home = join(profile, ".agentherd");
      const parent = join(profile, "a b");
      const target = join(parent, "AgentHerd");
      if (process.platform === "darwin") {
        for (const dir of [home, target]) {
          for (const sock of [socketPath(dir), join(dir, hostDataPaths.mcpSocket.relative)]) {
            expect(Buffer.byteLength(sock, "utf8"), sock).toBeLessThanOrEqual(MAX_MAC_SOCKET_BYTES);
          }
        }
      }
      const inert = "{}\n";
      mkdirSync(home, { mode: 0o700 });
      mkdirSync(parent, { mode: 0o700 });
      writeFileSync(join(home, "secrets.json"), inert, { mode: 0o600 });
      const env = { ...process.env, HOME: profile, USERPROFILE: profile };
      for (const key of Object.keys(env)) {
        if (
          key.startsWith("AGENTHERD_") ||
          key === "ELECTRON_RUN_AS_NODE" ||
          key === "ELECTRON_RENDERER_URL"
        )
          delete env[key];
      }
      env.AGENTHERD_HOST_ENTRY = join(repo, "packages/host/bin/host.ts");
      await build({ root: desktop, mode: "production", logLevel: "error" });
      const electron: string =
        process.env.AGENTHERD_TEST_ELECTRON ?? createRequire(import.meta.url)("electron");
      const launch = (phase: string) =>
        runSearchFixture(
          electron,
          [
            join(import.meta.dirname, "fixtures/data-directory.cjs"),
            desktop,
            profile,
            parent,
            phase,
          ],
          env,
          35_000,
        );
      const first = (await launch("first")) as { painted: string; copied: number };
      expect(first).toMatchObject({
        view: { state: "ready", home },
        host: home,
        copied: 0,
        change: { ok: true, state: "restarting" },
        relaunch: true,
      });
      // A normal start paints a neutral screen: no move is pending, so none is shown.
      expect(first.painted).toContain("正在启动 AgentHerd");
      expect(first.painted).not.toContain("正在处理数据目录");
      const before = readFileSync(join(home, "herd.db"));
      const second = (await launch("second")) as { painted: string; copied: number };
      expect(second).toMatchObject({ view: { state: "ready", home: target }, host: target });
      // The relaunch paints the start screen, not the main UI, before the copy begins, and the
      // window then receives the copy's progress.
      expect(second.painted).toContain("正在启动 AgentHerd");
      expect(second.copied).toBeGreaterThan(0);
      // A row that exists only in the target database proves the CLI reads the target.
      const marker = "data-directory-e2e-marker";
      const db = new DatabaseSync(join(target, "herd.db"));
      try {
        db.prepare(
          "INSERT INTO decisions(item_id, action, source, reason, confidence, risk, precedents_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run("e2e", "escalate", "guard", marker, 1, "low", "[]", new Date().toISOString());
      } finally {
        db.close();
      }
      const cli = spawnSync(
        process.execPath,
        [join(repo, "packages/cli/bin/agentherd.ts"), "status"],
        { env, input: "", encoding: "utf8", timeout: 10_000 },
      );
      expect(cli.status, cli.stderr).toBe(0);
      expect(cli.stdout).toContain(marker);
      expect(readFileSync(join(home, "herd.db"))).toEqual(before);
      expect(readFileSync(join(target, "secrets.json"), "utf8")).toBe(inert);
      expect(readFileSync(join(home, "secrets.json"), "utf8")).toBe(inert);
    } catch (error) {
      if (error instanceof SearchFixtureStillRunning) safeToRemove = false;
      throw error;
    } finally {
      if (safeToRemove) rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    }
  },
  100_000,
);
