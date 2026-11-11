// Notices on the owner's 小红书 and 知乎 accounts (ADR 0058). The host signs in and reads; this
// decides what to watch, how often to look, and what to tell. Looks are rare on purpose: every
// look is a browser visit with the owner's account, and a platform that thinks it sees a robot
// may limit or close the account.

import type { Clock, Timer } from "./clock.ts";
import { type HerdContext, say } from "./herd-context.ts";

export type SocialPlatform = "xiaohongshu" | "zhihu";
export type SocialKind = "mentions" | "likes" | "follows";

export const SOCIAL_PLATFORMS: readonly SocialPlatform[] = ["xiaohongshu", "zhihu"];
export const SOCIAL_KINDS: readonly SocialKind[] = ["mentions", "likes", "follows"];

/** Minutes between looks, and how far each look may move either way (so they do not tick). */
export const SOCIAL_POLL_MINUTES = 20;
export const SOCIAL_JITTER_MINUTES = 5;
/** Notices listed in one owner message; the rest are counted. */
const TOLD_MAX = 3;
const TEXT_MAX = 80;
const SEEN_MAX = 300;

/** What a new platform watches until the owner changes it (ADR 0058). */
export const DEFAULT_SOCIAL_WATCH: Readonly<Record<SocialKind, boolean>> = {
  mentions: true,
  likes: false,
  follows: false,
};

/** One notice on the owner's account. Everything but `id` and `kind` is someone else's text. */
export interface SocialNotice {
  id: string;
  kind: SocialKind;
  /** Who did it. */
  who: string;
  /** What they wrote, for comments, answers and @; empty for likes and follows. */
  text: string;
  /** The post or question it is on. */
  on?: string;
  url?: string;
}

/** One platform as the host gives it to the watch. */
export interface SocialSource {
  platform: SocialPlatform;
  /** 小红书 / 知乎 */
  name: string;
  /** Turned on and signed in. */
  ready(): boolean;
  /** Unread notices by kind, without marking them read. */
  unread(): Promise<Partial<Record<SocialKind, number>>>;
  /** The latest notices of a kind; reading them may mark them read on the platform. */
  notices(kind: SocialKind): Promise<SocialNotice[]>;
}

export interface SocialWatchOptions {
  sources: () => readonly SocialSource[];
  pollMinutes?: number;
  jitterMinutes?: number;
  /** 0..1; tests pass a fixed one. */
  random?: () => number;
  /** Called when what is watched changes, for the app. */
  changed?: () => void;
}

/** What is watched and what was seen, per platform; kept in herd.db state. */
interface PlatformState {
  watch: Record<SocialKind, boolean>;
  /** Notice ids already handled, by kind; a kind without a list was never looked at. */
  seen: Partial<Record<SocialKind, string[]>>;
  checkedAt?: string;
  activeAt?: string;
}

const STATE_KEY = "social.watch";

const clip = (text: string, max = TEXT_MAX) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

export class SocialWatches {
  private readonly ctx: HerdContext;
  private readonly opts: SocialWatchOptions;
  private readonly clock: Clock;
  private timer: Timer | undefined;
  private running = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(ctx: HerdContext, opts: SocialWatchOptions) {
    this.ctx = ctx;
    this.opts = opts;
    this.clock = ctx.clock;
  }

  start(): void {
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    this.timer?.cancel();
    this.timer = undefined;
  }

  private all(): Partial<Record<SocialPlatform, PlatformState>> {
    return {
      ...(this.ctx.store.getState<Partial<Record<SocialPlatform, PlatformState>>>(STATE_KEY) ?? {}),
    };
  }

  private state(platform: SocialPlatform): PlatformState {
    const saved = this.all()[platform];
    return {
      watch: { ...DEFAULT_SOCIAL_WATCH, ...saved?.watch },
      seen: { ...saved?.seen },
      ...(saved?.checkedAt === undefined ? {} : { checkedAt: saved.checkedAt }),
      ...(saved?.activeAt === undefined ? {} : { activeAt: saved.activeAt }),
    };
  }

  private save(platform: SocialPlatform, state: PlatformState): void {
    this.ctx.store.setState(STATE_KEY, { ...this.all(), [platform]: state });
  }

  /** What the platform's watch tells the owner about. */
  watch(platform: SocialPlatform): Record<SocialKind, boolean> {
    return this.state(platform).watch;
  }

  checkedAt(platform: SocialPlatform): string | undefined {
    return this.state(platform).checkedAt;
  }

  activeAt(platform: SocialPlatform): string | undefined {
    return this.state(platform).activeAt;
  }

  /** Turns telling about one kind on or off. */
  setWatch(platform: SocialPlatform, kind: SocialKind, on: boolean): void {
    const state = this.state(platform);
    if (state.watch[kind] === on) return;
    state.watch[kind] = on;
    // Turned on again later: what came meanwhile is not news.
    if (!on) delete state.seen[kind];
    this.save(platform, state);
    this.ctx.store.audit("social.watch", { platform, kind, on });
    this.opts.changed?.();
    this.schedule();
  }

  /** Looks at every ready platform now. */
  poll(): Promise<void> {
    this.chain = this.chain.then(() => this.pollAll());
    return this.chain;
  }

  /** Waits for the looks already asked for (tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  private active(): SocialSource[] {
    return this.opts
      .sources()
      .filter((s) => s.ready() && SOCIAL_KINDS.some((k) => this.state(s.platform).watch[k]));
  }

  /** Looks only while some ready platform watches something. */
  schedule(): void {
    if (!this.running || this.timer !== undefined) return;
    if (this.active().length === 0) return;
    const base = (this.opts.pollMinutes ?? SOCIAL_POLL_MINUTES) * 60_000;
    const jitter = (this.opts.jitterMinutes ?? SOCIAL_JITTER_MINUTES) * 60_000;
    const random = this.opts.random ?? Math.random;
    const ms = Math.max(60_000, base + (random() * 2 - 1) * jitter);
    this.timer = this.clock.after(ms, () => {
      this.timer = undefined;
      void this.poll().finally(() => this.schedule());
    });
  }

  private async pollAll(): Promise<void> {
    for (const source of this.active()) {
      try {
        await this.look(source);
      } catch (error) {
        this.ctx.store.audit("social.error", {
          platform: source.platform,
          message: (error as Error).message,
        });
      }
    }
  }

  private async look(source: SocialSource): Promise<void> {
    const { store } = this.ctx;
    const unread = await source.unread();
    const state = this.state(source.platform);
    state.checkedAt = this.clock.now().toISOString();
    const fresh: SocialNotice[] = [];
    for (const kind of SOCIAL_KINDS) {
      if (!state.watch[kind]) continue;
      const known = state.seen[kind];
      // Only open the list when there is something unread, or to learn what is already there.
      if (known !== undefined && (unread[kind] ?? 0) === 0) continue;
      const notices = (await source.notices(kind)).filter((n) => n.kind === kind);
      const ids = notices.map((n) => n.id);
      if (known === undefined) {
        // The first look: what is already there is not news.
        state.seen[kind] = ids.slice(0, SEEN_MAX);
        continue;
      }
      const added = notices.filter((n) => !known.includes(n.id));
      state.seen[kind] = [...added.map((n) => n.id), ...known].slice(0, SEEN_MAX);
      fresh.push(...added);
    }
    // Turned off while the platform answered: keep its state, say nothing.
    if (!this.opts.sources().some((s) => s.platform === source.platform && s.ready())) return;
    if (fresh.length > 0) state.activeAt = state.checkedAt;
    this.save(source.platform, state);
    this.opts.changed?.();
    if (fresh.length === 0) return;
    store.audit("social.new", {
      platform: source.platform,
      count: fresh.length,
      kinds: [...new Set(fresh.map((n) => n.kind))],
    });
    await say(this.ctx, this.ownerText(source.name, fresh));
    // The Herder hears what the owner was told, so "reply to her" makes sense to it.
    this.ctx.herder()?.event({
      kind: "social",
      title: source.name,
      text: fresh
        .slice(0, TOLD_MAX * 3)
        .map(
          (n) =>
            `- ${n.kind} ${n.who}${n.on ? ` on "${clip(n.on, 40)}"` : ""}: ${clip(n.text)} [id ${n.id}]`,
        )
        .join("\n"),
    });
  }

  /** Comments and @ one per line; likes and follows counted. */
  private ownerText(name: string, fresh: SocialNotice[]): string {
    const { texts } = this.ctx;
    const mentions = fresh.filter((n) => n.kind === "mentions");
    const lines = mentions
      .slice(0, TOLD_MAX)
      .map((n) =>
        texts.socialMention(n.who, clip(n.text), n.on === undefined ? "" : clip(n.on, 30)),
      );
    if (mentions.length > TOLD_MAX) lines.push(texts.socialMore(mentions.length - TOLD_MAX));
    const likes = fresh.filter((n) => n.kind === "likes").length;
    const follows = fresh.filter((n) => n.kind === "follows").length;
    if (likes > 0) lines.push(texts.socialLikes(likes));
    if (follows > 0) lines.push(texts.socialFollows(follows));
    return texts.socialNew(name, lines.join("\n"));
  }
}
