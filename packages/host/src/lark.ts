// The owner's 飞书 through the official lark-cli (ADR 0059). AgentHerd does not talk to the docs,
// calendar or base APIs itself: it finds or installs lark-cli, sets it up with AgentHerd's own
// Feishu app when it has none, signs the owner in by QR (device flow), and tells every new task
// that lark-cli is there. What a lark-cli command may do is decided in rules/outbound.ts.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export type LarkState = "missing" | "installing" | "no-app" | "signed-out" | "ready" | "failed";

export interface LarkView {
  state: LarkState;
  /** The owner's name in 飞书, when signed in. */
  account?: string;
  version?: string;
  problem?: string;
  checkedAt?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Run = (
  file: string,
  args: readonly string[],
  opts?: { input?: string; timeoutMs?: number },
) => Promise<RunResult>;

/** The domains a sign-in asks for: what agents need for docs, sheets, base, calendar and tasks. */
export const LARK_DOMAINS = [
  "docs",
  "drive",
  "wiki",
  "sheets",
  "base",
  "markdown",
  "slides",
  "calendar",
  "task",
  "minutes",
  "contact",
  "im",
];
const PACKAGE = "@larksuite/cli";
const LOGIN_WAIT_MS = 10 * 60_000;

export const runFile: Run = (file, args, opts = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      { timeout: opts.timeoutMs ?? 60_000, maxBuffer: 8 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });

/** JSON in a lark-cli answer (it prints errors as JSON on stderr). */
function json(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  try {
    return JSON.parse(text.slice(start)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export interface LarkOptions {
  changed: () => void;
  log?: (line: string) => void;
  run?: Run;
  /** Where to look for lark-cli besides PATH. */
  dirs?: readonly string[];
  /** AgentHerd's own Feishu app, to set lark-cli up when it has no app yet. */
  app?: () => Promise<{ appId: string; secret: string; brand: string } | undefined>;
  /** A QR code image (data URL) for a link. */
  qr: (url: string) => Promise<string>;
}

export class Lark {
  private readonly opts: LarkOptions;
  private readonly run: Run;
  private view: LarkView = { state: "signed-out" };
  private bin: string | undefined;
  private waiting = false;

  constructor(opts: LarkOptions) {
    this.opts = opts;
    this.run = opts.run ?? runFile;
  }

  current(): LarkView {
    return this.view;
  }

  private set(view: LarkView): void {
    this.view = { ...view, checkedAt: new Date().toISOString() };
    this.opts.changed();
  }

  /** lark-cli on PATH or in the usual install places. */
  find(): string | undefined {
    const dirs = [
      ...(process.env.PATH ?? "").split(delimiter),
      join(homedir(), ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      ...(this.opts.dirs ?? []),
    ];
    for (const d of dirs) {
      if (d !== "" && existsSync(join(d, "lark-cli"))) return join(d, "lark-cli");
    }
    return undefined;
  }

  /** Looks again: installed, set up, signed in. */
  async check(): Promise<LarkView> {
    this.bin = this.find();
    if (this.bin === undefined) {
      this.set({ state: "missing" });
      return this.view;
    }
    const version = (await this.run(this.bin, ["--version"])).stdout.match(/[\d.]+/)?.[0];
    const status = await this.run(this.bin, ["auth", "status"]);
    const answer = json(status.stdout) ?? json(status.stderr);
    const base = version === undefined ? {} : { version };
    const error = answer?.error as { subtype?: string; message?: string } | undefined;
    if (error?.subtype === "not_configured") {
      this.set({ ...base, state: "no-app" });
    } else if (error !== undefined || answer === undefined) {
      this.set({
        ...base,
        state: "failed",
        problem: error?.message ?? status.stderr.trim().slice(0, 200),
      });
    } else {
      const user = (
        answer.identities as { user?: { status?: string; userName?: string; tokenStatus?: string } }
      )?.user;
      if (user?.status === "ready") {
        this.set({ ...base, state: "ready", ...(user.userName ? { account: user.userName } : {}) });
      } else {
        this.set({ ...base, state: "signed-out" });
      }
    }
    return this.view;
  }

  private async install(): Promise<void> {
    const npm = [
      "npm",
      join(homedir(), ".local", "bin", "npm"),
      "/opt/homebrew/bin/npm",
      "/usr/local/bin/npm",
    ];
    this.set({ state: "installing" });
    for (const n of npm) {
      if (n !== "npm" && !existsSync(n)) continue;
      const r = await this.run(n, ["install", "-g", PACKAGE], { timeoutMs: 5 * 60_000 });
      if (r.code === 0) {
        this.opts.log?.(`[lark] installed ${PACKAGE}`);
        return;
      }
      if (!/ENOENT/.test(r.stderr))
        throw new Error(`npm install -g ${PACKAGE} failed: ${r.stderr.trim().slice(-200)}`);
    }
    throw new Error("npm was not found; install Node.js, then try again");
  }

  /** Installs and sets up lark-cli if needed, then starts a QR sign-in. */
  async connect(): Promise<{ image: string; url: string }> {
    let view = await this.check();
    try {
      if (view.state === "missing") {
        await this.install();
        view = await this.check();
        if (view.state === "missing") throw new Error("lark-cli was installed but cannot be found");
      }
      const bin = this.bin as string;
      if (view.state === "no-app") {
        const app = await this.opts.app?.();
        if (app === undefined) throw new Error("connect Feishu in AgentHerd first");
        const r = await this.run(
          bin,
          ["config", "init", "--app-id", app.appId, "--app-secret-stdin", "--brand", app.brand],
          { input: `${app.secret}\n` },
        );
        if (r.code !== 0)
          throw new Error(
            (json(r.stderr)?.error as { message?: string })?.message ?? r.stderr.trim(),
          );
      }
      const login = await this.run(bin, [
        "auth",
        "login",
        "--no-wait",
        "--json",
        "--domain",
        LARK_DOMAINS.join(","),
      ]);
      const started = json(login.stdout) ?? json(login.stderr);
      const url = started?.verification_url as string | undefined;
      const code = started?.device_code as string | undefined;
      if (url === undefined || code === undefined) {
        throw new Error(
          ((started?.error as { message?: string }) ?? {}).message ??
            "lark-cli gave no sign-in link",
        );
      }
      const image = await this.opts.qr(url);
      this.set({ ...this.view, state: "signed-out" });
      this.wait(bin, code);
      return { image, url };
    } catch (error) {
      this.set({ state: "failed", problem: (error as Error).message });
      throw error;
    }
  }

  /** Finishes the sign-in in the background once the owner has scanned. */
  private wait(bin: string, code: string): void {
    if (this.waiting) return;
    this.waiting = true;
    void this.run(bin, ["auth", "login", "--device-code", code], { timeoutMs: LOGIN_WAIT_MS })
      .then((r) => {
        if (r.code !== 0)
          this.opts.log?.(`[lark] sign-in did not finish: ${r.stderr.trim().slice(0, 200)}`);
      })
      .finally(() => {
        this.waiting = false;
        void this.check();
      });
  }

  async logout(): Promise<void> {
    const bin = this.bin ?? this.find();
    if (bin !== undefined) await this.run(bin, ["auth", "logout"]);
    await this.check();
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    const v = await this.check();
    if (v.state === "ready") return { ok: true, message: `连接正常，账号「${v.account ?? "?"}」` };
    if (v.state === "missing")
      return { ok: false, message: "还没装 lark-cli，点「连接」会自动安装" };
    if (v.state === "no-app" || v.state === "signed-out")
      return { ok: false, message: "还没登录，点「连接」扫码" };
    return { ok: false, message: `连不上：${v.problem ?? "未知原因"}` };
  }

  /** What every new task is told when 飞书 is signed in. */
  note(): string | undefined {
    if (this.view.state !== "ready") return undefined;
    return [
      `飞书: lark-cli is installed and signed in as the owner${this.view.account ? ` (${this.view.account})` : ""}.`,
      "Use it for 飞书 docs, wiki, sheets, base, calendar, tasks and minutes: `lark-cli <domain> --help`, guides with `lark-cli skills read lark-doc` (or lark-sheets, lark-base, lark-calendar …).",
      "Reading and creating new docs run at once; changing existing docs, sheets or events, and messages, wait for the owner's OK.",
    ].join(" ");
  }
}
