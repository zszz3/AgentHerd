// Fetches the agents that ship inside the app (ADR 0067) into a folder in RuntimeStore layout
// (<id>/<version>/ and <id>/current.json), at the versions in catalog.ts, checking the
// publisher's digest. `pnpm --filter @agentherd/desktop fetch-agents [dir]`; the default dir,
// apps/desktop/agents, is what development and scripts/package-mac.ts read. Builds for this
// computer's platform only: npm installs the Codex CLI for the platform it runs on.

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGENTS,
  currentTarget,
  httpFetchers,
  npmRuntime,
  type Release,
  RuntimeStore,
} from "@agentherd/host";

import { desktopFetchers } from "./pi-desktop-release.ts";

export function bundledAgents() {
  return AGENTS.filter((def) => def.release !== undefined && def.onRequest !== true);
}

export async function fetchAgents(dir: string): Promise<void> {
  const target = currentTarget();
  const store = new RuntimeStore(dir);
  const tools = new RuntimeStore(join(tmpdir(), "agentherd-build-tools"));
  // Agents downloaded on the owner's computer (ADR 0069) stay out of the app.
  for (const def of bundledAgents()) {
    const done = store.installed(def.id);
    const complete = (def.requires?.(target) ?? []).every((file) =>
      existsSync(join(store.dir(def.id, done?.version ?? ""), file)),
    );
    if (done !== undefined && done.version === def.version && complete) {
      console.log(`[agents] ${def.id} ${done.version} already in ${dir}`);
      continue;
    }
    const release = await def.release?.(target, desktopFetchers);
    if (release === undefined) throw new Error(`${def.name} has no build for ${target}`);
    let npmCli: string | undefined;
    if (release.kind === "npm") {
      npmCli = (await tools.install(await npmRuntime(httpFetchers))).path;
    }
    // Every file the agent needs, the platform CLI npm may skip included (catalog requires).
    const full: Release =
      release.kind === "npm" && def.requires !== undefined
        ? { ...release, requires: def.requires(target) }
        : release;
    console.log(`[agents] fetching ${def.id} ${release.version} for ${target}`);
    const installed = await store.install(full, npmCli === undefined ? {} : { npmCli });
    console.log(`[agents] ${def.id} ${installed.version} at ${installed.path}`);
  }
}

if (import.meta.main) {
  await fetchAgents(resolve(process.argv[2] ?? join(import.meta.dirname, "..", "agents")));
}
