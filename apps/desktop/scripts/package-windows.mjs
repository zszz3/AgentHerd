// Run on a Windows x64 PR runner after the desktop build and fetch-dws steps.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";

if (
  process.platform !== "win32" ||
  process.arch !== "x64" ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
  process.env.GITHUB_EVENT_NAME !== "pull_request"
) {
  throw new Error("Build this unsigned candidate only on a Windows x64 pull request runner");
}
const desktop = resolve(import.meta.dirname, "..");
const repo = resolve(desktop, "../..");
const output = join(repo, "dist/windows");
const compiler = "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe";
const temp = mkdtempSync(join(process.env.RUNNER_TEMP, "ah-"));
const image = join(temp, "app");
const resources = join(image, "resources");
const host = join(resources, "host");
const version = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")).version;

function copyTree(from, to, filter) {
  cpSync(from, to, { recursive: true, dereference: true, filter });
}

// The host, its MCP relay and Pi bridge find each other by import.meta.url. Keep that layout;
// use JS re-exports, not junctions, to expose workspace TS from outside node_modules.
function packHost() {
  const deploy = join(temp, "deploy");
  execFileSync(
    process.env.ComSpec,
    [
      "/d",
      "/s",
      "/c",
      'pnpm --filter @agentherd/host deploy --legacy --prod --config.node-linker=hoisted --prefer-offline "%AH_DEPLOY%"',
    ],
    {
      cwd: repo,
      env: { ...process.env, AH_DEPLOY: deploy },
      stdio: "inherit",
      windowsVerbatimArguments: true,
    },
  );
  const modules = join(deploy, "node_modules");
  const scope = join(modules, "@agentherd");
  const installed = join(host, "node_modules");
  const onnx = join(modules, "onnxruntime-node", "bin", "napi-v3");
  // .bin shims and pnpm install metadata can contain absolute build paths. Nothing runs them.
  copyTree(
    modules,
    installed,
    (p) =>
      p !== scope &&
      (dirname(p) !== onnx || basename(p) === "win32") &&
      (dirname(p) !== join(onnx, "win32") || basename(p) === "x64") &&
      ![".bin", ".modules.yaml", ".pnpm", ".pnpm-workspace-state-v1.json"].includes(basename(p)),
  );
  for (const name of ["host", ...readdirSync(scope)]) {
    const source = name === "host" ? deploy : join(scope, name);
    const dest = join(host, "packages", name);
    mkdirSync(dest, { recursive: true });
    for (const part of ["src", "bin", "extension", "LICENSE", "package.json"]) {
      if (existsSync(join(source, part))) copyTree(join(source, part), join(dest, part));
    }
    // Preserve conflicting third-party versions nested by the hoisted deploy.
    if (name !== "host" && existsSync(join(source, "node_modules"))) {
      copyTree(
        join(source, "node_modules"),
        join(dest, "node_modules"),
        (p) => basename(p) !== ".bin" && basename(p) !== "@agentherd",
      );
    }
    const shim = join(installed, "@agentherd", name);
    mkdirSync(shim, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(dest, "package.json"), "utf8"));
    const exports = {};
    for (const [key, target] of Object.entries(manifest.exports)) {
      const file = `entry-${Object.keys(exports).length}.mjs`;
      exports[key] = `./${file}`;
      writeFileSync(
        join(shim, file),
        `export * from "../../../packages/${name}/${target.slice(2)}";\n`,
      );
    }
    writeFileSync(join(shim, "package.json"), JSON.stringify({ name: manifest.name, exports }));
  }
}

async function packAgents() {
  const { fetchAgents } = await import("./fetch-agents.ts");
  await fetchAgents(join(resources, "agents"));
}

try {
  const require = createRequire(import.meta.url);
  copyTree(dirname(require("electron")), image);
  renameSync(join(image, "electron.exe"), join(image, "AgentHerd.exe"));
  rmSync(join(resources, "default_app.asar"), { force: true });
  const app = join(resources, "app");
  copyTree(join(desktop, "out"), join(app, "out"));
  copyTree(join(desktop, "resources"), join(app, "resources"));
  writeFileSync(
    join(app, "package.json"),
    JSON.stringify({
      name: "agentherd",
      productName: "AgentHerd",
      version,
      type: "module",
      main: "./out/main/index.js",
    }),
  );
  mkdirSync(join(resources, "dws"));
  for (const file of ["dws.exe", "LICENSE", "NOTICE"]) {
    copyFileSync(join(desktop, "dws", file), join(resources, "dws", file));
  }
  await packAgents();
  packHost();
  mkdirSync(output, { recursive: true });
  execFileSync(
    compiler,
    [
      `/DImageDir=${image}`,
      `/DAppVersion=${version}`,
      `/O${output}`,
      join(import.meta.dirname, "package-windows.iss"),
    ],
    { stdio: "inherit" },
  );
  console.log(join(output, "AgentHerd-Setup-x64.exe"));
} finally {
  rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
}
