// The owner's 小红书 and 知乎 accounts in the host (ADR 0058): which are turned on, starting and
// stopping their local servers or browser, the app's views, and the tools agents get from them.

import { randomInt } from "node:crypto";
import {
  type AppToolInfo,
  type AppTools,
  DEFAULT_SOCIAL_WATCH,
  type McpTool,
  type SocialKind,
  type SocialSource,
} from "@agentherd/core";
import type { SocialPlatform, SocialView } from "./api.ts";
import { type CliConfig, readConfig, writeConfig } from "./config.ts";
import { Xiaohongshu } from "./xiaohongshu.ts";
import { Zhihu } from "./zhihu.ts";

/** One platform's settings in config.json. */
export interface SocialConfig {
  /** Turned on in 应用连接. */
  enabled?: boolean;
  /** When the owner accepted the account-risk notice (ISO). */
  acceptedAt?: string;
  /** Keeps the browser's fingerprint the same across restarts. */
  seed?: number;
}

export interface SocialsOptions {
  home: string;
  changed: () => void;
  log?: (line: string) => void;
  /** Tests give their own platforms. */
  xiaohongshu?: Xiaohongshu;
  zhihu?: Zhihu;
  /** What the herd's watch is set to, when a herd runs. */
  watch?: (platform: SocialPlatform) => Record<SocialKind, boolean> | undefined;
}

const NAMES: Record<SocialPlatform, string> = { xiaohongshu: "小红书", zhihu: "知乎" };
const PLATFORMS = ["xiaohongshu", "zhihu"] as const;

type Platform = Xiaohongshu | Zhihu;

export class Socials {
  private readonly opts: SocialsOptions;
  readonly xiaohongshu: Xiaohongshu;
  readonly zhihu: Zhihu;

  constructor(opts: SocialsOptions) {
    this.opts = opts;
    const log = opts.log === undefined ? {} : { log: opts.log };
    this.xiaohongshu =
      opts.xiaohongshu ??
      new Xiaohongshu({
        home: opts.home,
        seed: this.seed("xiaohongshu"),
        changed: () => opts.changed(),
        ...log,
      });
    this.zhihu =
      opts.zhihu ?? new Zhihu({ home: opts.home, changed: () => opts.changed(), ...log });
  }

  private platform(platform: SocialPlatform): Platform {
    return platform === "zhihu" ? this.zhihu : this.xiaohongshu;
  }

  private config(): CliConfig {
    return readConfig(this.opts.home);
  }

  private settings(platform: SocialPlatform): SocialConfig {
    return this.config().socials?.[platform] ?? {};
  }

  private on(platform: SocialPlatform): boolean {
    return this.settings(platform).enabled === true;
  }

  private save(platform: SocialPlatform, patch: SocialConfig): void {
    const config = this.config();
    writeConfig(this.opts.home, {
      ...config,
      socials: { ...config.socials, [platform]: { ...config.socials?.[platform], ...patch } },
    });
  }

  private seed(platform: SocialPlatform): number {
    const known = this.settings(platform).seed;
    if (known !== undefined) return known;
    const seed = randomInt(1, 2 ** 31 - 1);
    this.save(platform, { seed });
    return seed;
  }

  /** Starts the platforms the owner turned on. */
  start(): void {
    for (const p of PLATFORMS) if (this.on(p)) void this.platform(p).start();
  }

  stop(): void {
    for (const p of PLATFORMS) this.platform(p).kill();
  }

  /** The platforms the herd watches: turned on (ready or not). */
  sources(): SocialSource[] {
    return PLATFORMS.filter((p) => this.on(p)).map((p) => this.platform(p));
  }

  views(): SocialView[] {
    return PLATFORMS.map((platform) => {
      const enabled = this.on(platform);
      const watch = this.opts.watch?.(platform) ?? { ...DEFAULT_SOCIAL_WATCH };
      const x = this.platform(platform);
      return {
        platform,
        name: NAMES[platform],
        available: true,
        accepted: this.settings(platform).acceptedAt !== undefined,
        enabled,
        state: enabled ? x.state : "off",
        ...(enabled && x.account !== undefined ? { account: x.account } : {}),
        ...(enabled && x.problem !== undefined ? { problem: x.problem } : {}),
        watch,
        ...(x.checkedAt === undefined ? {} : { checkedAt: x.checkedAt }),
      };
    });
  }

  async enable(platform: SocialPlatform, accepted: boolean): Promise<void> {
    const before = this.settings(platform).acceptedAt;
    if (!accepted && before === undefined) {
      throw new Error("turning a platform on needs the owner to accept the notice");
    }
    this.save(platform, { enabled: true, acceptedAt: before ?? new Date().toISOString() });
    this.opts.changed();
    await this.platform(platform).start();
  }

  disable(platform: SocialPlatform): void {
    this.save(platform, { enabled: false });
    this.platform(platform).stop();
    this.opts.changed();
  }

  async loginCode(platform: SocialPlatform): Promise<{ image: string; signedIn: boolean }> {
    if (!this.on(platform)) throw new Error(`${NAMES[platform]} is not turned on`);
    return this.platform(platform).loginCode();
  }

  async logout(platform: SocialPlatform): Promise<void> {
    if (!this.on(platform)) return;
    await this.platform(platform).logout();
  }

  /** Checks the platform now (测试连接). */
  async test(platform: SocialPlatform): Promise<{ ok: boolean; message: string }> {
    if (!this.on(platform)) return { ok: false, message: "还没连接" };
    const x = this.platform(platform);
    try {
      if (x.state === "off" || x.state === "failed") await x.start();
      else await x.check();
    } catch (error) {
      return { ok: false, message: `连不上：${(error as Error).message}` };
    }
    if (x.state === "ready") {
      return { ok: true, message: `连接正常${x.account ? `，账号「${x.account}」` : ""}` };
    }
    if (x.state === "signed-out") return { ok: false, message: "登录已失效，点「重连」扫码" };
    return { ok: false, message: x.problem ?? "连不上" };
  }

  /** Tools of the signed-in platforms, beside the owner's Composio apps. */
  tools(composio: AppTools | undefined): AppTools | undefined {
    return combineApps([
      composio,
      ...PLATFORMS.map((p) => (this.on(p) ? this.platform(p).tools() : undefined)),
    ]);
  }
}

/** Several tool sources as one; each tool goes to the source that listed it. */
export function combineApps(parts: (AppTools | undefined)[]): AppTools | undefined {
  const sources = parts.filter((p): p is AppTools => p !== undefined);
  if (sources.length <= 1) return sources[0];
  const owners = new Map<string, AppTools>();
  const ownerOf = async (name: string): Promise<AppTools> => {
    if (!owners.has(name)) {
      for (const s of sources) {
        const tools = await s.list().catch(() => [] as McpTool[]);
        for (const t of tools) if (!owners.has(t.name)) owners.set(t.name, s);
      }
    }
    // Composio's meta tools are not listed by name sometimes; the first source takes the rest.
    return owners.get(name) ?? (sources[0] as AppTools);
  };
  return {
    list: async () => {
      const lists = await Promise.all(sources.map((s) => s.list().catch(() => [] as McpTool[])));
      lists.forEach((tools, i) => {
        for (const t of tools) owners.set(t.name, sources[i] as AppTools);
      });
      return lists.flat();
    },
    describe: async (slugs) => {
      const out = new Map<string, AppToolInfo>();
      for (const slug of slugs) {
        const owner = await ownerOf(slug);
        const info = (await owner.describe([slug])).get(slug);
        if (info !== undefined) out.set(slug, info);
      }
      return out;
    },
    call: async (name, args) => (await ownerOf(name)).call(name, args),
  };
}
