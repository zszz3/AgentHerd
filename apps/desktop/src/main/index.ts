// Electron main: window, keep-awake, and the bridge to the host process. No business logic
// (docs/spec/02-architecture.md §2). The host runs in a utility process, or is already running
// (`agentherd start`); main talks to it only over the local API socket.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  HostEvent,
  HostMethod,
  HostStatus,
  PetSettings,
  PetView,
  TasksView,
} from "@agentherd/host/api";
import { HOST_METHODS } from "@agentherd/host/api";
import { connectHost, type HostClient, socketPath } from "@agentherd/host/server";
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, powerSaveBlocker, shell } from "electron";
import type { Notice, NoticeTab } from "../shared/pet-notify.ts";
import { ApproveKey, type PetArm, shortcutLabel } from "../shared/pet-shortcuts.ts";
import { isTheme, type Theme, themeFrom, themeText } from "../shared/theme.ts";
import { desktopMijiaTransport, ensureHost, ownsHost, stopOwnedHost } from "./host-process.ts";
import { MenuBar } from "./menu-bar.ts";
import { registerDesktopMijia } from "./mijia-desktop.ts";
import { Notifier } from "./notifier.ts";
import { PetWindow } from "./pet-window.ts";
import { Shortcuts } from "./shortcuts.ts";

const desktopMijia = registerDesktopMijia(desktopMijiaTransport);

app.setName("AgentHerd");
app.setAppUserModelId("com.agentherd.desktop");
app.setAboutPanelOptions({ applicationName: "AgentHerd", copyright: "MIT License" });

const APP_ICON = join(import.meta.dirname, "../../resources/icon.png");
/** Black on clear, so macOS tints it for a light or dark menu bar (ADR 0079). */
const MENU_BAR_ICON = join(import.meta.dirname, "../../resources/trayTemplate.png");
const home = process.env.AGENTHERD_HOME ?? join(homedir(), ".agentherd");
const sock = socketPath(home);

let win: BrowserWindow | undefined;
/** The menu bar icon on macOS, the tray icon on Windows (ADR 0079). */
let menuBar: MenuBar | undefined;
let client: HostClient | undefined;
let connected = false;
let keepAwakeId: number | undefined;
let quitting = false;
/** Made once the app is ready (it needs the screen). */
let pet: PetWindow | undefined;
let petSettings: PetSettings | undefined;
/** The pet's view as the host last sent it: what the approve shortcut answers (ADR 0080). */
let petView: PetView | undefined;
const approveKey = new ApproveKey();

/** System notifications for what waits for the owner and what tasks finished (ADR 0079). */
const notifier = new Notifier({
  press: (target, action) => {
    void client?.host.petPress(target, action).catch((error: Error) => {
      console.error(`[desktop] notification answer: ${error.message}`);
    });
  },
  open: (notice) => showNotice(notice),
  // An AgentHerd window has the keyboard: the owner sees it already.
  looking: () => BrowserWindow.getFocusedWindow() !== null,
  log: (message) => console.log(`[desktop] ${message}`),
  icon: APP_ICON,
});

/** The pet's global shortcuts (ADR 0080). */
const shortcuts = new Shortcuts({
  talk: () => onTalkKey(),
  approve: () => onApproveKey(),
  changed: (state) => send("app:shortcuts", state),
  log: (message) => console.log(`[desktop] ${message}`),
});

function send(channel: string, payload: unknown): void {
  if (win !== undefined && !win.isDestroyed()) win.webContents.send(channel, payload);
  pet?.send(channel, payload);
}

function setConnected(value: boolean): void {
  connected = value;
  desktopMijia.connection(value);
  send("host:connection", value);
  menuBar?.update({ connected: value });
}

function applyKeepAwake(on: boolean): void {
  if (on && keepAwakeId === undefined) {
    keepAwakeId = powerSaveBlocker.start("prevent-app-suspension");
  } else if (!on && keepAwakeId !== undefined) {
    powerSaveBlocker.stop(keepAwakeId);
    keepAwakeId = undefined;
  }
}

function onStatus(status: HostStatus): void {
  applyKeepAwake(status.keepAwake);
  petSettings = status.pet;
  notifier.setSettings(status.pet);
  menuBar?.update({ status });
  // An older host has no pet settings: no pet.
  if (process.env.AGENTHERD_CAPTURE === undefined) {
    pet?.setPlacement({
      onTop: status.pet?.onTop ?? "always",
      overFullscreen: status.pet?.overFullscreen ?? false,
    });
    pet?.set(status.pet?.on === true);
    shortcuts.set({ talk: status.pet?.talkKey ?? "", approve: status.pet?.approveKey ?? "" });
  }
}

function onPetView(view: PetView): void {
  petView = view;
  notifier.view(view);
  menuBar?.update({ view });
}

function onTasks(tasks: TasksView): void {
  menuBar?.update({ tasks: tasks.tasks });
}

function onHostEvent(event: HostEvent): void {
  if (event.topic === "status") onStatus(event.data);
  else if (event.topic === "pet") onPetView(event.data);
  else if (event.topic === "tasks") onTasks(event.data);
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
      onHostEvent({ topic: "status", data: status });
      // What is there now is no news: the notifier only notes it (ADR 0079).
      const [view, tasks] = await Promise.all([
        c.host.pet().catch(() => undefined),
        c.host.tasks().catch(() => undefined),
      ]);
      if (view !== undefined) onPetView(view);
      if (tasks !== undefined) onTasks(tasks);
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

// 设置 → 外观 → 颜色: nativeTheme.themeSource makes `prefers-color-scheme` in every window and the
// window frame follow the owner's choice; it is kept next to the pet's position in userData.
function themeFile(): string {
  return join(app.getPath("userData"), "theme.json");
}

function savedTheme(): Theme {
  try {
    return themeFrom(readFileSync(themeFile(), "utf8"));
  } catch {
    return themeFrom(undefined);
  }
}

ipcMain.handle("app:theme", () => nativeTheme.themeSource);
ipcMain.handle("app:set-theme", (_e, theme: unknown) => {
  if (!isTheme(theme)) throw new Error("theme must be system, light or dark");
  nativeTheme.themeSource = theme;
  try {
    writeFileSync(themeFile(), themeText(theme));
  } catch (error) {
    console.error(`[desktop] could not keep the colours: ${(error as Error).message}`);
  }
});

function frameColor(): string {
  return nativeTheme.shouldUseDarkColors ? "#0d0d0d" : "#e8e8eb";
}

/** Window controls for Windows and Linux: transparent, 36 px tall in the frame strip. */
function titleBarOverlay(): { color: string; symbolColor: string; height: number } {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: "#00000000", symbolColor: dark ? "#dcdcdc" : "#3a3a3c", height: 36 };
}

function showWindow(): void {
  if (win === undefined || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (process.platform === "darwin") app.focus({ steal: true });
}

/** Shows the main window; with a task, opens it there (asked by the pet, ADR 0072). */
function openApp(taskId?: string): void {
  showWindow();
  if (taskId === undefined || win === undefined) return;
  const w = win;
  const tell = () => w.webContents.send("app:open-task", taskId);
  if (w.webContents.isLoading()) w.webContents.once("did-finish-load", tell);
  else tell();
}

/** Shows the pet's panel on a page; false when the pet is off (ADR 0079). */
function showPet(tab: NoticeTab, toggle = false): boolean {
  if (pet === undefined || petSettings?.on !== true) return false;
  return pet.show(tab, toggle);
}

/** A click on a notification: the pet at the page it is about, else the app. */
function showNotice(notice: Notice): void {
  if (showPet(notice.tab)) return;
  openApp(notice.taskId);
}

/** The talk shortcut toggles the pet's conversation, or opens the app while the pet is off. */
function onTalkKey(): void {
  if (!showPet("chat", true)) openApp();
}

/** The approve shortcut: picks the oldest approval, allows it on a second press (ADR 0080). */
function onApproveKey(): void {
  const settings = petSettings;
  if (settings?.on !== true || pet === undefined) {
    openApp();
    return;
  }
  const press = approveKey.press(petView, Date.now());
  if (press.kind === "allow") {
    const { approval } = press;
    const c = client;
    if (c === undefined) {
      tellArm({ kind: "failed", message: "AgentHerd 服务未连接" });
      return;
    }
    void c.host
      .petPress(approval.target, "allow")
      .then(() => tellArm({ kind: "done", approval }))
      .catch((error: Error) => tellArm({ kind: "failed", message: error.message }));
    return;
  }
  showPet("cards");
  tellArm(
    press.kind === "arm"
      ? { ...press, key: shortcutLabel(settings.approveKey, process.platform === "darwin") }
      : { kind: "none" },
  );
}

function tellArm(arm: PetArm): void {
  pet?.send("pet:arm", arm);
}

ipcMain.on("pet:disarm", () => approveKey.clear());
ipcMain.handle("app:shortcuts", () => shortcuts.state());
// The settings page records a new shortcut: the old ones must not swallow the keys meanwhile.
ipcMain.on("app:pause-shortcuts", (_e, paused: unknown) => {
  if (typeof paused === "boolean") shortcuts.pause(paused);
});

function setPet(patch: Partial<PetSettings>): void {
  void client?.host.updateSettings({ pet: patch }).catch((error: Error) => {
    console.error(`[desktop] pet settings: ${error.message}`);
  });
}

/** The menu bar icon on macOS and the tray icon on Windows; nothing elsewhere (ADR 0079). */
function createMenuBar(): void {
  if (
    (process.platform !== "darwin" && process.platform !== "win32") ||
    process.env.AGENTHERD_CAPTURE !== undefined ||
    menuBar !== undefined
  ) {
    return;
  }
  const mac = process.platform === "darwin";
  menuBar = new MenuBar({
    icon: mac ? MENU_BAR_ICON : APP_ICON,
    template: mac,
    openApp: () => openApp(),
    showPet,
    setPet,
    quit: () => {
      quitting = true;
      app.quit();
    },
  });
  menuBar.update({ connected });
}

function createWindow(): void {
  const created = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    title: "AgentHerd",
    icon: APP_ICON,
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
        {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: titleBarOverlay(),
          backgroundColor: frameColor(),
        }),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win = created;
  if (process.platform !== "darwin") {
    const follow = () => {
      if (created.isDestroyed()) return;
      created.setBackgroundColor(frameColor());
      created.setTitleBarOverlay(titleBarOverlay());
    };
    nativeTheme.on("updated", follow);
    created.on("closed", () => nativeTheme.off("updated", follow));
  }
  created.on("close", (event) => {
    // Windows keeps running in the tray; macOS has always kept running without a window.
    if (!quitting && menuBar !== undefined && process.platform === "win32") {
      event.preventDefault();
      created.hide();
    }
  });
  created.on("closed", () => {
    if (win === created) win = undefined;
    // It may have been recording a shortcut.
    shortcuts.pause(false);
    // The pet window would keep the app running with no way back in; outside macOS (and without
    // the Windows tray) closing the main window quits, as before.
    if (process.platform !== "darwin" && menuBar === undefined && !quitting) app.quit();
  });
  created.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  created.webContents.on("will-navigate", (event) => event.preventDefault());
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  const renderer = join(import.meta.dirname, "../renderer/index.html");
  desktopMijia.watch(created, devUrl === undefined ? pathToFileURL(renderer).href : undefined);
  if (devUrl !== undefined) void created.loadURL(devUrl);
  else void created.loadFile(renderer);
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
    await w.webContents.executeJavaScript(
      `document.querySelector('[data-nav="${page}"]')?.click()`,
    );
    await wait(800);
    await shoot(page);
  }
  app.quit();
}

app.whenReady().then(() => {
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);
  // In development the bundle is node_modules' Electron.app; show the AgentHerd icon anyway.
  app.dock?.setIcon(APP_ICON);
  nativeTheme.themeSource = savedTheme();
  pet = new PetWindow({
    preload: join(import.meta.dirname, "../preload/index.cjs"),
    rendererDir: join(import.meta.dirname, "../renderer"),
    ...(process.env.ELECTRON_RENDERER_URL === undefined
      ? {}
      : { devUrl: process.env.ELECTRON_RENDERER_URL }),
    openApp: openApp,
  });
  createWindow();
  createMenuBar();
  void connect();
  // The pet counts as a window; the dock icon brings back the main one.
  app.on("activate", () => showWindow());
});

app.on("window-all-closed", () => {
  if (
    (process.platform !== "darwin" && (menuBar === undefined || quitting)) ||
    process.env.AGENTHERD_CAPTURE !== undefined
  ) {
    app.quit();
  }
});

app.on("will-quit", () => shortcuts.dispose());

app.on("before-quit", (event) => {
  quitting = true;
  menuBar?.destroy();
  menuBar = undefined;
  client?.close();
  if (!ownsHost()) return;
  // Let the host stop its tasks and tell the owner first; quit again once it is gone.
  event.preventDefault();
  void stopOwnedHost().finally(() => app.quit());
});
