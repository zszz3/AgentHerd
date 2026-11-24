import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "electron-vite";
import { expect, test } from "vitest";
import { runSearchFixture, SearchFixtureStillRunning } from "./search-fixture.ts";

test.skipIf(process.platform !== "win32" && process.platform !== "darwin")(
  "copies on a second desktop lifecycle and the CLI uses the same directory",
  async () => {
    const desktop = resolve(import.meta.dirname, "..");
    const repo = resolve(desktop, "../..");
    const profile = mkdtempSync(
      join(
        realpathSync.native(process.platform === "win32" ? homedir() : tmpdir()),
        "herd-desktop-location-",
      ),
    );
    let safeToRemove = true;
    try {
      const home = join(profile, ".agentherd");
      const parent = join(profile, "new parent");
      const target = join(parent, "AgentHerd");
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
      expect(await launch("first")).toMatchObject({
        view: { home },
        host: home,
        change: { ok: true, state: "restarting" },
        relaunch: true,
      });
      const before = readFileSync(join(home, "herd.db"));
      const second = (await launch("second")) as { painted: string };
      expect(second).toMatchObject({ view: { state: "ready", home: target }, host: target });
      // The first paint after relaunch is the static moving shell, not the main UI.
      expect(second.painted).toContain("正在处理数据目录");
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
