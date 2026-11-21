// The only thing the renderer can reach: `window.agentherd`, set by the preload script.
// The renderer has no Node access; every call goes main → host over the local API socket.

import type { HostEvent, RemoteHost } from "@agentherd/host/api";
import type { PetArm, ShortcutState } from "./pet-shortcuts.ts";

export interface PetPose {
  side: "left" | "right" | null;
  pose: "full" | "grip";
  animate: boolean;
}

export interface PetRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** True when window-local point (x, y) is inside one of the pet's interactive regions. */
export function hitPetRegion(
  x: number,
  y: number,
  size: { width: number; height: number },
  regions: readonly PetRegion[],
): boolean {
  if (x < 0 || y < 0 || x > size.width || y > size.height) return false;
  return regions.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
}

/** The desktop pet window's own calls (ADR 0070); main ignores them from other windows. */
export interface PetBridge {
  /** A drag on the figure began; main follows the cursor from here. */
  dragStart(): void;
  /** Nudges main to update the drag position right away. */
  dragMove(dx?: number, dy?: number): void;
  /** Ends the drag; resolves true when the window actually moved. */
  dragEnd(): Promise<boolean>;
  /** Fits the window to the pet and updates its interactive hit regions. */
  resize(
    width: number,
    height: number,
    regions?: readonly PetRegion[],
    gripHits?: readonly PetRegion[],
  ): void;
  /** Locks mouse hit-testing active while a pointer button is held inside the pet. */
  interacting(active: boolean): void;
  /** Called when the cursor leaves the pet's interactive regions on Windows. */
  onMouseLeave(listener: () => void): () => void;
  /** Brings up the main window, at a task when one is named (ADR 0072). */
  openApp(taskId?: string): void;
  /** Opens a file a message names, or shows it in Finder when it is not a document (ADR 0073). */
  openFile(path: string): void;
  /**
   * A picture the Herder shows, as a data URL; undefined when it is not a picture main will read
   * (ADR 0075). Missing in older builds.
   */
  readImage?(path: string): Promise<string | undefined>;
  /** Where a file dropped on the pet is on disk; "" when it has no path (ADR 0082). */
  pathOf?(file: File): string;
  /**
   * Main asks the pet to open its panel on a page: a notification or the menu bar was clicked
   * (ADR 0079). Returns an unsubscribe function. Missing in older builds.
   */
  onShow?(listener: (tab: "chat" | "tasks" | "cards") => void): () => void;
  /** What the approve shortcut did: armed an approval, allowed it, or found none (ADR 0080). */
  onArm?(listener: (arm: PetArm) => void): () => void;
  /** The owner let the armed approval go (Esc): the next press picks it again. */
  disarm?(): void;
  /** The cursor is on the figure or the panel is open: a figure tucked at the edge comes out. */
  peek?(state: { hover: boolean; panel: boolean; grip: boolean }): void;
  onPose?(listener: (pose: PetPose) => void): () => void;
  /** The pet has something for the owner: it floats above other windows while on top is "busy". */
  float?(on: boolean): void;
  /**
   * The room left of and above the figure's corner on its screen. The pet never grows past it,
   * so opening the conversation never pushes the figure. Missing in older builds.
   */
  onRoom?(listener: (room: PetRoom) => void): () => void;
}

/** Room for the pet: from the figure's bottom-right corner to the top-left of its screen. */
export interface PetRoom {
  width: number;
  height: number;
}

export interface Bridge {
  host: RemoteHost;
  pet?: PetBridge;
  /** Host events (status, tasks, models, setup). Returns an unsubscribe function. */
  onEvent(listener: (event: HostEvent) => void): () => void;
  /** Whether main is connected to the host process. */
  onConnection(listener: (connected: boolean) => void): () => void;
  /**
   * The pet's global shortcuts (ADR 0080): which work, and a pause while the settings page records
   * a new one. Missing in older builds.
   */
  shortcuts?: {
    state(): Promise<ShortcutState>;
    onState(listener: (state: ShortcutState) => void): () => void;
    pause(paused: boolean): void;
  };
  /** The pet asked the main window to show a task. Returns an unsubscribe function. */
  onOpenTask?(listener: (taskId: string) => void): () => void;
}

declare global {
  interface Window {
    agentherd: Bridge;
  }
}
