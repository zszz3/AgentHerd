import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { expect, it } from "vitest";
import { runSearchFixture, SearchFixtureStillRunning } from "./search-fixture.js";

const lamp = { homeId: "fictional-home", deviceId: "fictional-lamp", siid: 2 };
const power = { kind: "property", ...lamp, piid: 1, value: true };

it.each(["retire-before-grant", "lose-utility", "boundary"])(
  "native desktop: %s",
  async (scenario) => {
    const src = join(import.meta.dirname, "../src");
    const boundary = join(src, "main/mijia-desktop.ts");
    expect(existsSync(boundary), "private desktop boundary").toBe(true);
    const out = mkdtempSync(join(tmpdir(), "agentherd-mijia-native-"));
    let safeToRemove = true;
    try {
      await build({
        configFile: false,
        logLevel: "silent",
        build: {
          outDir: out,
          lib: {
            entry: { preload: join(src, "preload/index.ts"), boundary },
            formats: ["cjs"],
            fileName: (_format, name) => `${name}.cjs`,
          },
          rollupOptions: { external: (id) => id === "electron" || id.startsWith("node:") },
        },
      });
      const require = createRequire(import.meta.url);
      await build({
        configFile: false,
        logLevel: "silent",
        mode: "production",
        define: { "process.env.NODE_ENV": '"production"' },
        esbuild: { jsx: "automatic", jsxDev: false },
        resolve: {
          alias: [
            {
              find: "react/jsx-dev-runtime",
              replacement: require.resolve("react/jsx-dev-runtime"),
            },
            { find: "react/jsx-runtime", replacement: require.resolve("react/jsx-runtime") },
            { find: "react-dom/client", replacement: require.resolve("react-dom/client") },
            { find: /^react-dom$/, replacement: require.resolve("react-dom") },
            { find: /^react$/, replacement: require.resolve("react") },
          ],
        },
        build: {
          outDir: out,
          emptyOutDir: false,
          lib: {
            entry: join(import.meta.dirname, "fixtures/mijia-renderer.tsx"),
            name: "MijiaFixture",
            formats: ["iife"],
            fileName: () => "panel.js",
          },
        },
      });
      const electron: string =
        process.env.AGENTHERD_TEST_ELECTRON ?? createRequire(import.meta.url)("electron");
      const result = await runSearchFixture(
        electron,
        [join(import.meta.dirname, "fixtures/mijia-desktop.cjs"), out, scenario],
        {
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          PATH: process.env.PATH,
        },
        35_000,
      );
      if (scenario === "retire-before-grant") {
        expect(result).toEqual({
          result: { state: "not-sent", reason: "cancelled" },
          denied: true,
          staleProposal: "not-sent",
          mutations: [],
        });
      } else if (scenario === "lose-utility") {
        expect(result).toEqual({
          beforeReload: [power],
          mutations: [power],
          stalePreview: false,
          newSelection: "",
          warningAfterReload: false,
        });
      } else {
        expect(result).toEqual({
          external: false,
          wrongWindow: false,
          old: "not-sent",
          cancelled: 0,
          crossed: 0,
          beforeConfirm: 0,
          mutations: [
            power,
            { kind: "property", ...lamp, piid: 2, value: 40 },
            { kind: "property", ...lamp, piid: 3, value: 2 },
            { kind: "action", ...lamp, aiid: 1, inputs: [1, true] },
            { kind: "scene", homeId: "fictional-home", sceneId: "fictional-scene" },
            power,
          ],
        });
      }
    } catch (error) {
      if (error instanceof SearchFixtureStillRunning) safeToRemove = false;
      throw error;
    } finally {
      if (safeToRemove) rmSync(out, { recursive: true, force: true });
    }
  },
  55_000,
);
