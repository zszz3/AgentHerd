import { randomUUID } from "node:crypto";
import type { DesktopControlCall, DesktopControlOutcome } from "@agentherd/host/api";
import type { BrowserWindow, IpcMainInvokeEvent, UtilityProcess } from "electron";
import { ipcMain } from "electron";
import { parseDesktopControlCall } from "../../../../packages/host/src/mijia-desktop-bridge.ts";

const unavailable = () => new Error("Mi Home desktop control unavailable");
const unknown: DesktopControlOutcome = { state: "unknown" };
const cancelled: DesktopControlOutcome = { state: "not-sent", reason: "cancelled" };

interface Pending {
  child: UtilityProcess;
  generation: number;
  confirm: boolean;
  current?: () => boolean;
  granted: boolean;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** The only transport for desktop control; does not know the public API socket. */
export class DesktopMijiaTransport {
  private child: UtilityProcess | undefined;
  private attachment: object | undefined;
  private ready = false;
  private next = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<() => void>();

  attach(child: UtilityProcess): void {
    if (this.child) this.detach(this.child);
    this.child = child;
    const attachment = {};
    this.attachment = attachment;
    child.on("message", (data: unknown) => {
      if (this.attachment !== attachment || typeof data !== "object" || data === null) return;
      const { type, id, generation, ok, value } = data as Record<string, unknown>;
      if (type === "mijia-desktop:ready" && !this.ready) {
        this.ready = true;
        this.notify();
      }
      if (
        typeof id !== "number" ||
        !Number.isSafeInteger(id) ||
        id <= 0 ||
        typeof generation !== "number" ||
        !Number.isSafeInteger(generation) ||
        generation <= 0
      )
        return;
      const p = this.pending.get(id);
      if (type === "mijia-desktop:authorize") {
        const granted =
          this.ready &&
          p?.child === child &&
          p.generation === generation &&
          p.confirm &&
          !p.granted &&
          p.current?.() === true;
        // Commit synchronously in Main. A lost grant reply does not prove non-dispatch.
        if (granted) p.granted = true;
        try {
          child.postMessage({ type: "mijia-desktop:authorization", id, generation, granted });
        } catch {
          this.detach(child);
        }
      }
      if (
        type === "mijia-desktop:reply" &&
        typeof ok === "boolean" &&
        p?.child === child &&
        p.generation === generation
      ) {
        this.finish(id, p, ok, value);
      }
    });
    child.once("exit", () => {
      if (this.attachment === attachment) this.detach(child);
    });
  }

  detach(child: UtilityProcess): void {
    if (this.child !== child) return;
    this.ready = false;
    this.child = undefined;
    this.attachment = undefined;
    for (const [id, p] of this.pending) this.finish(id, p, false);
    this.notify();
  }

  available(): boolean {
    return this.ready && this.child !== undefined;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  call(
    generation: number,
    [method, args]: DesktopControlCall,
    current?: () => boolean,
  ): Promise<unknown> {
    const child = this.child;
    const confirm = method === "confirm";
    if (!this.ready || !child || this.pending.size >= 64) {
      return confirm ? Promise.resolve(cancelled) : Promise.reject(unavailable());
    }
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.revoke(generation);
        this.detach(child);
      }, 75_000).unref();
      const p = { child, generation, confirm, current, granted: false, resolve, reject, timer };
      this.pending.set(id, p);
      try {
        child.postMessage({ type: "mijia-desktop:request", id, generation, method, args });
      } catch {
        this.detach(child);
      }
    });
  }

  revoke(generation: number): void {
    for (const [id, p] of this.pending) if (p.generation === generation) this.finish(id, p, false);
    const child = this.child;
    if (child) {
      try {
        child.postMessage({ type: "mijia-desktop:revoke", generation });
      } catch {
        this.detach(child);
      }
    }
  }

  private finish(id: number, p: Pending, ok: boolean, value?: unknown): void {
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (!p.confirm) {
      if (ok) p.resolve(value);
      else p.reject(unavailable());
    } else if (p.granted) {
      p.resolve(ok ? value : unknown);
    } else {
      // Before a grant Host can report refusals, but not a receipt.
      const outcome = value as DesktopControlOutcome | undefined;
      p.resolve(ok && outcome?.state === "not-sent" ? outcome : cancelled);
    }
  }
}

/** One local main document, never the pet, an iframe, or the Vite HTTP page. */
export function registerDesktopMijia(transport: DesktopMijiaTransport) {
  let window: BrowserWindow | undefined;
  let expected: string | undefined;
  let loaded = false;
  let connected = false;
  let generation = 0;
  let current: { generation: number; ticket: string } | undefined;
  const matches = (url: string) => expected !== undefined && url.split("#", 1)[0] === expected;
  const announce = () => {
    if (!window || window.isDestroyed() || window.webContents.isDestroyed() || !loaded) return;
    const frame = window.webContents.mainFrame;
    if (!frame.detached && matches(frame.url))
      frame.send("mijia-desktop:document", current?.ticket);
  };
  const revoke = (notify = true) => {
    const old = current;
    current = undefined;
    if (old) transport.revoke(old.generation);
    if (notify) announce();
  };
  const refresh = () => {
    if (
      !window ||
      window.isDestroyed() ||
      !window.isVisible() ||
      window.isMinimized() ||
      !loaded ||
      !connected ||
      !transport.available() ||
      !matches(window.webContents.mainFrame.url)
    ) {
      revoke();
      return;
    }
    current ??= { generation: ++generation, ticket: randomUUID() };
    announce();
  };
  transport.subscribe(refresh);
  const trusted = (event: IpcMainInvokeEvent, ticket: unknown) =>
    window &&
    !window.isDestroyed() &&
    window.isVisible() &&
    !window.isMinimized() &&
    loaded &&
    current &&
    event.sender === window.webContents &&
    event.senderFrame !== null &&
    event.senderFrame === window.webContents.mainFrame &&
    matches(event.senderFrame.url) &&
    ticket === current.ticket &&
    connected &&
    transport.available();

  ipcMain.handle("mijia-desktop:call", (event, ticket: unknown, method: unknown, args: unknown) => {
    if (method === "available") return Boolean(trusted(event, ticket));
    const document = current;
    const call = parseDesktopControlCall(method, args);
    if (!call) throw unavailable();
    if (!document || !trusted(event, ticket)) {
      if (call[0] === "confirm") return cancelled;
      throw unavailable();
    }
    return transport.call(
      document.generation,
      call,
      () => current === document && !!trusted(event, ticket),
    );
  });

  return {
    connection(value: boolean): void {
      connected = value;
      refresh();
    },
    watch(win: BrowserWindow, fileUrl: string | undefined): void {
      revoke(false);
      window = win;
      expected = fileUrl;
      loaded = false;
      const retire = () => {
        if (window !== win) return;
        loaded = false;
        revoke(false);
      };
      const changed = () => {
        if (window === win) refresh();
      };
      win.webContents.on("did-start-navigation", (event) => {
        if (event.isMainFrame && !event.isSameDocument) retire();
      });
      win.webContents.on("did-finish-load", () => {
        if (window !== win) return;
        loaded = matches(win.webContents.mainFrame.url);
        refresh();
      });
      win.webContents.on("render-process-gone", retire);
      win.on("hide", changed);
      win.on("show", changed);
      win.on("minimize", () => {
        if (window === win) revoke();
      });
      win.on("restore", changed);
      win.on("close", () => {
        if (window === win) revoke();
      });
      win.on("closed", () => {
        if (window !== win) return;
        retire();
        window = undefined;
      });
    },
  };
}
