// Builds AgentHerd.app and a .dmg for this Mac's architecture, with Pi and Codex inside (ADR 0067).
// Not signed or notarized yet (M5): the app is signed ad hoc, so macOS asks once before opening a
// downloaded copy (right-click → 打开). `pnpm --filter @agentherd/desktop package:mac`.
//
// AgentHerd.app/Contents/Resources/
//   app/     Electron main, preload and renderer (electron-vite build) and the icon
//   host/    the host's TypeScript sources, laid out like the repo (packages/<name>), with the npm
//            packages they use in host/node_modules; Electron's Node strips the types, which it
//            refuses to do under node_modules, so workspace packages are links there
//   agents/  Pi and Codex at the versions AgentHerd is adapted to (scripts/fetch-agents.ts)

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { arch } from "node:os";
import { dirname, join, relative } from "node:path";
import { fetchAgents } from "./fetch-agents.ts";

const NAME = "AgentHerd";
const BUNDLE_ID = "com.agentherd.desktop";
const desktop = join(import.meta.dirname, "..");
const repo = join(desktop, "..", "..");
const version = (
  JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")) as {
    version: string;
  }
).version;
const out = join(desktop, "release", `mac-${arch()}`);
const appDir = join(out, `${NAME}.app`);
const resources = join(appDir, "Contents", "Resources");

function run(cmd: string, args: string[], cwd = desktop): void {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function plist(key: string, value: string): void {
  run("plutil", ["-replace", key, "-string", value, join(appDir, "Contents", "Info.plist")]);
}

/** A macOS icon set from the 1024 px PNG. */
function makeIcns(png: string, icns: string): void {
  const set = join(out, "icon.iconset");
  rmSync(set, { recursive: true, force: true });
  mkdirSync(set);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = String(size * scale);
      const name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
      execFileSync("sips", ["-z", px, px, png, "--out", join(set, name)], { stdio: "ignore" });
    }
  }
  run("iconutil", ["-c", "icns", set, "-o", icns]);
  rmSync(set, { recursive: true, force: true });
}

/**
 * The host and the npm packages it uses: `pnpm deploy` gives the host with a flat node_modules;
 * the workspace packages in it move to packages/ and are linked back.
 */
function packHost(dest: string): void {
  const staging = join(out, "host-deploy");
  rmSync(staging, { recursive: true, force: true });
  // `pnpm deploy --prod` records its settings as the workspace's install state, after which every
  // pnpm command wants to reinstall the workspace with --prod. Put the state back afterwards.
  const state = join(repo, "node_modules", ".pnpm-workspace-state-v1.json");
  const saved = existsSync(state) ? readFileSync(state) : undefined;
  try {
    run(
      "pnpm",
      [
        "--filter",
        "@agentherd/host",
        "deploy",
        "--legacy",
        "--prod",
        "--config.node-linker=hoisted",
        "--prefer-offline",
        staging,
      ],
      repo,
    );
  } finally {
    if (saved !== undefined) writeFileSync(state, saved);
  }
  const packages = join(dest, "packages");
  mkdirSync(packages, { recursive: true });
  const modules = join(staging, "node_modules");
  renameSync(modules, join(dest, "node_modules"));
  renameSync(staging, join(packages, "host"));
  const scope = join(dest, "node_modules", "@agentherd");
  for (const name of readdirSync(scope)) {
    renameSync(join(scope, name), join(packages, name));
    symlinkSync(relative(scope, join(packages, name)), join(scope, name));
  }
  // Tests are not shipped; neither are onnxruntime builds for other systems (about 140 MB).
  for (const name of readdirSync(packages)) {
    for (const extra of ["test", "tests", "tsconfig.json"]) {
      rmSync(join(packages, name, extra), { recursive: true, force: true });
    }
  }
  const onnx = join(dest, "node_modules", "onnxruntime-node", "bin", "napi-v3");
  if (existsSync(onnx)) {
    for (const os of readdirSync(onnx)) {
      if (os !== "darwin") rmSync(join(onnx, os), { recursive: true, force: true });
    }
  }
}

if (process.platform !== "darwin") throw new Error("package-mac builds on macOS only");

run("pnpm", ["run", "build"]);
const agents = join(desktop, "agents");
await fetchAgents(agents);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const require = createRequire(import.meta.url);
require("electron");
const electron = dirname(require.resolve("electron/package.json"));
run("ditto", [join(electron, "dist", "Electron.app"), appDir]);

rmSync(join(resources, "default_app.asar"), { force: true });
const app = join(resources, "app");
mkdirSync(app);
cpSync(join(desktop, "out"), join(app, "out"), { recursive: true });
cpSync(join(desktop, "resources"), join(app, "resources"), { recursive: true });
writeFileSync(
  join(app, "package.json"),
  `${JSON.stringify({ name: "agentherd", productName: NAME, version, type: "module", main: "./out/main/index.js" }, null, 2)}\n`,
);
packHost(join(resources, "host"));
run("ditto", [agents, join(resources, "agents")]);

makeIcns(join(desktop, "resources", "icon.png"), join(resources, "icon.icns"));
plist("CFBundleName", NAME);
plist("CFBundleDisplayName", NAME);
plist("CFBundleIdentifier", BUNDLE_ID);
plist("CFBundleIconFile", "icon.icns");
// Electron reports app.isPackaged only when the executable is not called Electron.
renameSync(join(appDir, "Contents", "MacOS", "Electron"), join(appDir, "Contents", "MacOS", NAME));
plist("CFBundleExecutable", NAME);
plist("CFBundleShortVersionString", version);
plist("CFBundleVersion", version);
// Notifications stay until answered and can carry 同意 / 拒绝 buttons (ADR 0079).
plist("NSUserNotificationAlertStyle", "alert");
rmSync(join(resources, "electron.icns"), { force: true });

// The edits above break Electron's signature; sign the whole bundle again, ad hoc.
run("codesign", ["--force", "--deep", "--sign", "-", appDir]);

const stage = join(out, "dmg");
mkdirSync(stage);
run("ditto", [appDir, join(stage, `${NAME}.app`)]);
symlinkSync("/Applications", join(stage, "Applications"));
const dmg = join(desktop, "release", `${NAME}-${version}-${arch()}.dmg`);
rmSync(dmg, { force: true });
run("hdiutil", ["create", "-volname", NAME, "-srcfolder", stage, "-ov", "-format", "UDZO", dmg]);
rmSync(stage, { recursive: true, force: true });
console.log(`\n${appDir}\n${dmg}`);
