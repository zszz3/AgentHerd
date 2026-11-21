// The desktop pet (ADR 0070): a small frameless window that floats above other windows. It shows
// what AgentHerd tells the owner and lets the owner answer; all of that goes through the host API
// like the main window. Main only places, moves and sizes the window.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  type IpcMainEvent,
  ipcMain,
  Menu,
  screen,
  shell,
} from "electron";
import { hitPetRegion, type PetRegion, type PetRoom } from "../shared/bridge.ts";
import { type Edge, edgeOf, fitDrag, peekRight, pushedEdge, tuckedX } from "../shared/pet-edge.ts";
import { fileToOpen, type PictureDisk, pictureToShow } from "./open-file";
import { petMenuItems } from "./pet-menu";

/** Size before the renderer measures itself: the figure alone. */
const START = { width: 150, height: 150 };
const MIN = 40;
/** Gap to the screen edge the first time. */
const MARGIN = 24;
/** How long a tucked figure stays out after the cursor leaves it (ADR 0080). */
const UNPEEK_MS = 600;

interface Corner {
  right: number;
  bottom: number;
  /** Tucked at this screen edge: dropped there with a third of it past the edge. */
  edge?: Edge;
}

/** Where the pet floats (ADR 0080): from the settings. */
export interface PetPlacement {
  /** "busy": above other windows only while it has something for the owner. */
  onTop: "always" | "busy";
  /** macOS: also over apps in full screen. */
  overFullscreen: boolean;
}

interface DragState {
  cursorX: number;
  cursorY: number;
  x: number;
  y: number;
  width: number;
  height: number;
  moved: boolean;
  /**
   * How far the pointer kept pushing past the left (negative) or right (positive) edge of the
   * screen after the pet stopped there; a push of a third of the figure tucks it on release.
   */
  push: number;
}

function parseRegions(raw: unknown): PetRegion[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PetRegion[] = [];
  for (const item of raw) {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as PetRegion).x === "number" &&
      typeof (item as PetRegion).y === "number" &&
      typeof (item as PetRegion).width === "number" &&
      typeof (item as PetRegion).height === "number"
    ) {
      out.push(item as PetRegion);
    }
  }
  return out;
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
  private dragFrom: DragState | undefined;
  private dragTimer: ReturnType<typeof setInterval> | undefined;
  private hitTimer: ReturnType<typeof setInterval> | undefined;
  private pendingSize: { width: number; height: number; regions?: PetRegion[] } | undefined;
  private regions: PetRegion[] | undefined;
  private gripHits: PetRegion[] | undefined;
  private interacting = false;
  private ignoringMouse: boolean | undefined;
  private size = { ...START };
  private lastPlaced: { x: number; y: number } | undefined;
  /** The room last told to the pet, so it is sent only when it changes. */
  private lastRoom: PetRoom | undefined;
  /** Where the figure stands: the window grows up and left from here and shrinks back to it. */
  private anchor: Corner | undefined;
  /** The screen edge the figure is tucked at; it peeks out while the cursor is on it. */
  private edge: Edge | undefined;
  private grip = false;
  private hover = false;
  private panel = false;
  private releaseCursor?: { x: number; y: number };
  private peeking = false;
  private peekTimer: ReturnType<typeof setTimeout> | undefined;
  /** The renderer has something for the owner: float even when on top is "busy". */
  private wantTop = false;
  private placement: PetPlacement = { onTop: "always", overFullscreen: false };
  private readonly opts: PetWindowOptions;

  constructor(opts: PetWindowOptions) {
    this.opts = opts;
    ipcMain.on("pet:drag-start", (e) => {
      const w = this.own(e);
      if (w === undefined) return;
      this.stopDragTimer();
      this.setIgnore(w, false);
      const cursor = screen.getCursorScreenPoint();
      const b = w.getBounds();
      // Dragged away from its edge: it is not tucked any more until dropped at one again.
      this.dragFrom = {
        cursorX: cursor.x,
        cursorY: cursor.y,
        x: b.x,
        y: b.y,
        width: this.size.width,
        height: this.size.height,
        moved: false,
        push: 0,
      };
      this.dragTimer = setInterval(() => this.stepDrag(), 16);
    });
    ipcMain.on("pet:drag-move", (e) => {
      if (this.own(e) !== undefined) this.stepDrag();
    });
    ipcMain.handle("pet:drag-end", (e) => {
      const w = this.own(e);
      this.stopDragTimer();
      const d = this.dragFrom;
      this.dragFrom = undefined;
      this.interacting = false;
      if (w === undefined || d === undefined) return false;
      this.stepDragWith(w, d);
      if (d.moved && this.anchor !== undefined) {
        this.tuckIfPastEdge(d.push);
        if (this.grip && this.edge) {
          clearTimeout(this.peekTimer);
          this.peekTimer = undefined;
          this.releaseCursor = this.hover ? screen.getCursorScreenPoint() : undefined;
          this.peeking = this.panel;
        }
        this.saveCorner({
          ...this.anchor,
          ...(this.edge === undefined ? {} : { edge: this.edge }),
        });
        this.place(w);
      }
      if (this.pendingSize !== undefined) {
        const { width, height, regions } = this.pendingSize;
        this.pendingSize = undefined;
        if (regions !== undefined) this.regions = regions;
        this.applySize(w, width, height);
      }
      this.updateHitTest();
      if (d.moved) this.tellPose(w, true);
      return d.moved;
    });
    ipcMain.on(
      "pet:resize",
      (e, width: unknown, height: unknown, rawRegions?: unknown, rawHits?: unknown) => {
        const w = this.own(e);
        if (w === undefined || typeof width !== "number" || typeof height !== "number") return;
        const regions = parseRegions(rawRegions);
        this.gripHits = parseRegions(rawHits);
        if (this.dragFrom !== undefined) {
          if (regions !== undefined) this.regions = regions;
          if (Math.ceil(width) !== this.size.width || Math.ceil(height) !== this.size.height) {
            this.pendingSize = {
              width,
              height,
              ...(regions === undefined ? {} : { regions }),
            };
          }
          return;
        }
        if (regions !== undefined) this.regions = regions;
        this.applySize(w, width, height);
        this.updateHitTest();
      },
    );
    ipcMain.on("pet:interacting", (e, active: unknown) => {
      if (this.own(e) === undefined || typeof active !== "boolean") return;
      this.interacting = active;
      this.updateHitTest();
    });
    // The cursor is on the figure, or its panel is open: a tucked figure comes out.
    ipcMain.on("pet:peek", (e, state: unknown) => {
      if (
        !state ||
        typeof state !== "object" ||
        !("hover" in state) ||
        !("panel" in state) ||
        !("grip" in state)
      )
        return;
      const { hover: on, panel, grip } = state;
      const w = this.own(e);
      if (w === undefined || typeof on !== "boolean") return;
      const changed = this.grip !== (grip === true);
      this.grip = grip === true;
      this.hover = on;
      const panelChanged = this.panel !== (panel === true);
      this.panel = panel === true;
      if (!this.grip) this.releaseCursor = undefined;
      if (!on) this.observeLeave(screen.getCursorScreenPoint());
      this.setPeek(w, this.panel || (on && !this.releaseCursor));
      if (panelChanged && this.grip) this.place(w);
      if (changed) {
        if (process.platform !== "win32") {
          this.stopHitTimer();
          if (this.grip) this.hitTimer = setInterval(() => this.updateHitTest(), 25);
          else this.setIgnore(w, false);
        }
        this.place(w);
        this.tellPose(w);
      }
    });
    // Something waits for the owner, or the panel is open: float above other windows.
    ipcMain.on("pet:float", (e, on: unknown) => {
      const w = this.own(e);
      if (w === undefined || typeof on !== "boolean" || on === this.wantTop) return;
      this.wantTop = on;
      this.applyPlacement(w);
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
    // A picture the Herder shows (ADR 0075): its bytes as a data URL, or undefined.
    ipcMain.handle("pet:read-image", (e, path: unknown) => {
      if (this.own(e) === undefined) return undefined;
      try {
        return pictureToShow(path, DISK);
      } catch {
        return undefined;
      }
    });
  }

  /** Shows or closes the pet. */
  set(on: boolean): void {
    if (on) this.open();
    else this.close();
  }

  /**
   * Opens the pet's panel on a page and gives it the keyboard: a notification or the menu bar
   * asked (ADR 0079). False when the pet is not shown.
   */
  show(tab: "chat" | "tasks" | "cards"): boolean {
    const w = this.win;
    if (w === undefined || w.isDestroyed()) return false;
    const tell = () => w.webContents.send("pet:show", tab);
    if (w.webContents.isLoading()) w.webContents.once("did-finish-load", tell);
    else tell();
    w.show();
    w.focus();
    if (process.platform === "darwin") app.focus({ steal: true });
    return true;
  }

  /** On top always or only while busy, and over full-screen apps or not (ADR 0080). */
  setPlacement(placement: PetPlacement): void {
    this.placement = { ...placement };
    const w = this.win;
    if (w !== undefined && !w.isDestroyed()) this.applyPlacement(w);
  }

  private applyPlacement(w: BrowserWindow): void {
    const top = this.placement.onTop === "always" || this.wantTop;
    if (top) w.setAlwaysOnTop(true, "floating");
    else w.setAlwaysOnTop(false);
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: this.placement.overFullscreen });
  }

  private tellPose(w: BrowserWindow, animate = false): void {
    const tucked = this.grip && this.edge !== undefined && !this.peeking;
    w.webContents.send("pet:pose", {
      side: this.edge ?? null,
      pose: tucked ? "grip" : "full",
      animate: tucked && animate,
    });
  }

  private setPeek(w: BrowserWindow, on: boolean): void {
    if (this.peekTimer !== undefined) {
      clearTimeout(this.peekTimer);
      this.peekTimer = undefined;
    }
    if (on) {
      if (this.peeking) return;
      this.peeking = true;
      this.place(w);
      this.tellPose(w);
      return;
    }
    if (!this.peeking) return;
    this.peekTimer = setTimeout(() => {
      this.peekTimer = undefined;
      this.peeking = false;
      if (!w.isDestroyed()) {
        this.place(w);
        this.tellPose(w, true);
      }
    }, UNPEEK_MS);
  }

  /**
   * Dropped while pushed a third of the figure past the left or right edge of its screen (or,
   * from an older position, standing that far past it): it tucks there (ADR 0080). Its corner
   * becomes where it stands when it peeks out.
   */
  private tuckIfPastEdge(push: number): void {
    const stage = this.regions?.[0];
    const b = this.lastPlaced;
    if (stage === undefined || b === undefined || this.anchor === undefined) return;
    const figure = { ...stage, x: b.x + stage.x, y: b.y + stage.y };
    // The screen whose edge it is: the one the figure's middle is on, or nearest to it.
    const area = screen.getDisplayNearestPoint({
      x: Math.round(figure.x + figure.width / 2),
      y: Math.round(figure.y + figure.height / 2),
    }).workArea;
    const edge = pushedEdge(push, figure.width) ?? edgeOf(figure, area);
    if (edge === undefined) return;
    this.edge = edge;
    // Keep the saved corner on the display where the drag ended.
    const right = Math.min(peekRight(edge, stage, this.size.width, area), area.x + area.width);
    this.anchor = { ...this.anchor, right };
  }

  /** Puts the window where its corner, size and tuck say. */
  private place(w: BrowserWindow): void {
    this.tellRoom(w);
    const b = this.boundsFor(w, this.size);
    if (this.lastPlaced?.x === b.x && this.lastPlaced?.y === b.y) return;
    this.lastPlaced = { x: b.x, y: b.y };
    w.setBounds(b);
    this.updateHitTest();
  }

  /**
   * Tells the pet how much room it has left of and above its corner. Without this it measured the
   * whole screen, grew taller than the room above the corner, and main had to move the window down
   * to keep it on screen: the figure jumped each time the conversation opened or closed.
   */
  private tellRoom(w: BrowserWindow): void {
    const anchor = this.anchor;
    if (anchor === undefined || w.isDestroyed()) return;
    const area = screen.getDisplayNearestPoint({
      x: anchor.right - 1,
      y: anchor.bottom - 1,
    }).workArea;
    const room = { width: anchor.right - area.x, height: anchor.bottom - area.y };
    if (this.lastRoom?.width === room.width && this.lastRoom.height === room.height) return;
    this.lastRoom = room;
    w.webContents.send("pet:room", room);
  }

  private boundsFor(
    w: BrowserWindow,
    size: { width: number; height: number },
  ): { x: number; y: number; width: number; height: number } {
    const b = w.getBounds();
    const anchor = this.anchor ?? { right: b.x + b.width, bottom: b.y + b.height };
    this.anchor = anchor;
    const area = screen.getDisplayNearestPoint({
      x: anchor.right - 1,
      y: anchor.bottom - 1,
    }).workArea;
    // Near the top or left edge the window moves in rather than grow off the screen.
    const bounds = {
      x: Math.max(area.x, anchor.right - size.width),
      y: Math.max(area.y, anchor.bottom - size.height),
      ...size,
    };
    const stage = this.regions?.[0];
    if (this.grip && this.edge && !this.panel) {
      bounds.x = this.edge === "right" ? area.x + area.width - size.width : area.x;
      return bounds;
    }
    if (this.edge === undefined || this.peeking || stage === undefined) return bounds;
    // Tucked: only a strip of the figure shows at the edge.
    bounds.x = tuckedX(this.edge, stage, area);
    return bounds;
  }

  send(channel: string, payload: unknown): void {
    if (this.win !== undefined && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, payload);
    }
  }

  private own(e: Pick<IpcMainEvent, "sender">): BrowserWindow | undefined {
    const w = this.win;
    return w !== undefined && !w.isDestroyed() && e.sender === w.webContents ? w : undefined;
  }

  private stopDragTimer(): void {
    if (this.dragTimer !== undefined) {
      clearInterval(this.dragTimer);
      this.dragTimer = undefined;
    }
  }

  private stopHitTimer(): void {
    if (this.hitTimer !== undefined) {
      clearInterval(this.hitTimer);
      this.hitTimer = undefined;
    }
  }

  private setIgnore(w: BrowserWindow, ignore: boolean): void {
    if (this.ignoringMouse === ignore) return;
    const wasInteractive = this.ignoringMouse === false;
    this.ignoringMouse = ignore;
    w.setIgnoreMouseEvents(ignore);
    if (ignore && wasInteractive && !w.isDestroyed()) {
      w.webContents.send("pet:mouse-leave");
    }
  }

  private updateHitTest(): void {
    if (process.platform !== "win32" && !this.grip) return;
    const w = this.win;
    if (w === undefined || w.isDestroyed()) return;
    if (this.dragFrom !== undefined || this.interacting) {
      this.setIgnore(w, false);
      return;
    }
    if (this.regions === undefined) {
      this.setIgnore(w, true);
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    const b = this.lastPlaced ?? w.getBounds();
    const hit = hitPetRegion(
      cursor.x - b.x,
      cursor.y - b.y,
      this.size,
      this.gripHits ?? this.regions,
    );
    if (!hit) this.observeLeave(cursor);
    this.setIgnore(w, !hit);
  }

  // Changing sprites under a stationary pointer can generate a synthetic leave and enter.
  private observeLeave(cursor: { x: number; y: number }): void {
    if (
      this.releaseCursor &&
      (cursor.x !== this.releaseCursor.x || cursor.y !== this.releaseCursor.y)
    )
      this.releaseCursor = undefined;
  }

  private stepDrag(): void {
    const w = this.win;
    const d = this.dragFrom;
    if (w === undefined || w.isDestroyed() || d === undefined) return;
    this.stepDragWith(w, d);
  }

  private stepDragWith(w: BrowserWindow, d: DragState): void {
    const cursor = screen.getCursorScreenPoint();
    const dx = cursor.x - d.cursorX;
    const dy = cursor.y - d.cursorY;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    if (!d.moved && this.edge !== undefined) {
      this.edge = undefined;
      this.tellPose(w);
    }
    d.moved = true;
    const rawX = Math.round(d.x + dx);
    // The whole pet (the panel too) stays inside the work area of the screen under the pointer,
    // on every system: dragged against an edge it slides along it and never leaves the screen.
    const { x, y } = fitDrag(
      { x: rawX, y: Math.round(d.y + dy), width: d.width, height: d.height },
      screen.getDisplayNearestPoint(cursor).workArea,
    );
    // Pushing on past the left or right edge adds up, so a drop can tuck it there (ADR 0080);
    // any move back inward starts over.
    const over = rawX - x;
    if (over === 0) {
      // Held still at the edge keeps the push; only a move back inward drops it.
      if (dx !== 0 && Math.sign(dx) !== Math.sign(d.push)) d.push = 0;
    } else if (Math.sign(over) !== Math.sign(d.push)) d.push = over;
    else d.push += over;
    // The blocked part of the motion is used up, so moving back moves the pet at once.
    d.x = x;
    d.y = y;
    d.cursorX = cursor.x;
    d.cursorY = cursor.y;
    this.anchor = { right: x + d.width, bottom: y + d.height };
    if (this.lastPlaced?.x === x && this.lastPlaced?.y === y) return;
    this.lastPlaced = { x, y };
    w.setBounds({ x, y, width: d.width, height: d.height });
  }

  private applySize(w: BrowserWindow, width: number, height: number): void {
    const b = w.getBounds();
    const anchor = this.anchor ?? { right: b.x + b.width, bottom: b.y + b.height };
    const area = screen.getDisplayNearestPoint({
      x: anchor.right - 1,
      y: anchor.bottom - 1,
    }).workArea;
    // As big as the pet asks, up to the screen: the owner sizes the conversation (ADR 0070).
    const next = {
      width: clamp(Math.ceil(width), MIN, area.width),
      height: clamp(Math.ceil(height), MIN, area.height),
    };
    const bounds = this.boundsFor(w, next);
    if (
      this.size.width === next.width &&
      this.size.height === next.height &&
      this.lastPlaced?.x === bounds.x &&
      this.lastPlaced?.y === bounds.y
    ) {
      return;
    }
    this.size = next;
    this.lastPlaced = { x: bounds.x, y: bounds.y };
    w.setBounds(bounds);
  }

  private open(): void {
    if (this.win !== undefined && !this.win.isDestroyed()) return;
    const corner = this.corner();
    this.anchor = { right: corner.right, bottom: corner.bottom };
    this.gripHits = undefined;
    this.edge = corner.edge;
    this.grip = this.hover = this.panel = false;
    this.releaseCursor = undefined;
    this.peeking = false;
    this.wantTop = false;
    this.size = { ...START };
    this.lastPlaced = { x: corner.right - START.width, y: corner.bottom - START.height };
    this.regions = undefined;
    this.interacting = false;
    this.ignoringMouse = undefined;
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
    this.applyPlacement(created);
    if (process.platform === "win32") {
      this.setIgnore(created, true);
      this.hitTimer = setInterval(() => this.updateHitTest(), 25);
    }
    created.on("blur", () => {
      if (this.dragFrom === undefined) {
        this.interacting = false;
        this.updateHitTest();
      }
    });
    created.once("ready-to-show", () => created.showInactive());
    created.on("closed", () => {
      if (this.win === created) {
        this.win = undefined;
        this.stopDragTimer();
        this.stopHitTimer();
        this.dragFrom = undefined;
        this.pendingSize = undefined;
        this.lastPlaced = undefined;
        this.regions = undefined;
        this.interacting = false;
        this.ignoringMouse = undefined;
      }
    });
    // Links in messages open in the browser; the pet itself never navigates or opens windows.
    created.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
      return { action: "deny" };
    });
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    // Right-click: copy words, a picture or a link; cut and paste in the input (ADR 0075).
    created.webContents.on("context-menu", (_event, place) => {
      const contents = created.webContents;
      const items = petMenuItems(place);
      if (items.length === 0) return;
      const run = {
        cut: () => contents.cut(),
        copy: () => contents.copy(),
        paste: () => contents.paste(),
        selectAll: () => contents.selectAll(),
        copyImage: () => contents.copyImageAt(place.x, place.y),
        copyLink: () => clipboard.writeText(place.linkURL),
      };
      Menu.buildFromTemplate(
        items.map((item) => ({ label: item.label, click: run[item.action] })),
      ).popup({ window: created });
    });
    created.webContents.on("did-finish-load", () => {
      this.lastRoom = undefined;
      this.tellRoom(created);
    });
    if (this.opts.devUrl !== undefined)
      void created.loadURL(new URL("pet.html", this.opts.devUrl).href);
    else void created.loadFile(join(this.opts.rendererDir, "pet.html"));
  }

  private close(): void {
    const w = this.win;
    this.win = undefined;
    if (this.peekTimer !== undefined) clearTimeout(this.peekTimer);
    this.peekTimer = undefined;
    this.stopDragTimer();
    this.stopHitTimer();
    this.dragFrom = undefined;
    this.pendingSize = undefined;
    this.lastPlaced = undefined;
    this.regions = undefined;
    this.interacting = false;
    this.ignoringMouse = undefined;
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
        const area = screen.getDisplayNearestPoint({
          x: saved.right - 1,
          y: saved.bottom - 1,
        }).workArea;
        const inside =
          saved.right > area.x + MIN &&
          saved.right <= area.x + area.width + MIN &&
          saved.bottom > area.y + MIN &&
          saved.bottom <= area.y + area.height + MIN;
        const edge = saved.edge === "left" || saved.edge === "right" ? saved.edge : undefined;
        if (inside)
          return {
            right: saved.right,
            bottom: saved.bottom,
            ...(edge === undefined ? {} : { edge }),
          };
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

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

const DISK: PictureDisk = {
  fileSize(path) {
    try {
      const s = statSync(path);
      return s.isFile() ? s.size : undefined;
    } catch {
      return undefined;
    }
  },
  read: (path) => new Uint8Array(readFileSync(path)),
};

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
