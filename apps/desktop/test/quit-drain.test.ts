import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { acquireLocationLease } from "@agentherd/host/data-location";
import { applyLocationRequest } from "@agentherd/host/location-apply";
import { expect, test, vi } from "vitest";
import { DataDirectory } from "../src/main/data-directory.ts";
import { holdQuit } from "../src/main/quit-drain.ts";

/** Enough of Electron's `app` quit sequence: before-quit may cancel, then will-quit. */
class FakeApp extends EventEmitter {
  quit(): void {
    let prevented = false;
    this.emit("before-quit", { preventDefault: () => (prevented = true) });
    if (!prevented) this.emit("will-quit");
  }
}

test("a tray quit drains the owned host, then quits and releases the lease", async () => {
  const base = mkdtempSync(join(homedir(), ".agentherd-quit-test-"));
  const ctx = { base, env: {} };
  const directory = new DataDirectory(ctx, {
    pick: async () => undefined,
    confirm: async () => undefined,
    confirmPrevious: async () => false,
    restart: () => {},
    ready: () => {},
    changed: () => {},
    checkParent: async () => "",
    apply: (progress) => applyLocationRequest(ctx, progress),
  });
  try {
    await directory.start();
    const app = new FakeApp();
    let quitting = false;
    let stopHost!: () => void;
    const drain = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          quitting = true;
          stopHost = resolve;
        }),
    );
    const willQuit = vi.fn(() => directory.close());
    app.on(
      "before-quit",
      holdQuit(drain, () => app.quit()),
    );
    app.on("will-quit", willQuit);
    // The tray's quit item marks the app as quitting before it asks to quit.
    const trayQuit = () => {
      quitting = true;
      app.quit();
    };
    trayQuit();
    trayQuit();
    expect(quitting).toBe(true);
    expect(drain).toHaveBeenCalledOnce();
    expect(willQuit).not.toHaveBeenCalled();
    stopHost();
    await vi.waitFor(() => expect(willQuit).toHaveBeenCalledOnce());
    acquireLocationLease(base, "exclusive").release();
  } finally {
    directory.close();
    rmSync(base, { recursive: true, force: true });
  }
});
