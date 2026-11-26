import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// Workspace packages are TypeScript sources; bundle the parts main needs instead of
// externalizing them. The host itself runs as a separate process (src/main/host-process.ts).
const bundled = ["@agentherd/host"];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundled })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, "src/main/index.ts"),
          "data-directory-worker": resolve(
            import.meta.dirname,
            "src/main/data-directory-worker.ts",
          ),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: bundled })],
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, "src/preload/index.ts") },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, "src/renderer"),
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, "src/renderer/index.html"),
          // The desktop pet window (ADR 0070).
          pet: resolve(import.meta.dirname, "src/renderer/pet.html"),
        },
      },
    },
  },
});
