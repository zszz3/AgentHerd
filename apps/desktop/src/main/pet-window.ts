// The desktop pet (ADR 0070): a small frameless window that floats above other windows. It shows
// what AgentHerd tells the owner and lets the owner answer; all of that goes through the host API
// like the main window. Main only places, moves and sizes the window.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, BrowserWindow, type IpcMainEvent, ipcMain, screen, shell } from "electron";
import { fileToOpen } from "./open-file";

/** Size before the renderer measures itself: the figure alone. */
const START = { width: 150, height: 150 };
const MIN = 40;
/** Gap to the screen edge the first time. */
const MARGIN = 24;

interface Corner {
  right: number;
  bottom: number;
}

export interface PetWindowOptions {
  preload: string;
  /** The renderer folder of a build, or the dev server's address. */
  rendererDir: string;
  devUrl?: string;
  /** Brings up the main window, at a task when one is named. */
  openApp: (taskId?: string) => void;
}

export class PetWindow {
  private win: BrowserWindow | undefined;
  private dragFrom: { x: number; y: number } | undefined;
  /** Where the figure stands: the window grows up and left from here and shrinks back to it. */
  private anchor: Corner | undefined;
  private readonly opts: PetWindowOptions;

  constructor(opts: PetWindowOptions) {
    this.opts = opts;
    ipcMain.on("pet:drag-start", (e) => {
      const w = this.own(e);
      if (w === undefined) return;
      const [x, y] = w.getPosition();
      this.dragFrom = { x: x ?? 0, y: y ?? 0 };
    });
    ipcMain.on("pet:drag-move", (e, dx: unknown, dy: unknown) => {
      const w = this.own(e);
      if (w === undefined || this.dragFrom === undefined) return;
      if (typeof dx !== "number" || typeof dy !== "number") return;
      const x = windowCoordinate(this.dragFrom.x + dx);
      const y = windowCoordinate(this.dragFrom.y + dy);
      if (x === undefined || y === undefined) return;
      w.setPosition(x, y);
    });
    ipcMain.on("pet:drag-end", (e) => {
      const w = this.own(e);
      this.dragFrom = undefined;
      if (w === undefined) return;
      const b = w.getBounds();
      this.anchor = { right: b.x + b.width, bottom: b.y + b.height };
      this.saveCorner(this.anchor);
    });
    ipcMain.on("pet:resize", (e, width: unknown, height: unknown) => {
      const w = this.own(e);
      if (w === undefined || typeof width !== "number" || typeof height !== "number") return;
      const b = w.getBounds();
      const anchor = this.anchor ?? { right: b.x + b.width, bottom: b.y + b.height };
      this.anchor = anchor;
      const area = screen.getDisplayNearestPoint({
        x: anchor.right - 1,
        y: anchor.bottom - 1,
      }).workArea;
      // As big as the pet asks, up to the screen: the owner sizes the conversation (ADR 0070).
      const next = {
        width: clamp(Math.ceil(width), MIN, area.width),
        height: clamp(Math.ceil(height), MIN, area.height),
      };
      // Near the top or left edge the window moves in rather than grow off the screen.
      const bounds = {
        x: Math.max(area.x, anchor.right - next.width),
        y: Math.max(area.y, anchor.bottom - next.height),
        ...next,
      };
      if (
        bounds.x === b.x &&
        bounds.y === b.y &&
        next.width === b.width &&
        next.height === b.height
      )
        return;
      w.setBounds(bounds);
    });
    ipcMain.on("pet:open-app", (e, taskId: unknown) => {
      if (this.own(e) === undefined) return;
      this.opts.openApp(typeof taskId === "string" && taskId !== "" ? taskId : undefined);
    });
    // A file a message names: documents open in their app, anything else is shown in Finder.
    ipcMain.on("pet:open-file", (e, path: unknown) => {
      if (this.own(e) === undefined) return;
      const file = fileToOpen(path, isFile);
      if (file === undefined) return;
      if (file.how === "open") void shell.openPath(file.path);
      else shell.showItemInFolder(file.path);
    });
  }

  /** Shows or closes the pet. */
  set(on: boolean): void {
    if (on) this.open();
    else this.close();
  }

  send(channel: string, payload: unknown): void {
    if (this.win !== undefined && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, payload);
    }
  }

  private own(e: IpcMainEvent): BrowserWindow | undefined {
    const w = this.win;
    return w !== undefined && !w.isDestroyed() && e.sender === w.webContents ? w : undefined;
  }

  private open(): void {
    if (this.win !== undefined && !this.win.isDestroyed()) return;
    const corner = this.corner();
    this.anchor = corner;
    const created = new BrowserWindow({
      x: corner.right - START.width,
      y: corner.bottom - START.height,
      ...START,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // On macOS the first click on a window of an app in the background only brings the app
      // forward; the pet should open, take the cursor or press 同意 on that first click.
      acceptFirstMouse: true,
      title: "AgentHerd",
      webPreferences: {
        preload: this.opts.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    this.win = created;
    created.setAlwaysOnTop(true, "floating");
    created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    created.once("ready-to-show", () => created.showInactive());
    created.on("closed", () => {
      if (this.win === created) this.win = undefined;
    });
    // Links in messages open in the browser; the pet itself never navigates or opens windows.
    created.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
      return { action: "deny" };
    });
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    if (this.opts.devUrl !== undefined)
      void created.loadURL(new URL("pet.html", this.opts.devUrl).href);
    else void created.loadFile(join(this.opts.rendererDir, "pet.html"));
  }

  private close(): void {
    const w = this.win;
    this.win = undefined;
    if (w !== undefined && !w.isDestroyed()) w.close();
  }

  private file(): string {
    return join(app.getPath("userData"), "pet-window.json");
  }

  /** Where the pet's bottom-right corner was left, if that is still on a screen. */
  private corner(): Corner {
    try {
      const saved = JSON.parse(readFileSync(this.file(), "utf8")) as Corner;
      if (typeof saved.right === "number" && typeof saved.bottom === "number") {
        const area = screen.getDisplayNearestPoint({ x: saved.right, y: saved.bottom }).workArea;
        const inside =
          saved.right > area.x + MIN &&
          saved.right <= area.x + area.width + MIN &&
          saved.bottom > area.y + MIN &&
          saved.bottom <= area.y + area.height + MIN;
        if (inside) return saved;
      }
    } catch {
      // first time, or an unreadable file: start in the corner
    }
    const area = screen.getPrimaryDisplay().workArea;
    return { right: area.x + area.width - MARGIN, bottom: area.y + area.height - MARGIN };
  }

  private saveCorner(corner: Corner): void {
    try {
      const file = this.file();
      if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(corner));
    } catch {
      // the pet just starts in the corner next time
    }
  }
}

function windowCoordinate(value: number): number | undefined {
  const rounded = Math.round(value);
  if (!(rounded >= -(2 ** 31) && rounded < 2 ** 31)) return undefined;
  // Electron's integer conversion rejects the negative zero produced by Math.round.
  return rounded === 0 ? 0 : rounded;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
