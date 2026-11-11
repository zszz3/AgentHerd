// Electron main: window, keep-awake, and the bridge to the host process. No business logic
// (docs/spec/02-architecture.md §2). The host runs in a utility process, or is already running
// (`agentherd start`); main talks to it only over the local API socket.

import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HostEvent, HostMethod } from "@agentherd/host/api";
import { HOST_METHODS } from "@agentherd/host/api";
import { connectHost, type HostClient, socketPath } from "@agentherd/host/server";
import { app, BrowserWindow, ipcMain, nativeTheme, powerSaveBlocker, shell } from "electron";
import { ensureHost, ownsHost, stopOwnedHost } from "./host-process.ts";

app.setName("AgentHerd");
app.setAboutPanelOptions({ applicationName: "AgentHerd", copyright: "MIT License" });

const home = process.env.AGENTHERD_HOME ?? join(homedir(), ".agentherd");
const sock = socketPath(home);

let win: BrowserWindow | undefined;
let client: HostClient | undefined;
let connected = false;
let keepAwakeId: number | undefined;
let quitting = false;

function send(channel: string, payload: unknown): void {
  if (win !== undefined && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function setConnected(value: boolean): void {
  connected = value;
  send("host:connection", value);
}

function applyKeepAwake(on: boolean): void {
  if (on && keepAwakeId === undefined) {
    keepAwakeId = powerSaveBlocker.start("prevent-app-suspension");
  } else if (!on && keepAwakeId !== undefined) {
    powerSaveBlocker.stop(keepAwakeId);
    keepAwakeId = undefined;
  }
}

function onHostEvent(event: HostEvent): void {
  if (event.topic === "status") applyKeepAwake(event.data.keepAwake);
  send("host:event", event);
}

async function connect(): Promise<void> {
  while (!quitting) {
    try {
      await ensureHost(home, sock);
      const c = await connectHost(sock);
      client = c;
      c.onEvent(onHostEvent);
      c.onClose(() => {
        if (client === c) client = undefined;
        setConnected(false);
        if (!quitting) setTimeout(() => void connect(), 1000);
      });
      setConnected(true);
      const status = await c.host.status();
      applyKeepAwake(status.keepAwake);
      onHostEvent({ topic: "status", data: status });
      return;
    } catch (error) {
      console.error(`[desktop] host: ${(error as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

ipcMain.handle("host:call", async (_event, method: HostMethod, params: unknown[]) => {
  if (!HOST_METHODS.includes(method)) throw new Error(`unknown method "${String(method)}"`);
  // The renderer may call before the host is up; give it a moment instead of failing.
  for (let i = 0; i < 50 && client === undefined; i++) await new Promise((r) => setTimeout(r, 200));
  if (client === undefined) throw new Error("AgentHerd 服务未连接");
  const fn = client.host[method] as (...args: unknown[]) => Promise<unknown>;
  return fn(...(Array.isArray(params) ? params : []));
});
ipcMain.handle("host:connected", () => connected);

/** Window controls for Windows and Linux: transparent, as tall as `--ah-titlebar-height`. */
function titleBarOverlay(): { color: string; symbolColor: string; height: number } {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: "#00000000", symbolColor: dark ? "#dcdcdc" : "#3a3a3c", height: 48 };
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    title: "AgentHerd",
    show: process.env.AGENTHERD_CAPTURE === undefined,
    // The sidebar is translucent on macOS; the renderer keeps the page card opaque.
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 18, y: 18 },
          vibrancy: "sidebar" as const,
          visualEffectState: "followWindow" as const,
          backgroundColor: "#00000000",
        }
      : // Elsewhere hiddenInset is ignored and leaves the native title bar and menu bar; draw
        // the window controls over the renderer's title bar strip instead.
        { titleBarStyle: "hidden" as const, titleBarOverlay: titleBarOverlay() }),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  if (process.platform !== "darwin") {
    const w = win;
    const follow = () => {
      if (!w.isDestroyed()) w.setTitleBarOverlay(titleBarOverlay());
    };
    nativeTheme.on("updated", follow);
    w.on("closed", () => nativeTheme.off("updated", follow));
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl !== undefined) void win.loadURL(devUrl);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  const capture = process.env.AGENTHERD_CAPTURE;
  if (capture !== undefined) void captureAndQuit(capture);
}

/** Development aid: `AGENTHERD_CAPTURE=/tmp/shot` saves one PNG per page, then quits. */
async function captureAndQuit(prefix: string): Promise<void> {
  const w = win;
  if (w === undefined) return;
  await new Promise<void>((r) => w.webContents.once("did-finish-load", () => r()));
  const pages = (process.env.AGENTHERD_CAPTURE_PAGES ?? "").split(",").filter((p) => p !== "");
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await wait(3000);
  const shoot = async (name: string) => {
    const image = await w.webContents.capturePage();
    writeFileSync(`${prefix}-${name}.png`, image.toPNG());
  };
  await shoot("start");
  for (const page of pages) {
    // Pages inside a sidebar entry (记忆, Agent…) are tabs; a reload with the page in the hash opens them.
    const reloaded = await w.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('[data-nav="${page}"]'); if (b) { b.click(); return false; } location.hash = "${page}"; location.reload(); return true; })()`,
    );
    if (reloaded === true) await wait(2000);
    await wait(800);
    await shoot(page);
  }
  app.quit();
}

app.whenReady().then(() => {
  // In development the bundle is node_modules' Electron.app; show the AgentHerd icon anyway.
  app.dock?.setIcon(join(import.meta.dirname, "../../resources/icon.png"));
  createWindow();
  void connect();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || process.env.AGENTHERD_CAPTURE !== undefined) app.quit();
});

app.on("before-quit", (event) => {
  quitting = true;
  client?.close();
  if (!ownsHost()) return;
  // Let the host stop its tasks and tell the owner first; quit again once it is gone.
  event.preventDefault();
  void stopOwnedHost().finally(() => app.quit());
});
