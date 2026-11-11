// Public news sources (ADR 0059): GitHub Trending, Hacker News and arXiv. No sign-in, nothing
// written. The Herder reads them for scheduled digests and marks what it told the owner, so the
// same item is not pushed twice; agents get the same reads as tools.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AppToolInfo,
  AppTools,
  FeedItem,
  FeedQuery,
  FeedSource,
  McpTool,
} from "@agentherd/core";
import { FEED_SOURCES } from "@agentherd/core";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const NAMES: Record<FeedSource, string> = {
  "github-trending": "GitHub Trending",
  "hacker-news": "Hacker News",
  arxiv: "arXiv",
};
const LIMIT_MAX = 30;
const SEEN_MAX = 2000;
const TIMEOUT_MS = 20_000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AgentHerd";

export const FEED_NAMES = NAMES;

const decode = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const num = (s: string | undefined) => Number((s ?? "").replace(/[^\d]/g, "")) || 0;

/** The repositories on a github.com/trending page. */
export function parseTrending(html: string): FeedItem[] {
  return html
    .split('<article class="Box-row">')
    .slice(1)
    .flatMap((a) => {
      const repo = /<h2[\s\S]*?href="\/([^"/]+\/[^"/]+)"/.exec(a)?.[1];
      if (repo === undefined) return [];
      const about = decode(/<p class="[^"]*">([\s\S]*?)<\/p>/.exec(a)?.[1] ?? "");
      const language = decode(/itemprop="programmingLanguage">([^<]*)</.exec(a)?.[1] ?? "");
      const stars = num(decode(/\/stargazers"[^>]*>([\s\S]*?)<\/a>/.exec(a)?.[1] ?? ""));
      const gained = num(/([\d,]+)\s+stars (today|this week|this month)/.exec(a)?.[1]);
      const meta = [language, `${stars} stars`, gained > 0 ? `+${gained}` : ""].filter(Boolean);
      return [
        {
          id: `gh:${repo}`,
          title: repo,
          url: `https://github.com/${repo}`,
          about: [about, meta.join(" · ")].filter(Boolean).join(" — "),
          seen: false,
        },
      ];
    });
}

/** The entries of an arXiv Atom answer. */
export function parseArxiv(xml: string): FeedItem[] {
  return xml
    .split("<entry>")
    .slice(1)
    .flatMap((e) => {
      const url = /<id>([^<]+)<\/id>/.exec(e)?.[1]?.trim();
      const title = decode(/<title>([\s\S]*?)<\/title>/.exec(e)?.[1] ?? "");
      if (url === undefined || title === "") return [];
      const summary = decode(/<summary>([\s\S]*?)<\/summary>/.exec(e)?.[1] ?? "");
      const date = /<published>(\d{4}-\d{2}-\d{2})/.exec(e)?.[1] ?? "";
      const id = url.replace(/^https?:\/\/arxiv\.org\/abs\//, "").replace(/v\d+$/, "");
      return [
        {
          id: `arxiv:${id}`,
          title,
          url,
          about: [date, summary.slice(0, 300)].filter(Boolean).join(" — "),
          seen: false,
        },
      ];
    });
}

interface HnHit {
  objectID: string;
  title?: string;
  url?: string;
  points?: number;
  num_comments?: number;
}
interface HnItem {
  id: number;
  title?: string;
  url?: string;
  score?: number;
  descendants?: number;
}

const hnItem = (id: string, title: string, url: string | undefined, points = 0, comments = 0) => ({
  id: `hn:${id}`,
  title,
  url: url ?? `https://news.ycombinator.com/item?id=${id}`,
  about: `${points} points · ${comments} comments · https://news.ycombinator.com/item?id=${id}`,
  seen: false,
});

export interface FeedsOptions {
  home: string;
  fetch?: Fetch;
  /** Sources the owner turned off in 应用连接 (all are on unless turned off). */
  off?: () => readonly FeedSource[];
}

export class Feeds {
  private readonly opts: FeedsOptions;
  private readonly file: string;

  constructor(opts: FeedsOptions) {
    this.opts = opts;
    this.file = join(opts.home, "feeds", "told.json");
  }

  on(source: FeedSource): boolean {
    return !(this.opts.off?.() ?? []).includes(source);
  }

  /** Reads one source. `mark` records the items as told to the owner (the Herder's digests). */
  async read(source: FeedSource, query: FeedQuery = {}, mark = false): Promise<FeedItem[]> {
    if (!this.on(source)) throw new Error(`${NAMES[source]} is turned off in 应用连接`);
    const limit = Math.min(Math.max(Math.round(query.limit ?? 15), 1), LIMIT_MAX);
    const items = (await this.fetchSource(source, query, limit)).slice(0, limit);
    const told = this.told();
    const out = items.map((i) => ({ ...i, seen: told.has(i.id) }));
    if (mark) {
      for (const i of items) told.add(i.id);
      this.save(told);
    }
    return out;
  }

  private async get(url: string): Promise<string> {
    const f = this.opts.fetch ?? fetch;
    const res = await f(url, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
    return res.text();
  }

  private async fetchSource(source: FeedSource, q: FeedQuery, limit: number): Promise<FeedItem[]> {
    if (source === "github-trending") {
      const since = q.since ?? "daily";
      const lang = q.language?.trim()
        ? `/${encodeURIComponent(q.language.trim().toLowerCase())}`
        : "";
      return parseTrending(await this.get(`https://github.com/trending${lang}?since=${since}`));
    }
    if (source === "arxiv") {
      const words = q.query?.trim() || "cat:cs.AI";
      const search = /^[a-z-]+:/.test(words) ? words : `all:${words}`;
      const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(search)}&sortBy=submittedDate&sortOrder=descending&max_results=${limit}`;
      return parseArxiv(await this.get(url));
    }
    if (q.query?.trim()) {
      const url = `https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=${limit}&query=${encodeURIComponent(q.query.trim())}`;
      const hits = (JSON.parse(await this.get(url)) as { hits?: HnHit[] }).hits ?? [];
      return hits.map((h) => hnItem(h.objectID, h.title ?? "", h.url, h.points, h.num_comments));
    }
    const list = q.since === "weekly" || q.since === "monthly" ? "beststories" : "topstories";
    const ids = (
      JSON.parse(await this.get(`https://hacker-news.firebaseio.com/v0/${list}.json`)) as number[]
    ).slice(0, limit);
    const items = await Promise.all(
      ids.map(
        async (id) =>
          JSON.parse(
            await this.get(`https://hacker-news.firebaseio.com/v0/item/${id}.json`),
          ) as HnItem,
      ),
    );
    return items
      .filter((i) => i?.title)
      .map((i) => hnItem(String(i.id), i.title as string, i.url, i.score, i.descendants));
  }

  private told(): Set<string> {
    try {
      if (!existsSync(this.file)) return new Set();
      return new Set(JSON.parse(readFileSync(this.file, "utf8")) as string[]);
    } catch {
      return new Set();
    }
  }

  private save(told: Set<string>): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify([...told].slice(-SEEN_MAX)));
  }

  /** The same reads for agents, through the MCP gateway (read-only, never marks). */
  tools(): AppTools | undefined {
    const sources = FEED_SOURCES.filter((s) => this.on(s));
    if (sources.length === 0) return undefined;
    const defs: Record<string, { source: FeedSource; tool: McpTool }> = {};
    const prop = (description: string, extra: Record<string, unknown> = {}) => ({
      type: "string",
      description,
      ...extra,
    });
    if (sources.includes("github-trending")) {
      defs.GITHUB_TRENDING = {
        source: "github-trending",
        tool: {
          name: "GITHUB_TRENDING",
          description:
            "GitHub Trending repositories (today, this week or this month), optionally for one language.",
          inputSchema: {
            type: "object",
            properties: {
              since: prop("daily, weekly or monthly", { enum: ["daily", "weekly", "monthly"] }),
              language: prop("a language such as python or typescript"),
              limit: { type: "number", description: "at most 30" },
            },
          },
        },
      };
    }
    if (sources.includes("hacker-news")) {
      defs.HACKER_NEWS = {
        source: "hacker-news",
        tool: {
          name: "HACKER_NEWS",
          description:
            "Hacker News: the front page, the best of the week (since weekly), or stories matching a search query.",
          inputSchema: {
            type: "object",
            properties: {
              query: prop("search words; leave out for the front page"),
              since: prop("weekly gives the best stories", { enum: ["daily", "weekly"] }),
              limit: { type: "number", description: "at most 30" },
            },
          },
        },
      };
    }
    if (sources.includes("arxiv")) {
      defs.ARXIV_SEARCH = {
        source: "arxiv",
        tool: {
          name: "ARXIV_SEARCH",
          description:
            "Newest arXiv papers for search words, or an arXiv query such as cat:cs.AI (the default).",
          inputSchema: {
            type: "object",
            properties: {
              query: prop("words or an arXiv query"),
              limit: { type: "number", description: "at most 30" },
            },
          },
        },
      };
    }
    return {
      list: async () => Object.values(defs).map((d) => d.tool),
      describe: async (slugs) => {
        const out = new Map<string, AppToolInfo>();
        for (const slug of slugs) {
          if (defs[slug] !== undefined) {
            out.set(slug, {
              title: NAMES[defs[slug].source],
              toolkit: "feeds",
              hints: { readOnly: true, create: false, update: false, destructive: false },
            });
          }
        }
        return out;
      },
      call: async (name, args) => {
        const d = defs[name];
        if (d === undefined) throw new Error(`no tool ${name}`);
        const items = await this.read(d.source, args as FeedQuery);
        return {
          content: [
            {
              type: "text",
              text:
                items.map((i) => `- ${i.title} ${i.url}\n  ${i.about}`).join("\n") ||
                "nothing found",
            },
          ],
        };
      },
    };
  }
}
