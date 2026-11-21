import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PetWindow } from "../src/main/pet-window";

const ipc = new EventEmitter();
const cursor = { x: 500, y: 500 };
const display = { workArea: { x: 0, y: 0, width: 1000, height: 800 } };
const secondDisplay = { workArea: { ...display.workArea, x: 1000 } };
let directory: string;
let window: FakeWindow;
class FakeWindow extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), { send: vi.fn(), setWindowOpenHandler: vi.fn() });
  constructor(public bounds: { x: number; y: number; width: number; height: number }) {
    super();
    window = this;
  }
  setBounds(bounds: typeof this.bounds) {
    this.bounds = bounds;
  }
  getBounds() {
    return this.bounds;
  }
  isDestroyed() {
    return false;
  }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setIgnoreMouseEvents = vi.fn();
  loadFile() {}
  close() {
    this.emit("closed");
  }
}
vi.mock("electron", () => ({
  get BrowserWindow() {
    return FakeWindow;
  },
  ipcMain: {
    on: (...args: Parameters<typeof ipc.on>) => ipc.on(...args),
    handle: (...args: Parameters<typeof ipc.on>) => ipc.on(...args),
  },
  screen: {
    getCursorScreenPoint: () => ({ ...cursor }),
    getDisplayNearestPoint: ({ x }: { x: number }) => (x < 1000 ? display : secondDisplay),
    getPrimaryDisplay: () => display,
  },
  app: { getPath: () => directory },
}));
afterEach(() => {
  ipc.removeAllListeners();
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});
it.each(["right", "left"] as const)(
  "Claude grips the %s edge on release and restores it after restart",
  (side) => {
    vi.useFakeTimers();
    directory = mkdtempSync(join(tmpdir(), "herd-pet-"));
    const pet = new PetWindow({ preload: "", rendererDir: "", openApp: () => {} });
    const send = (event: string, ...args: unknown[]) =>
      ipc.emit(`pet:${event}`, { sender: window.webContents }, ...args);
    pet.set(true);
    send("resize", 150, 150, [{ x: 8, y: 8, width: 130, height: 130 }]);
    send("peek", { hover: true, panel: false, grip: true });
    cursor.x = side === "right" ? 870 : 955;
    send("drag-start");
    cursor.x = side === "right" ? 999 : 0;
    send("drag-move");
    send("drag-end");
    const pose = (value: string, animate = false) =>
      expect(
        window.webContents.send.mock.calls.filter(([channel]) => channel === "pet:pose").at(-1),
      ).toEqual([
        "pet:pose",
        {
          side,
          pose: value,
          animate,
        },
      ]);
    pose("grip", true);
    const anchor = window.bounds.x;
    expect(anchor).toBe(side === "right" ? 850 : 0);
    send("peek", { hover: false, panel: false, grip: true });
    send("peek", { hover: true, panel: false, grip: true });
    pose("grip", true);
    cursor.y += 10;
    send("peek", { hover: false, panel: false, grip: true });
    send("peek", { hover: true, panel: false, grip: true });
    pose("full");
    const point = (x: number, y: number, ignore: boolean) => {
      cursor.x = window.bounds.x + x;
      cursor.y = window.bounds.y + y;
      vi.advanceTimersByTime(25);
      expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(ignore);
    };
    const stage = [{ x: 8, y: 8, width: 130, height: 130 }];
    send("resize", 150, 150, stage);
    point(70, 70, false);
    point(2, 2, true);
    send("peek", { hover: false, panel: false, grip: true });
    vi.advanceTimersByTime(599);
    send("peek", { hover: true, panel: false, grip: true });
    vi.advanceTimersByTime(601);
    pose("full");
    send("peek", { hover: false, panel: false, grip: true });
    vi.advanceTimersByTime(600);
    pose("grip", true);
    const hand = { x: side === "left" ? 4 : 142, y: 90, width: 2, height: 1 };
    const dot = { x: 62, y: 8, width: 8, height: 8 };
    send("resize", 150, 150, stage, [hand, dot]);
    point(hand.x, 90, false);
    point(hand.x + 2, 90, true);
    point(dot.x, dot.y, false);
    point(70, 70, true);
    expect(window.bounds.x).toBe(anchor);
    send("peek", { hover: false, panel: true, grip: true });
    pose("full");
    pet.set(false);
    pet.set(true);
    send("peek", { hover: false, panel: false, grip: true });
    pose("grip");
    pet.set(false);
  },
);

it("keeps a non-Claude pet on the cursor display and tucks to its usual strip", () => {
  vi.useFakeTimers();
  directory = mkdtempSync(join(tmpdir(), "herd-pet-"));
  const pet = new PetWindow({ preload: "", rendererDir: "", openApp: () => {} });
  const send = (event: string, ...args: unknown[]) =>
    ipc.emit(`pet:${event}`, { sender: window.webContents }, ...args);
  pet.set(true);
  send("resize", 150, 150, [{ x: 8, y: 8, width: 130, height: 130 }]);
  send("peek", { hover: false, panel: false, grip: false });
  cursor.x = 870;
  cursor.y = 700;
  send("drag-start");
  cursor.x = 1100;
  send("drag-move");
  expect(window.bounds.x).toBeGreaterThanOrEqual(1000);
  cursor.x = 1999;
  send("drag-move");
  expect(window.bounds.x + window.bounds.width).toBe(2000);
  send("drag-end");
  expect(window.bounds.x).toBe(1948);
  expect(window.webContents.send).toHaveBeenLastCalledWith("pet:pose", {
    side: "right",
    pose: "full",
    animate: false,
  });
  pet.set(false);
});
