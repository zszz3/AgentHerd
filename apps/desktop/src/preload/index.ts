// The renderer's only door: `window.agentherd` (src/shared/bridge.ts).

import type { HostEvent, HostMethod, RemoteHost } from "@agentherd/host/api";
import { HOST_METHODS } from "@agentherd/host/api";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { Bridge, PetPose, PetRoom } from "../shared/bridge.ts";
import type { PetArm, ShortcutState } from "../shared/pet-shortcuts.ts";

const host = Object.fromEntries(
  HOST_METHODS.map((method: HostMethod) => [
    method,
    (...params: unknown[]) => ipcRenderer.invoke("host:call", method, params),
  ]),
) as unknown as RemoteHost;

const bridge: Bridge = {
  host,
  onEvent(listener) {
    const handler = (_e: unknown, event: HostEvent) => listener(event);
    ipcRenderer.on("host:event", handler);
    return () => ipcRenderer.removeListener("host:event", handler);
  },
  pet: {
    dragStart: () => ipcRenderer.send("pet:drag-start"),
    dragMove: () => ipcRenderer.send("pet:drag-move"),
    dragEnd: () => ipcRenderer.invoke("pet:drag-end") as Promise<boolean>,
    resize: (width, height, regions, gripHits) =>
      ipcRenderer.send("pet:resize", width, height, regions, gripHits),
    interacting: (active) => ipcRenderer.send("pet:interacting", active),
    onMouseLeave(listener) {
      const handler = () => listener();
      ipcRenderer.on("pet:mouse-leave", handler);
      return () => ipcRenderer.removeListener("pet:mouse-leave", handler);
    },
    openApp: (taskId) => ipcRenderer.send("pet:open-app", taskId),
    openFile: (path) => ipcRenderer.send("pet:open-file", path),
    readImage: (path) => ipcRenderer.invoke("pet:read-image", path),
    pathOf: (file) => webUtils.getPathForFile(file),
    onShow(listener) {
      const handler = (_e: unknown, tab: "chat" | "tasks" | "cards") => listener(tab);
      ipcRenderer.on("pet:show", handler);
      return () => ipcRenderer.removeListener("pet:show", handler);
    },
    onRoom(listener) {
      const handler = (_e: unknown, room: PetRoom) => listener(room);
      ipcRenderer.on("pet:room", handler);
      return () => ipcRenderer.removeListener("pet:room", handler);
    },
    onArm(listener) {
      const handler = (_e: unknown, arm: PetArm) => listener(arm);
      ipcRenderer.on("pet:arm", handler);
      return () => ipcRenderer.removeListener("pet:arm", handler);
    },
    disarm: () => ipcRenderer.send("pet:disarm"),
    peek: (state) => ipcRenderer.send("pet:peek", state),
    onPose(listener) {
      const handler = (_e: unknown, pose: PetPose) => listener(pose);
      ipcRenderer.on("pet:pose", handler);
      return () => ipcRenderer.removeListener("pet:pose", handler);
    },
    float: (on) => ipcRenderer.send("pet:float", on),
  },
  onConnection(listener) {
    const handler = (_e: unknown, connected: boolean) => listener(connected);
    ipcRenderer.on("host:connection", handler);
    void ipcRenderer.invoke("host:connected").then((c: boolean) => listener(c));
    return () => ipcRenderer.removeListener("host:connection", handler);
  },
  shortcuts: {
    state: () => ipcRenderer.invoke("app:shortcuts") as Promise<ShortcutState>,
    onState(listener) {
      const handler = (_e: unknown, state: ShortcutState) => listener(state);
      ipcRenderer.on("app:shortcuts", handler);
      return () => ipcRenderer.removeListener("app:shortcuts", handler);
    },
    pause: (paused) => ipcRenderer.send("app:pause-shortcuts", paused),
  },
  onOpenTask(listener) {
    const handler = (_e: unknown, taskId: string) => listener(taskId);
    ipcRenderer.on("app:open-task", handler);
    return () => ipcRenderer.removeListener("app:open-task", handler);
  },
};

contextBridge.exposeInMainWorld("agentherd", bridge);
