// Mail the owner asked to be told about (docs/spec/04-herder.md "Mail", ADR 0048). Nothing is
// watched until the owner asks the Herder for it; AgentHerd then looks at Gmail through the
// owner's Composio connection every few minutes, and only while at least one watch exists.

import { randomUUID } from "node:crypto";
import type { Clock, Timer } from "./clock.ts";
import { type HerdContext, say } from "./herd-context.ts";
import type { AppTools } from "./mcp-gateway.ts";
import { MULTI_EXECUTE } from "./mcp-gateway.ts";
import type { MailWatch } from "./store.ts";

export const MAIL_POLL_MINUTES = 3;
/** Watches at most; asking for more is refused. */
export const MAIL_WATCHES_MAX = 10;
/** Messages read per watch and look. */
const FETCH_MAX = 10;
/** Messages listed in one owner message; the rest are counted. */
const TOLD_MAX = 5;
const SEEN_MAX = 200;
const PREVIEW_MAX = 100;
const FETCH_SLUG = "GMAIL_FETCH_EMAILS";

/** One message as AgentHerd tells it. */
export interface MailMessage {
  id: string;
  sender: string;
  subject: string;
  preview: string;
  url: string;
  at: string;
}

export interface MailWatchOptions {
  /** The owner's connected apps now, if any. */
  apps: () => AppTools | undefined;
  pollMinutes?: number;
}

// Mail previews pad with invisible characters so clients show less of the next line.
const INVISIBLE =
  /\u034f|[\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u2028-\u202f\u2060-\u206f\u3164\ufeff\uffa0]/g;

function tidy(text: string, max: number): string {
  const t = text.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** "Name <a@b.c>" → "Name"; a bare address stays. */
function senderName(sender: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(sender);
  if (m === null) return sender.trim();
  return (m[1] ?? "").trim() || (m[2] ?? "").trim();
}

interface FetchedMessage {
  messageId?: string;
  sender?: string;
  subject?: string;
  messageTimestamp?: string;
  display_url?: string;
  preview?: { body?: string };
}

/** Runs one Gmail search through Composio; newest first, as Gmail answers. */
export async function fetchMail(
  apps: AppTools,
  query: string,
  max = FETCH_MAX,
): Promise<MailMessage[]> {
  const result = (await apps.call(MULTI_EXECUTE, {
    tools: [
      {
        tool_slug: FETCH_SLUG,
        arguments: { query, max_results: max, include_payload: false, verbose: false },
      },
    ],
  })) as { content?: { type?: string; text?: string }[]; isError?: boolean };
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";
  if (result.isError === true) throw new Error(tidy(text, 300) || "Gmail search failed");
  let body: {
    successful?: boolean;
    error?: unknown;
    data?: {
      results?: {
        response?: {
          successful?: boolean;
          error?: unknown;
          data?: { messages?: FetchedMessage[] };
        };
      }[];
    };
  };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error(`unexpected Gmail answer: ${tidy(text, 200)}`);
  }
  const response = body.data?.results?.[0]?.response;
  if (body.successful === false || response === undefined || response.successful === false) {
    const why = response?.error ?? body.error ?? "Gmail search failed";
    throw new Error(typeof why === "string" ? why : JSON.stringify(why));
  }
  return (response.data?.messages ?? [])
    .filter((m) => typeof m.messageId === "string" && m.messageId !== "")
    .map((m) => ({
      id: m.messageId as string,
      sender: senderName(m.sender ?? ""),
      subject: tidy(m.subject ?? "", PREVIEW_MAX) || "(no subject)",
      preview: tidy(m.preview?.body ?? "", PREVIEW_MAX),
      url: m.display_url ?? `https://mail.google.com/mail/u/0/#all/${m.messageId}`,
      at: m.messageTimestamp ?? "",
    }));
}

/** Gmail's `after:` takes seconds since 1970. */
function searchSince(query: string, createdAt: string): string {
  const after = `after:${Math.floor(Date.parse(createdAt) / 1000)}`;
  return query.trim() === "" ? `in:inbox ${after}` : `(${query.trim()}) ${after}`;
}

export class MailWatches {
  private readonly ctx: HerdContext;
  private readonly apps: () => AppTools | undefined;
  private readonly clock: Clock;
  private readonly pollMs: number;
  private timer: Timer | undefined;
  private running = false;
  private chain: Promise<void> = Promise.resolve();
  private lastError = "";

  constructor(ctx: HerdContext, options: MailWatchOptions) {
    this.ctx = ctx;
    this.apps = options.apps;
    this.clock = ctx.clock;
    this.pollMs = (options.pollMinutes ?? MAIL_POLL_MINUTES) * 60_000;
  }

  start(): void {
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    this.cancel();
  }

  list(): MailWatch[] {
    return this.ctx.store.mailWatches();
  }

  /**
   * Starts telling the owner about mail matching a Gmail search, from now on. Runs the search
   * once first, so a missing Gmail connection or a bad search fails here, not later.
   */
  async add(about: string, query: string): Promise<MailWatch> {
    const { store } = this.ctx;
    const watches = store.mailWatches();
    const same = watches.find((w) => w.query.trim() === query.trim());
    if (same !== undefined) return same;
    if (watches.length >= MAIL_WATCHES_MAX) {
      throw new Error(`at most ${MAIL_WATCHES_MAX} mail watches; remove one first`);
    }
    const apps = this.apps();
    if (apps === undefined) {
      throw new Error(
        "no connected apps: the owner must connect Gmail under Settings → Apps first",
      );
    }
    const createdAt = this.clock.now().toISOString();
    // What is already there is not news.
    const present = await fetchMail(apps, searchSince(query, createdAt));
    const watch: MailWatch = {
      id: randomUUID(),
      about: about.trim() || query.trim(),
      query: query.trim(),
      createdAt,
      seen: present.map((m) => m.id),
    };
    store.saveMailWatch(watch);
    store.audit("mail.watching", { id: watch.id, about: watch.about, query: watch.query });
    this.schedule();
    return watch;
  }

  /** Stops a watch; false when there is no such watch. */
  remove(id: string): boolean {
    const { store } = this.ctx;
    const watch = store.mailWatches().find((w) => w.id === id);
    if (watch === undefined) return false;
    store.deleteMailWatch(id);
    store.audit("mail.unwatched", { id, about: watch.about });
    if (store.mailWatches().length === 0) this.cancel();
    return true;
  }

  /** Looks at every watch now. */
  poll(): Promise<void> {
    this.chain = this.chain.then(() => this.pollAll()).catch((error: Error) => this.failed(error));
    return this.chain;
  }

  /** Waits for the looks already asked for (tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  /** Polls only while something is watched. */
  private schedule(): void {
    if (!this.running || this.timer !== undefined) return;
    if (this.ctx.store.mailWatches().length === 0) return;
    this.timer = this.clock.after(this.pollMs, () => {
      this.timer = undefined;
      void this.poll().finally(() => this.schedule());
    });
  }

  private cancel(): void {
    this.timer?.cancel();
    this.timer = undefined;
  }

  private failed(error: Error): void {
    // Offline or the connection expired: told once in the audit, not every look.
    if (error.message === this.lastError) return;
    this.lastError = error.message;
    this.ctx.store.audit("mail.error", { message: error.message });
  }

  private async pollAll(): Promise<void> {
    const apps = this.apps();
    if (apps === undefined) {
      this.failed(new Error("no connected apps"));
      return;
    }
    for (const watch of this.ctx.store.mailWatches()) {
      try {
        await this.check(watch, await fetchMail(apps, searchSince(watch.query, watch.createdAt)));
        this.lastError = "";
      } catch (error) {
        this.failed(error as Error);
      }
    }
  }

  private async check(watch: MailWatch, messages: MailMessage[]): Promise<void> {
    const { ctx } = this;
    const { store, texts } = ctx;
    const fresh = messages
      .filter((m) => !watch.seen.includes(m.id) && (m.at === "" || m.at >= watch.createdAt))
      .sort((a, b) => a.at.localeCompare(b.at));
    if (fresh.length === 0) return;
    // Removed while Gmail answered: say nothing.
    if (!store.mailWatches().some((w) => w.id === watch.id)) return;
    store.saveMailWatch({
      ...watch,
      seen: [...watch.seen, ...fresh.map((m) => m.id)].slice(-SEEN_MAX),
    });
    store.audit("mail.new", { id: watch.id, about: watch.about, count: fresh.length });
    const shown = fresh.slice(-TOLD_MAX);
    const lines = shown.map((m) => texts.mailLine(m.sender, m.subject, m.preview, m.url));
    if (fresh.length > shown.length) lines.unshift(texts.mailMore(fresh.length - shown.length));
    await say(ctx, texts.mailNew(watch.about, lines.join("\n")));
    // The Herder hears what the owner was told, so "what did it say?" makes sense to it.
    ctx.herder()?.event({
      kind: "mail",
      title: watch.about,
      text: shown.map((m) => `- ${m.sender}: ${m.subject} — ${m.preview}`).join("\n"),
    });
  }
}
