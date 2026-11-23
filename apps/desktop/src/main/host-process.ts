// Starts the host in an Electron utility process unless one already answers on the socket
// (e.g. `agentherd start` in a terminal). Node in Electron strips TypeScript types, so the host
// runs from its sources like the CLI does.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isHostRunning } from "@agentherd/host/server";
import { app, type UtilityProcess, utilityProcess } from "electron";

let child: UtilityProcess | undefined;

/**
 * The host's sources: in the packaged app under Resources/host/packages (scripts/package-mac.ts,
 * laid out like the repo so the host finds pi-acp beside it), in development the repo's.
 */
function hostEntry(): string {
  if (process.env.AGENTHERD_HOST_ENTRY !== undefined) return process.env.AGENTHERD_HOST_ENTRY;
  return app.isPackaged
    ? join(process.resourcesPath, "host", "packages", "host", "bin", "host.ts")
    : resolve(app.getAppPath(), "../../packages/host/bin/host.ts");
}

/**
 * The agents that ship with the app (ADR 0067): Resources/agents, or in development the folder
 * `pnpm --filter @agentherd/desktop fetch-agents` fills, when it exists.
 */
export function agentsDir(): string | undefined {
  if (process.env.AGENTHERD_AGENTS !== undefined) return process.env.AGENTHERD_AGENTS;
  const dir = app.isPackaged
    ? join(process.resourcesPath, "agents")
    : resolve(app.getAppPath(), "agents");
  return existsSync(dir) ? dir : undefined;
}

export async function ensureHost(home: string, sock: string): Promise<void> {
  if (await isHostRunning(sock)) return;
  if (child === undefined) {
    const logDir = join(home, "logs");
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const logFile = join(logDir, "host.log");
    const agents = agentsDir();
    const p = utilityProcess.fork(hostEntry(), [], {
      serviceName: "AgentHerd host",
      stdio: "pipe",
      // The host resolves the data location itself, under its own lease.
      env: {
        ...process.env,
        ...(agents === undefined ? {} : { AGENTHERD_AGENTS: agents }),
      },
    });
    const log = (chunk: Buffer) => {
      process.stdout.write(chunk);
      appendFileSync(logFile, chunk);
    };
    p.stdout?.on("data", log);
    p.stderr?.on("data", log);
    p.on("exit", (code) => {
      console.error(`[desktop] host exited with code ${code}`);
      if (child === p) child = undefined;
    });
    child = p;
  }
  for (let i = 0; i < 100; i++) {
    if (await isHostRunning(sock)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`the host did not start within 15 s; see ${join(home, "logs", "host.log")}`);
}

/** How long the host gets to stop by itself before it is killed. */
export const HOST_STOP_MS = 8000;

export function ownsHost(): boolean {
  return child !== undefined;
}

/**
 * Asks the host to stop (it ends its tasks and tells the owner), then kills it if it is still
 * running after `HOST_STOP_MS`. On Windows `kill()` ends the process at once, so the message
 * is the only way the host gets to clean up.
 */
export function stopOwnedHost(timeoutMs = HOST_STOP_MS): Promise<void> {
  const p = child;
  child = undefined;
  if (p === undefined) return Promise.resolve();
  return new Promise((done) => {
    const timer = setTimeout(() => {
      p.kill();
      done();
    }, timeoutMs);
    p.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    try {
      p.postMessage({ type: "stop" });
    } catch {
      clearTimeout(timer);
      p.kill();
      done();
    }
  });
}
