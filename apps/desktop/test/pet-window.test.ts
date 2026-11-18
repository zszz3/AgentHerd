import { beforeEach, describe, expect, it, vi } from "vitest";
import { PetWindow } from "../src/main/pet-window.ts";

const { listeners, setPosition, webContents } = vi.hoisted(() => ({
  listeners: new Map<string, (...args: unknown[]) => void>(),
  setPosition: vi.fn(),
  webContents: { setWindowOpenHandler: vi.fn(), on: vi.fn() },
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => {
      throw new Error("no saved position");
    },
  },
  ipcMain: {
    on: (name: string, listener: (...args: unknown[]) => void) => listeners.set(name, listener),
  },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 800, height: 600 } }) },
  shell: {},
  BrowserWindow: class {
    webContents = webContents;
    getPosition = () => [40, 20];
    setPosition = setPosition;
    isDestroyed = () => false;
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    once = vi.fn();
    on = vi.fn();
    loadFile = vi.fn();
  },
}));

function send(channel: string, ...args: unknown[]): void {
  const listener = listeners.get(channel);
  if (listener === undefined) throw new Error(`missing listener for ${channel}`);
  listener({ sender: webContents }, ...args);
}

describe("desktop pet drag", () => {
  beforeEach(() => {
    listeners.clear();
    setPosition.mockClear();
    new PetWindow({ preload: "", rendererDir: "", openApp: vi.fn() }).set(true);
    send("pet:drag-start");
  });

  it("moves through zero on either axis and keeps negative screen coordinates", () => {
    send("pet:drag-move", 8, -20.25);
    send("pet:drag-move", -40.25, 5);
    send("pet:drag-move", -41, -22);

    expect(setPosition.mock.calls).toEqual([
      [48, 0],
      [0, 25],
      [-1, -2],
    ]);
  });

  it("ignores coordinates outside Electron's integer range and keeps dragging", () => {
    send("pet:drag-move", 8, Number.NaN);
    send("pet:drag-move", Number.POSITIVE_INFINITY, 5);
    send("pet:drag-move", 8, 2 ** 31);
    send("pet:drag-move", -(2 ** 32), 5);
    send("pet:drag-move", 8, 5);

    expect(setPosition.mock.calls).toEqual([[48, 25]]);
  });
});
