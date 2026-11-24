// Run after staging DWS on a clean Windows runner. No accounts, OAuth, or network calls.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDws } from "../packages/host/src/dingtalk-cli.ts";

if (process.platform !== "win32") throw new Error("Requires Windows");
const executable = fileURLToPath(new URL("../apps/desktop/dws/dws.exe", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "agentherd-dws-write-"));
const stdin = JSON.stringify({
  presetId: "G02",
  specVersion: "1.0",
  title: "Fixture",
  data: {
    kind: "category",
    categories: ["A", "B"],
    series: [{ name: "Sample", unit: "items", values: [2, 3] }],
  },
});
try {
  for (const mode of ["direct", "adapter"]) {
    const stateDir = join(root, mode);
    await mkdir(stateDir);
    const args = ["aicard", "chart", "build", "--file=-", "--out=chart.json", "--format=json"];
    let stage = "invoke";
    try {
      if (mode === "direct") {
        const result = spawnSync(executable, args, {
          cwd: stateDir,
          encoding: "utf8",
          input: stdin,
          env: {
            ...process.env,
            DWS_CONFIG_DIR: join(stateDir, "config"),
            DWS_KEYCHAIN_DIR: join(stateDir, "credentials"),
          },
          timeout: 30000,
          windowsHide: true,
        });
        if (result.error || result.status !== 0) throw new Error("CLI failed");
      } else {
        await runDws({ executable, stateDir }, { args, stdin }, AbortSignal.timeout(30000), true);
      }
      stage = "verify-output";
      const chart = JSON.parse(await readFile(join(stateDir, "chart.json"), "utf8"));
      if (!Array.isArray(chart) || chart.length === 0) throw new Error("No chart");
      console.log(`${mode}: verified synthetic chart write`);
    } catch {
      console.error(`${mode}: failed at ${stage}`);
      process.exitCode = 1;
    }
  }
  // Match upstream's future-profile preflight fixture. It rejects before remote authorization.
  const authDir = join(root, "auth-preflight");
  const config = join(authDir, "config");
  await mkdir(config, { recursive: true });
  await writeFile(join(config, "profiles.json"), JSON.stringify({ version: 99999 }));
  const preflight = spawnSync(executable, ["auth", "login", "--no-browser", "--format=json"], {
    cwd: authDir,
    encoding: "utf8",
    env: {
      ...process.env,
      DWS_CONFIG_DIR: config,
      DWS_KEYCHAIN_DIR: join(authDir, "credentials"),
      DO_NOT_TRACK: "1",
    },
    timeout: 15000,
    windowsHide: true,
  });
  if (
    preflight.error ||
    preflight.status !== 2 ||
    !preflight.stderr.includes("newer than supported") ||
    !(await stat(join(config, ".data.lock"))).isFile()
  ) {
    throw new Error("Login did not acquire the private config lock and reject the future profile");
  }
  console.log(
    "auth: verified official preflight obtained its private lock before rejecting the synthetic profile",
  );
} finally {
  // mkdtemp created this private directory for this invocation only.
  // The upstream sender may hold its working directory for up to six seconds after CLI exit.
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
