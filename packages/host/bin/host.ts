#!/usr/bin/env node
// The AgentHerd host process: `node packages/host/bin/host.ts`. The desktop app starts the same
// thing in an Electron utility process.

import {
  acquireLocationLease,
  type LocationLease,
  locationContext,
  type RunningHost,
  resolveLocation,
  runHost,
} from "../src/index.ts";

/** The message port of an Electron utility process; absent under plain Node. */
interface ParentPort {
  on(event: "message", listener: (message: { data: unknown }) => void): void;
}

// Hold the shared lease from before resolving until the host has stopped, so a location change
// cannot start while this process may write. After a failure that may leave partial resources
// running, exit instead of releasing: the OS releases the lease with the process.
const ctx = locationContext();
let lease: LocationLease;
let running: RunningHost;
try {
  lease = acquireLocationLease(ctx.base, "shared");
  running = await runHost(resolveLocation(ctx));
} catch (error) {
  console.error(`[host] ${(error as Error).message}`);
  process.exit(1);
}
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  running.stop().then(
    () => {
      lease.release();
      process.exit(0);
    },
    (error: Error) => {
      console.error(`[host] stop failed: ${error.message}`);
      process.exit(1);
    },
  );
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// The desktop app asks by message: on Windows a killed process gets no signal, it just dies.
const parentPort = (process as { parentPort?: ParentPort }).parentPort;
parentPort?.on("message", (message) => {
  const data = message.data as { type?: unknown } | null;
  if (data?.type === "stop") stop();
});
