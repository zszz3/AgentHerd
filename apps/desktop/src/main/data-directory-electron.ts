import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { type LocationContext, LocationError } from "@agentherd/host/data-location";
import type { ApplyResult } from "@agentherd/host/location-apply";
import { checkExistingHome, checkTargetParent } from "@agentherd/host/location-target";
import { app, type BrowserWindow, dialog, type IpcMainInvokeEvent, ipcMain } from "electron";
import { changeConfirmation, DataDirectory } from "./data-directory.ts";

function apply(
  ctx: LocationContext,
  progress: (files: number) => void,
  signal: AbortSignal,
): Promise<ApplyResult> {
  // Keep synchronous copy and SQLite verification off the UI thread.
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(import.meta.dirname, "data-directory-worker.js"), {
      workerData: ctx,
    });
    // Quit must not wait for a copy; an interrupted copy keeps the old location selected.
    signal.addEventListener("abort", () => void worker.terminate(), { once: true });
    worker.on(
      "message",
      (message: { files: number } | { result: ApplyResult } | { error: string }) => {
        if ("files" in message) progress(message.files);
        else if ("result" in message) resolve(message.result);
        else if (message.error === "record-corrupt" || message.error === "location-unavailable") {
          reject(new LocationError(message.error, "Data directory unavailable"));
        } else reject(new Error("Data directory startup failed"));
      },
    );
    worker.once("error", reject);
    worker.once("exit", () => reject(new Error("Data directory worker exited without a result")));
  });
}

export function setupDataDirectory(
  ctx: LocationContext,
  window: () => BrowserWindow | undefined,
  ready: (home: string) => void,
): DataDirectory {
  function owner(): BrowserWindow {
    const win = window();
    if (!win || win.isDestroyed()) throw new Error("No main window");
    return win;
  }
  const directory = new DataDirectory(ctx, {
    async pick(existing) {
      const result = await dialog.showOpenDialog(owner(), {
        title: existing ? "选择现有 AgentHerd 数据目录" : "选择新数据目录的上级文件夹",
        properties: existing ? ["openDirectory"] : ["openDirectory", "createDirectory"],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
    async confirm(from, to, copy) {
      const { response } = await dialog.showMessageBox(owner(), {
        type: "warning",
        title: "更改数据目录",
        ...changeConfirmation(from, to, copy),
        defaultId: 0,
        cancelId: 0,
      });
      return response === 1 ? "empty" : response === 2 && copy ? "copy" : undefined;
    },
    async confirmPrevious(path) {
      const { response } = await dialog.showMessageBox(owner(), {
        type: "warning",
        message: "返回上一个数据目录？",
        detail: `${path}\n切换后写入的数据不会合并。`,
        buttons: ["取消", "返回上一个目录"],
        defaultId: 0,
        cancelId: 0,
      });
      return response === 1;
    },
    restart() {
      app.relaunch();
      app.quit();
    },
    ready,
    changed(files) {
      const win = window();
      if (win && !win.isDestroyed())
        win.webContents.mainFrame.send("app:data-directory-progress", files);
    },
    checkParent: checkTargetParent,
    checkHome: checkExistingHome,
    apply: (progress, signal) => apply(ctx, progress, signal),
  });
  function validate(event: IpcMainInvokeEvent, args: unknown[], count: number): void {
    const win = owner();
    if (
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame ||
      args.length !== count
    ) {
      throw new Error("Invalid data directory request");
    }
  }
  ipcMain.handle("app:data-directory", (event, ...args: unknown[]) => {
    validate(event, args, 0);
    return directory.status();
  });
  ipcMain.handle("app:change-data-directory", (event, ...args: unknown[]) => {
    validate(event, args, 0);
    return directory.change();
  });
  ipcMain.handle("app:recover-data-directory", (event, ...args: unknown[]) => {
    validate(event, args, 1);
    const [choice] = args;
    if (choice !== "retry" && choice !== "previous" && choice !== "pick")
      throw new Error("Invalid recovery choice");
    return directory.recover(choice);
  });
  return directory;
}
