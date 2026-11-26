#!/usr/bin/env node
// The AgentHerd host process: `node packages/host/bin/host.ts`. The desktop app starts the same
// thing in an Electron utility process.

import { agentherdHome, runHost } from "../src/index.ts";
import type { DesktopParentPort } from "../src/mijia-desktop-bridge.ts";

const parentPort = (process as { parentPort?: DesktopParentPort }).parentPort;
const starting = runHost({ home: agentherdHome() });
let stopping = false;
let stopDesktop: (() => void) | undefined;
const stop = () => {
  if (stopping) return;
  stopping = true;
  stopDesktop?.();
  void starting.then((running) => running.stop()).then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// The desktop app asks by message: on Windows a killed process gets no signal, it just dies.
parentPort?.on("message", (message) => {
  const data = message.data as { type?: unknown } | null;
  if (data?.type === "stop") stop();
});
const running = await starting;
if (parentPort && !stopping) stopDesktop = running.host.attachDesktopMijia(parentPort);
