// A small Chrome DevTools Protocol client (ADR 0058): 知乎 runs in a headless Chrome with its own
// profile, so the site's own scripts sign every request. This launches that Chrome, opens pages,
// evaluates scripts in them and reads the answers the pages fetched.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";

/** Where Chrome usually is on a Mac. */
const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];
const START_MS = 20_000;
const CALL_MS = 30_000;

export function findChrome(): string | undefined {
  return CHROME_PATHS.find((p) => existsSync(p));
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An answer a page fetched from the site's API. */
export interface PageResponse {
  url: string;
  status: number;
  body: string;
}

/** One tab. */
export class CdpPage {
  private id = 0;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly seen: { requestId: string; url: string; status: number }[] = [];
  private closed = false;

  private readonly ws: WebSocket;
  readonly targetId: string;

  constructor(ws: WebSocket, targetId: string) {
    this.ws = ws;
    this.targetId = targetId;
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
        method?: string;
        params?: { requestId: string; response: { url: string; status: number } };
      };
      if (d.id !== undefined) {
        const p = this.pending.get(d.id);
        if (p === undefined) return;
        this.pending.delete(d.id);
        if (d.error !== undefined) p.reject(new Error(d.error.message));
        else p.resolve(d.result);
        return;
      }
      if (d.method === "Network.responseReceived" && d.params !== undefined) {
        const { requestId, response } = d.params;
        if (response.url.includes("/api/")) {
          this.seen.push({ requestId, url: response.url, status: response.status });
        }
      }
    };
    ws.onclose = () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("the page closed"));
      this.pending.clear();
    };
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error("the page closed"));
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} took too long`));
      }, CALL_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Opens a URL and waits for the page and its first requests to settle. */
  async go(url: string, settleMs = 3_000): Promise<void> {
    this.seen.length = 0;
    await this.send("Page.navigate", { url });
    await this.waitFor("document.readyState === 'complete'", 20_000);
    await sleep(settleMs);
  }

  /** Runs a script in the page and returns its value (promises are awaited). */
  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send<{
      result: { value?: T };
      exceptionDetails?: { exception?: { description?: string }; text: string };
    }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails !== undefined) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value as T;
  }

  /** Waits until an expression is true in the page. */
  async waitFor(expression: string, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      try {
        if (await this.evaluate<boolean>(`Boolean(${expression})`)) return true;
      } catch {
        // the page is changing
      }
      await sleep(300);
    }
    return false;
  }

  /** The API answers the page fetched since the last `go`, whose URL contains `part`. */
  async responses(part: string): Promise<PageResponse[]> {
    const out: PageResponse[] = [];
    for (const r of this.seen.filter((s) => s.url.includes(part))) {
      try {
        const b = await this.send<{ body: string; base64Encoded: boolean }>(
          "Network.getResponseBody",
          { requestId: r.requestId },
        );
        const body = b.base64Encoded ? Buffer.from(b.body, "base64").toString("utf8") : b.body;
        out.push({ url: r.url, status: r.status, body });
      } catch {
        // the body is gone
      }
    }
    return out;
  }

  /** A PNG of one element, as a data URL. */
  async shot(selector: string): Promise<string | undefined> {
    const box = await this.evaluate<{ x: number; y: number; w: number; h: number } | null>(
      `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })()`,
    );
    if (box === null || box.w === 0) return undefined;
    const s = await this.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      clip: { x: box.x - 8, y: box.y - 8, width: box.w + 16, height: box.h + 16, scale: 3 },
    });
    return `data:image/png;base64,${s.data}`;
  }

  async cookies(url: string): Promise<{ name: string; value: string }[]> {
    const r = await this.send<{ cookies: { name: string; value: string }[] }>(
      "Network.getCookies",
      { urls: [url] },
    );
    return r.cookies;
  }

  close(): void {
    this.ws.close();
  }
}

/** A headless Chrome with its own profile folder. */
export class Chrome {
  private child: ChildProcess | undefined;
  private port = 0;

  private readonly profile: string;
  private readonly onExit: (code: number | null) => void;

  constructor(profile: string, onExit: (code: number | null) => void) {
    this.profile = profile;
    this.onExit = onExit;
  }

  running(): boolean {
    return this.child !== undefined;
  }

  async start(): Promise<void> {
    if (this.child !== undefined) return;
    const bin = findChrome();
    if (bin === undefined) throw new Error("需要先安装 Google Chrome");
    mkdirSync(this.profile, { recursive: true, mode: 0o700 });
    this.port = await freePort();
    const child = spawn(
      bin,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${this.profile}`,
        `--remote-debugging-port=${this.port}`,
        "--remote-debugging-address=127.0.0.1",
        "--window-size=1280,900",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    this.child = child;
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.onExit(code);
    });
    const until = Date.now() + START_MS;
    while (Date.now() < until) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/json/version`);
        if (res.ok) return;
      } catch {
        // not up yet
      }
      await sleep(300);
    }
    this.stop();
    throw new Error("Chrome 没有启动起来");
  }

  /** Opens a new tab. */
  async open(url = "about:blank"): Promise<CdpPage> {
    const res = await fetch(`http://127.0.0.1:${this.port}/json/new?${url}`, { method: "PUT" });
    const target = (await res.json()) as { id: string; webSocketDebuggerUrl: string };
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("could not reach the Chrome tab"));
    });
    const page = new CdpPage(ws, target.id);
    await page.send("Page.enable");
    await page.send("Network.enable");
    return page;
  }

  /** Closes a tab. */
  async closePage(page: CdpPage): Promise<void> {
    page.close();
    await fetch(`http://127.0.0.1:${this.port}/json/close/${page.targetId}`).catch(() => {});
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    child?.kill();
  }
}
