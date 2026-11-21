import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import { it } from "vitest";

it("opens Tasks and Cards from the visible controls on either dock edge", async () => {
  const fixture = join(import.meta.dirname, "fixtures/pet-dock");
  const out = mkdtempSync(join(tmpdir(), "herd-pet-controls-"));
  try {
    await build({
      configFile: false,
      root: fixture,
      plugins: [react()],
      logLevel: "silent",
      build: { outDir: out, emptyOutDir: true },
      base: "./",
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const electron: string =
      process.env.AGENTHERD_TEST_ELECTRON ?? createRequire(import.meta.url)("electron");
    await promisify(execFile)(electron, [join(fixture, "run.cjs"), join(out, "index.html")], {
      env,
      timeout: 15_000,
    });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 20_000);
