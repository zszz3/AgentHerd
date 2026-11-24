// On the disposable runner only. Inspect installed files; make one read-only local pipe call.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CODEX_ACP_VERSION, codexNativeBinary, PI_VERSION } from "../packages/host/src/catalog.ts";
import { connectHost, socketPath } from "../packages/host/src/server.ts";

if (
  process.platform !== "win32" ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.RUNNER_ENVIRONMENT !== "github-hosted"
) {
  throw new Error("Requires a disposable GitHub-hosted Windows Actions runner");
}
const [home, resources] = process.argv.slice(2);
const target = `win32-${process.arch}`;
const native = codexNativeBinary(target);
assert.ok(native.length > 0, "No native Codex entry for this Windows target");
function checkAgent(id, version, executable, required = []) {
  const root = join(resources, "agents", id);
  const current = JSON.parse(readFileSync(join(root, "current.json"), "utf8"));
  assert.equal(current.version, version, `Wrong installed ${id} version`);
  assert.equal(current.executable, executable, `Wrong installed ${id} entry`);
  const dir = join(root, version);
  assert.equal(readFileSync(join(dir, ".agentherd-ready"), "utf8").trim(), version);
  for (const path of [executable, ...required]) {
    const file = statSync(join(dir, path));
    assert.ok(file.isFile() && file.size > 0, `Missing or empty installed ${id} file: ${path}`);
  }
}
assert.deepEqual(
  readdirSync(join(resources, "agents")).sort(),
  ["codex", "pi"],
  "Unexpected shipped agents",
);
checkAgent("pi", PI_VERSION, "pi.exe");
checkAgent(
  "codex",
  CODEX_ACP_VERSION,
  "node_modules/@agentclientprotocol/codex-acp/dist/index.js",
  native,
);
for (const entry of ["dws.exe", "LICENSE", "NOTICE"]) {
  const file = statSync(join(resources, "dws", entry));
  assert.ok(file.isFile() && file.size > 0, `Missing or empty installed DWS file: ${entry}`);
}
console.log("Installed Pi, Codex (adapter and native CLI), and DWS files present");

// Never print the view, RPC error, CLI output or any account information.
const timer = setTimeout(() => {
  console.error("Local DingTalk status timed out");
  process.exit(1);
}, 40_000);
let client;
try {
  client = await connectHost(socketPath(home));
  const view = await client.host.dingtalk();
  if (view?.state !== "disconnected") throw new Error();
  console.log("Installed host.dingtalk() returned disconnected in the fresh profile");
} catch {
  console.error("Expected a disconnected DingTalk state from the installed host");
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  client?.close();
}
