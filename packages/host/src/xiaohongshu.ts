// The owner's 小红书 account (ADR 0058). AgentHerd runs xiaohongshu-mcp
// (github.com/xpzouying/xiaohongshu-mcp, Apache-2.0), a local server that drives a headless
// Chrome with the owner's cookies. The host downloads one pinned release, starts it on
// 127.0.0.1 with a random token, signs in by QR code, reads notices for the watch through its
// REST API, and gives its MCP tools to agents through the gateway, where writes ask first.

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { arch, platform } from "node:os";
import { join } from "node:path";
import type {
  AppToolInfo,
  AppTools,
  McpTool,
  SocialKind,
  SocialNotice,
  SocialSource,
} from "@agentherd/core";
import { type McpHttpClient, mcpHttpClient } from "./composio.ts";

export const XHS_VERSION = "v2.7.4";
const XHS_ASSET = "xiaohongshu-mcp-darwin-arm64";
const XHS_URL = `https://github.com/xpzouying/xiaohongshu-mcp/releases/download/${XHS_VERSION}/${XHS_ASSET}`;
/** Agent tools are named XIAOHONGSHU_<TOOL> so approvals and the owner see where they go. */
export const XHS_PREFIX = "XIAOHONGSHU_";
/** Tools agents never get: signing in and out is the owner's, in the app. */
const XHS_HIDDEN = new Set(["get_login_qrcode", "delete_cookies"]);
/** Tools that only read. Everything else (publish, comment, reply, like, save) asks first. */
const XHS_READS =
  /^(check_login_status|list_feeds|search_feeds|get_feed_detail|user_profile|get_my_profile|get_unread_count|list_notifications)$/;
const START_MS = 30_000;
const LOGIN_WAIT_MS = 4 * 60_000;
const LOGIN_POLL_MS = 1_000;
/**
 * Some answers wrap their result once more (`{data: {data: {...}}}`: notices, unread counts,
 * user/me); others do not (login status). Unwraps the inner one when it is the only field.
 */
function inner(data: unknown): unknown {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const keys = Object.keys(data);
    if (keys.length === 1 && keys[0] === "data") return (data as { data: unknown }).data;
  }
  return data;
}

/** A full status check every this many polls, in case the cookie file change was missed. */
const LOGIN_FULL_CHECK_TICKS = 15;
const LIST_LIMIT = 20;

export type SocialState = "off" | "starting" | "signed-out" | "ready" | "failed";

type Fetch = typeof fetch;

export interface XiaohongshuOptions {
  /** ~/.agentherd */
  home: string;
  /** Keeps the browser's fingerprint the same across restarts. */
  seed: number;
  changed: () => void;
  log?: (line: string) => void;
  fetch?: Fetch;
  /** Tests start a fake server instead. */
  launch?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  /** Tests give a ready file. */
  binary?: () => Promise<string>;
}

interface Wrapped<T> {
  success?: boolean;
  data?: T;
  error?: string;
  details?: unknown;
}

const KIND_TAB: Record<SocialKind, string> = {
  mentions: "mentions",
  likes: "likes",
  follows: "connections",
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export class Xiaohongshu implements SocialSource {
  readonly platform = "xiaohongshu" as const;
  readonly name = "小红书";
  private readonly opts: XiaohongshuOptions;
  private readonly fetchFn: Fetch;
  private child: ChildProcess | undefined;
  private base: string | undefined;
  private token = "";
  private mcp: McpHttpClient | undefined;
  private starting: Promise<void> | undefined;
  private loginTimer: NodeJS.Timeout | undefined;
  state: SocialState = "off";
  account: string | undefined;
  problem: string | undefined;
  checkedAt: string | undefined;

  constructor(opts: XiaohongshuOptions) {
    this.opts = opts;
    this.fetchFn = opts.fetch ?? fetch;
  }

  ready(): boolean {
    return this.state === "ready";
  }

  private set(state: SocialState, problem?: string): void {
    this.state = state;
    this.problem = problem;
    this.opts.changed();
  }

  private dir(): string {
    return join(this.opts.home, "xiaohongshu");
  }

  /** The pinned server binary, downloaded once. */
  private async binary(): Promise<string> {
    if (this.opts.binary !== undefined) return this.opts.binary();
    if (platform() !== "darwin" || arch() !== "arm64") {
      throw new Error("小红书 needs a Mac with Apple silicon for now");
    }
    const dir = join(this.opts.home, "bin");
    const bin = join(dir, `xiaohongshu-mcp-${XHS_VERSION}`);
    if (existsSync(bin)) return bin;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.opts.log?.(`[xiaohongshu] downloading ${XHS_URL}`);
    const res = await this.fetchFn(XHS_URL);
    if (!res.ok) throw new Error(`could not download xiaohongshu-mcp: HTTP ${res.status}`);
    const part = `${bin}.part`;
    writeFileSync(part, Buffer.from(await res.arrayBuffer()));
    chmodSync(part, 0o755);
    renameSync(part, bin);
    return bin;
  }

  /** Starts the server and reads whether the owner is signed in. */
  start(): Promise<void> {
    this.starting ??= this.run().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async run(): Promise<void> {
    if (this.child !== undefined) return;
    this.set("starting");
    try {
      const bin = await this.binary();
      mkdirSync(this.dir(), { recursive: true, mode: 0o700 });
      const port = await freePort();
      this.token = randomBytes(24).toString("hex");
      const env = {
        ...process.env,
        AUTH_TOKEN: this.token,
        COOKIES_PATH: join(this.dir(), "cookies.json"),
        XHS_FP_SEED: String(this.opts.seed),
      };
      const args = ["-port", `127.0.0.1:${port}`];
      const child = (
        this.opts.launch ?? ((b, a, e) => spawn(b, a, { env: e, cwd: this.dir(), stdio: "ignore" }))
      )(bin, args, env);
      this.child = child;
      child.on("exit", (code) => {
        if (this.child !== child) return;
        this.child = undefined;
        this.mcp = undefined;
        this.opts.log?.(`[xiaohongshu] server exited (${code})`);
        if (this.state !== "off") this.set("failed", `小红书服务停了（${code ?? "signal"}）`);
      });
      this.base = `http://127.0.0.1:${port}`;
      this.mcp = mcpHttpClient(`${this.base}/mcp`, this.token, this.fetchFn, true);
      await this.waitUp();
      await this.check();
    } catch (error) {
      this.opts.log?.(`[xiaohongshu] ${(error as Error).message}`);
      this.kill();
      this.set("failed", (error as Error).message);
    }
  }

  private async waitUp(): Promise<void> {
    const until = Date.now() + START_MS;
    while (Date.now() < until) {
      try {
        const res = await this.fetchFn(`${this.base}/health`);
        if (res.ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("小红书服务没有启动起来");
  }

  private async api<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (this.base === undefined) throw new Error("小红书 is not running");
    const res = await this.fetchFn(`${this.base}/api/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await res.json().catch(() => ({}))) as Wrapped<T>;
    if (!res.ok || json.success === false) {
      throw new Error(
        `小红书 ${path}: ${json.error ?? `HTTP ${res.status}`}${json.details ? ` (${String(json.details)})` : ""}`,
      );
    }
    return inner(json.data) as T;
  }

  /** Reads whether the owner is signed in. */
  async check(): Promise<void> {
    const status = await this.api<{ is_logged_in: boolean; username?: string }>(
      "GET",
      "login/status",
    );
    this.checkedAt = new Date().toISOString();
    if (status.is_logged_in) {
      this.account = status.username;
      this.set("ready");
    } else {
      this.account = undefined;
      this.set("signed-out");
    }
  }

  /** A QR code to scan with the 小红书 app; the state turns ready once scanned. */
  async loginCode(): Promise<{ image: string; signedIn: boolean }> {
    await this.start();
    const code = await this.api<{ is_logged_in: boolean; img?: string }>("GET", "login/qrcode");
    if (code.is_logged_in) {
      await this.check();
      return { image: "", signedIn: true };
    }
    this.watchLogin();
    return { image: code.img ?? "", signedIn: false };
  }

  /**
   * Waits for the scan. The server writes the cookie file the moment the owner scans, and a
   * status check takes several seconds (it opens a page), so the file is watched and the status
   * read as soon as it changes; a full check also runs now and then in case the file was missed.
   */
  private watchLogin(): void {
    if (this.loginTimer !== undefined) clearTimeout(this.loginTimer);
    const until = Date.now() + LOGIN_WAIT_MS;
    const cookies = join(this.dir(), "cookies.json");
    const stamp = () => (existsSync(cookies) ? statSync(cookies).mtimeMs : 0);
    const before = stamp();
    let ticks = 0;
    const tick = async () => {
      this.loginTimer = undefined;
      ticks += 1;
      if (stamp() !== before || ticks % LOGIN_FULL_CHECK_TICKS === 0) {
        try {
          await this.check();
        } catch {
          // try again
        }
      }
      if (this.state !== "ready" && this.child !== undefined && Date.now() < until) {
        this.loginTimer = setTimeout(() => void tick(), LOGIN_POLL_MS);
      }
    };
    this.loginTimer = setTimeout(() => void tick(), LOGIN_POLL_MS);
  }

  async logout(): Promise<void> {
    await this.api("DELETE", "login/cookies");
    this.account = undefined;
    this.set("signed-out");
  }

  /** Stops the server without changing what the app shows (the host is shutting down). */
  kill(): void {
    if (this.loginTimer !== undefined) clearTimeout(this.loginTimer);
    this.loginTimer = undefined;
    const child = this.child;
    this.child = undefined;
    this.mcp = undefined;
    this.base = undefined;
    child?.kill();
  }

  /** Stops the server; the cookies stay for next time. */
  stop(): void {
    this.kill();
    this.account = undefined;
    this.set("off");
  }

  async unread(): Promise<Partial<Record<SocialKind, number>>> {
    const c = await this.api<{ mentions: number; likes: number; connections: number }>(
      "GET",
      "notifications/unread",
    );
    return { mentions: c.mentions, likes: c.likes, follows: c.connections };
  }

  async notices(kind: SocialKind): Promise<SocialNotice[]> {
    const list = await this.api<{
      items?: {
        id: string;
        title?: string;
        from?: { nickname?: string };
        comment_text?: string;
        feed_id?: string;
        feed_xsec_token?: string;
        feed_title?: string;
      }[];
    }>("POST", "notifications/list", { tab: KIND_TAB[kind], limit: LIST_LIMIT });
    return (list.items ?? []).map((item) => ({
      id: item.id,
      kind,
      who: item.from?.nickname ?? "?",
      text: kind === "mentions" ? (item.comment_text ?? item.title ?? "") : "",
      ...(item.feed_title ? { on: item.feed_title } : {}),
      ...(item.feed_id
        ? {
            url: `https://www.xiaohongshu.com/explore/${item.feed_id}${item.feed_xsec_token ? `?xsec_token=${encodeURIComponent(item.feed_xsec_token)}` : ""}`,
          }
        : {}),
    }));
  }

  /** The server's tools for agents, while the owner is signed in. */
  tools(): AppTools | undefined {
    const mcp = this.mcp;
    if (mcp === undefined || this.state !== "ready") return undefined;
    return {
      list: async () =>
        (await mcp.listTools())
          .filter((t) => !XHS_HIDDEN.has(t.name))
          .map((t): McpTool => ({ ...t, name: `${XHS_PREFIX}${t.name.toUpperCase()}` })),
      describe: async (slugs) => {
        const out = new Map<string, AppToolInfo>();
        for (const slug of slugs) {
          const name = slug.slice(XHS_PREFIX.length).toLowerCase();
          out.set(slug, {
            title: `小红书 ${name.replace(/_/g, " ")}`,
            toolkit: "xiaohongshu",
            // Writes (publish, comment, reply, like, save) also leave the Mac: they ask (ADR 0056).
            hints: {
              readOnly: XHS_READS.test(name),
              create: !XHS_READS.test(name),
              update: false,
              destructive: false,
            },
          });
        }
        return out;
      },
      call: async (name, args) => {
        const tool = name.slice(XHS_PREFIX.length).toLowerCase();
        if (XHS_HIDDEN.has(tool)) throw new Error(`unknown tool ${name}`);
        return mcp.callTool(tool, args);
      },
    };
  }
}
