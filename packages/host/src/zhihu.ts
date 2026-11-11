// 知乎 in the host (ADR 0058). No maintained server exists and its web API wants request
// signatures, so AgentHerd keeps a headless Chrome with its own profile signed in to 知乎 and
// calls the API from inside a zhihu.com page: the page's session does what the site needs.
// Sign-in is the site's QR code, scanned with the 知乎 app.

import { join } from "node:path";
import type {
  AppToolInfo,
  AppTools,
  McpTool,
  SocialKind,
  SocialNotice,
  SocialSource,
} from "@agentherd/core";
import { type CdpPage, Chrome } from "./cdp.ts";
import type { SocialState } from "./xiaohongshu.ts";

/** Agent tools are named ZHIHU_<TOOL>. */
export const ZHIHU_PREFIX = "ZHIHU_";
const HOME = "https://www.zhihu.com/";
const SIGNIN = "https://www.zhihu.com/signin";
const QR_SELECTOR = "canvas.Qrcode-qrcode";
const LOGIN_WAIT_MS = 4 * 60_000;
const LOGIN_POLL_MS = 1_000;
const LIST_LIMIT = 20;
const TEXT_MAX = 4_000;

/** Which notification list each watch kind reads. */
const KIND_LIST: Record<SocialKind, string> = {
  mentions: "default",
  likes: "vote_thank",
  follows: "follow",
};
/** "等你来答" invitations sit in the default list; they are not about the owner's content. */
const INVITATION = /等你来答|邀请你回答|邀请你参与/;

/** Something the browser can do; tests give a fake. */
export interface ZhihuBrowser {
  start(): Promise<void>;
  running(): boolean;
  /** Calls the API from a zhihu.com page: [status, parsed body]. */
  call(method: "GET" | "POST", path: string, body?: unknown): Promise<[number, unknown]>;
  signedIn(): Promise<boolean>;
  /** Opens a page in a new tab and returns the data the site put in it (js-initialData). */
  pageData(url: string): Promise<unknown>;
  /** Opens the sign-in page and returns its QR code as a data URL. */
  qrCode(): Promise<string>;
  /** Closes the sign-in page and reloads the working one. */
  doneSignIn(): Promise<void>;
  clearCookies(): Promise<void>;
  stop(): void;
}

export interface ZhihuOptions {
  /** ~/.agentherd */
  home: string;
  changed: () => void;
  log?: (line: string) => void;
  browser?: ZhihuBrowser;
}

/** The real browser: headless Chrome, profile ~/.agentherd/zhihu/profile. */
class ChromeZhihu implements ZhihuBrowser {
  private readonly chrome: Chrome;
  private page: CdpPage | undefined;
  private signin: CdpPage | undefined;

  constructor(profile: string, onExit: (code: number | null) => void) {
    this.chrome = new Chrome(profile, (code) => {
      this.page = undefined;
      this.signin = undefined;
      onExit(code);
    });
  }

  running(): boolean {
    return this.chrome.running();
  }

  async start(): Promise<void> {
    await this.chrome.start();
    this.page = await this.chrome.open();
    await this.page.go(HOME, 1_000);
  }

  private work(): CdpPage {
    if (this.page === undefined) throw new Error("知乎 is not running");
    return this.page;
  }

  async call(method: "GET" | "POST", path: string, body?: unknown): Promise<[number, unknown]> {
    const script = `(async () => {
      const xsrf = (document.cookie.match(/(?:^|; )_xsrf=([^;]*)/) || [])[1] || "";
      const init = { method: ${JSON.stringify(method)}, credentials: "include", headers: {} };
      if (${JSON.stringify(method)} === "POST") {
        init.headers["content-type"] = "application/json";
        init.headers["x-xsrftoken"] = xsrf;
        init.body = ${JSON.stringify(JSON.stringify(body ?? {}))};
      }
      const r = await fetch(${JSON.stringify(path)}, init);
      const text = await r.text();
      return [r.status, text];
    })()`;
    const [status, text] = await this.work().evaluate<[number, string]>(script);
    let parsed: unknown = text;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      // not JSON
    }
    return [status, parsed];
  }

  async pageData(url: string): Promise<unknown> {
    const page = await this.chrome.open();
    try {
      await page.go(url, 500);
      return await page.evaluate<unknown>(
        `(() => { const s = document.getElementById("js-initialData"); return s ? JSON.parse(s.textContent) : null; })()`,
      );
    } finally {
      await this.chrome.closePage(page).catch(() => {});
    }
  }

  async signedIn(): Promise<boolean> {
    const cookies = await this.work().cookies(HOME);
    return cookies.some((c) => c.name === "z_c0" && c.value !== "");
  }

  async qrCode(): Promise<string> {
    if (this.signin !== undefined) await this.chrome.closePage(this.signin).catch(() => {});
    const page = await this.chrome.open();
    this.signin = page;
    await page.go(SIGNIN, 500);
    if (!(await page.waitFor(`document.querySelector(${JSON.stringify(QR_SELECTOR)})`, 15_000))) {
      throw new Error("知乎登录页没有出二维码");
    }
    // The canvas is drawn after the code arrives.
    await new Promise((r) => setTimeout(r, 1_500));
    const image = await page.shot(QR_SELECTOR);
    if (image === undefined) throw new Error("知乎登录页没有出二维码");
    return image;
  }

  async doneSignIn(): Promise<void> {
    if (this.signin !== undefined) {
      await this.chrome.closePage(this.signin).catch(() => {});
      this.signin = undefined;
    }
    await this.work().go(HOME, 1_000);
  }

  async clearCookies(): Promise<void> {
    await this.work().send("Network.clearBrowserCookies");
    await this.work().go(HOME, 500);
  }

  stop(): void {
    this.page = undefined;
    this.signin = undefined;
    this.chrome.stop();
  }
}

/** Plain text from 知乎's HTML content. */
export function plain(html: unknown, max = TEXT_MAX): string {
  if (typeof html !== "string") return "";
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h\d|li|blockquote|figure)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Turns API links into the pages people open. */
function pageUrl(url: unknown): string | undefined {
  if (typeof url !== "string" || url === "") return undefined;
  return url
    .replace(/^http:/, "https:")
    .replace("://www.zhihu.com/api/v4/questions/", "://www.zhihu.com/question/")
    .replace("://api.zhihu.com/questions/", "://www.zhihu.com/question/");
}

const ID = { type: "string", description: "The id from a 知乎 link or an earlier result" };
const COMMENT_ON = {
  type: "string",
  enum: ["answer", "article", "question", "pin"],
  description: "What the comment is on",
};

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, unknown>;
  required: string[];
  read: boolean;
}

const TOOLS: readonly ToolDef[] = [
  {
    name: "SEARCH",
    description: "Searches 知乎 for questions, answers and articles.",
    properties: { query: { type: "string" }, limit: { type: "number", description: "1-20" } },
    required: ["query"],
    read: true,
  },
  {
    name: "HOT_LIST",
    description: "Today's 知乎 hot list.",
    properties: { limit: { type: "number", description: "1-50" } },
    required: [],
    read: true,
  },
  {
    name: "GET_QUESTION",
    description: "A question with its top answers (plain text).",
    properties: { question_id: ID, limit: { type: "number", description: "answers, 1-20" } },
    required: ["question_id"],
    read: true,
  },
  {
    name: "GET_ANSWER",
    description: "One answer in full (plain text).",
    properties: { answer_id: ID },
    required: ["answer_id"],
    read: true,
  },
  {
    name: "GET_ARTICLE",
    description: "One 知乎专栏 article in full (plain text).",
    properties: { article_id: ID },
    required: ["article_id"],
    read: true,
  },
  {
    name: "GET_COMMENTS",
    description: "Top comments under an answer, article, question or pin.",
    properties: { on: COMMENT_ON, id: ID, limit: { type: "number", description: "1-20" } },
    required: ["on", "id"],
    read: true,
  },
  {
    name: "GET_MY_PROFILE",
    description: "The owner's 知乎 account: name, link, counts.",
    properties: {},
    required: [],
    read: true,
  },
  {
    name: "LIST_NOTIFICATIONS",
    description:
      "The owner's notices: kind mentions (comments, replies, @, answers), likes (votes, thanks), follows.",
    properties: {
      kind: { type: "string", enum: ["mentions", "likes", "follows"] },
      limit: { type: "number", description: "1-20" },
    },
    required: [],
    read: true,
  },
  {
    name: "POST_COMMENT",
    description: "Comments, as the owner, under an answer, article, question or pin.",
    properties: { on: COMMENT_ON, id: ID, content: { type: "string" } },
    required: ["on", "id", "content"],
    read: false,
  },
  {
    name: "REPLY_COMMENT",
    description: "Replies, as the owner, to a comment.",
    properties: {
      on: COMMENT_ON,
      id: ID,
      comment_id: ID,
      content: { type: "string" },
    },
    required: ["on", "id", "comment_id", "content"],
    read: false,
  },
  {
    name: "VOTE_UP",
    description: "Votes up an answer as the owner.",
    properties: { answer_id: ID },
    required: ["answer_id"],
    read: false,
  },
];

function num(v: unknown, fallback: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : fallback;
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" && typeof v !== "number") throw new Error(`${key} is needed`);
  const s = String(v).trim();
  if (s === "") throw new Error(`${key} is needed`);
  return s;
}

/** An id from a link or a bare id. */
function idOf(value: string): string {
  const m = value.match(/(\d{5,})\/?(?:[?#].*)?$/);
  return m?.[1] ?? value;
}

function text(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v !== null && typeof v === "object" ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export class Zhihu implements SocialSource {
  readonly platform = "zhihu" as const;
  readonly name = "知乎";
  private readonly opts: ZhihuOptions;
  private readonly browser: ZhihuBrowser;
  state: SocialState = "off";
  account: string | undefined;
  problem: string | undefined;
  checkedAt: string | undefined;
  private starting: Promise<void> | undefined;
  private loginTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: ZhihuOptions) {
    this.opts = opts;
    this.browser =
      opts.browser ??
      new ChromeZhihu(join(opts.home, "zhihu", "profile"), (code) => {
        this.opts.log?.(`[zhihu] Chrome exited (${code})`);
        if (this.state !== "off") this.set("failed", `知乎用的 Chrome 停了（${code ?? "signal"}）`);
      });
  }

  ready(): boolean {
    return this.state === "ready";
  }

  private set(state: SocialState, problem?: string): void {
    this.state = state;
    this.problem = problem;
    this.opts.changed();
  }

  start(): Promise<void> {
    this.starting ??= this.run().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async run(): Promise<void> {
    if (this.browser.running() && (this.state === "ready" || this.state === "signed-out")) return;
    this.set("starting");
    try {
      await this.browser.start();
      await this.check();
    } catch (error) {
      this.opts.log?.(`[zhihu] ${(error as Error).message}`);
      this.browser.stop();
      this.set("failed", (error as Error).message);
    }
  }

  private async api(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const [status, data] = await this.browser.call(method, path, body);
    if (status === 401) {
      this.account = undefined;
      this.set("signed-out");
      throw new Error("知乎登录已失效");
    }
    if (status < 200 || status >= 300) {
      const message = obj(obj(data).error).message;
      throw new Error(
        `知乎 ${path.split("?")[0]}: ${typeof message === "string" ? message : `HTTP ${status}`}`,
      );
    }
    return data;
  }

  /** Reads whether the owner is signed in. */
  async check(): Promise<void> {
    this.checkedAt = new Date().toISOString();
    if (!(await this.browser.signedIn())) {
      this.account = undefined;
      this.set("signed-out");
      return;
    }
    const [status, me] = await this.browser.call("GET", "/api/v4/me");
    if (status === 200) {
      const name = obj(me).name;
      this.account = typeof name === "string" ? name : undefined;
      this.set("ready");
    } else {
      this.account = undefined;
      this.set("signed-out");
    }
  }

  /** The QR code to scan with the 知乎 app; the state turns ready once scanned. */
  async loginCode(): Promise<{ image: string; signedIn: boolean }> {
    await this.start();
    if (this.state === "ready") return { image: "", signedIn: true };
    if (this.state === "failed") throw new Error(this.problem ?? "知乎没有启动起来");
    const image = await this.browser.qrCode();
    this.watchLogin();
    return { image, signedIn: false };
  }

  private watchLogin(): void {
    if (this.loginTimer !== undefined) clearTimeout(this.loginTimer);
    const until = Date.now() + LOGIN_WAIT_MS;
    const tick = async () => {
      this.loginTimer = undefined;
      try {
        if (await this.browser.signedIn()) {
          await this.browser.doneSignIn();
          await this.check();
          return;
        }
      } catch {
        // try again
      }
      if (this.browser.running() && Date.now() < until) {
        this.loginTimer = setTimeout(() => void tick(), LOGIN_POLL_MS);
      }
    };
    this.loginTimer = setTimeout(() => void tick(), LOGIN_POLL_MS);
  }

  async logout(): Promise<void> {
    await this.browser.clearCookies();
    this.account = undefined;
    this.set("signed-out");
  }

  kill(): void {
    if (this.loginTimer !== undefined) clearTimeout(this.loginTimer);
    this.loginTimer = undefined;
    this.browser.stop();
  }

  stop(): void {
    this.kill();
    this.account = undefined;
    this.set("off");
  }

  private async list(kind: SocialKind, limit = LIST_LIMIT): Promise<Json[]> {
    const data = await this.api(
      "GET",
      `/api/v4/notifications/v2/${KIND_LIST[kind]}?limit=${limit}`,
    );
    return arr(obj(data).data)
      .map(obj)
      .filter(
        (item) => kind !== "mentions" || !INVITATION.test(String(obj(item.content).verb ?? "")),
      );
  }

  async unread(): Promise<Partial<Record<SocialKind, number>>> {
    const out: Partial<Record<SocialKind, number>> = {};
    for (const kind of ["mentions", "likes", "follows"] as const) {
      out[kind] = (await this.list(kind)).filter((item) => item.is_read === false).length;
    }
    return out;
  }

  async notices(kind: SocialKind): Promise<SocialNotice[]> {
    return (await this.list(kind)).map((item) => notice(kind, item));
  }

  /** Tools for agents, while the owner is signed in. */
  tools(): AppTools | undefined {
    if (this.state !== "ready") return undefined;
    return {
      list: async () =>
        TOOLS.map(
          (t): McpTool => ({
            name: `${ZHIHU_PREFIX}${t.name}`,
            description: t.description,
            inputSchema: { type: "object", properties: t.properties, required: t.required },
          }),
        ),
      describe: async (slugs) => {
        const out = new Map<string, AppToolInfo>();
        for (const slug of slugs) {
          const tool = TOOLS.find((t) => `${ZHIHU_PREFIX}${t.name}` === slug);
          if (tool === undefined) continue;
          out.set(slug, {
            title: `知乎 ${tool.name.toLowerCase().replace(/_/g, " ")}`,
            toolkit: "zhihu",
            // Comments, replies and votes show under the owner's name: they ask (ADR 0056).
            hints: { readOnly: tool.read, create: !tool.read, update: false, destructive: false },
          });
        }
        return out;
      },
      call: async (name, args) => text(await this.runTool(name, obj(args))),
    };
  }

  private async runTool(name: string, args: Json): Promise<unknown> {
    switch (name.slice(ZHIHU_PREFIX.length)) {
      case "SEARCH": {
        const q = encodeURIComponent(str(args, "query"));
        const limit = num(args.limit, 10, 20);
        // The limit counts people, ads and boxes too; ask for more and keep the content.
        const data = await this.api(
          "GET",
          `/api/v4/search_v3?t=general&q=${q}&correction=1&offset=0&limit=${Math.min(limit * 2, 20)}&search_source=Normal`,
        );
        return arr(obj(data).data)
          .map(obj)
          .filter((r) => ["answer", "article", "question"].includes(String(obj(r.object).type)))
          .map((r) => {
            const o = obj(r.object);
            const question = obj(o.question);
            return {
              type: o.type,
              id: o.id,
              title: plain(question.name ?? o.title ?? obj(r.highlight).title, 200),
              excerpt: plain(o.excerpt, 300),
              author: obj(o.author).name,
              votes: o.voteup_count,
              url:
                o.type === "answer"
                  ? `https://www.zhihu.com/question/${String(question.id)}/answer/${String(o.id)}`
                  : o.type === "article"
                    ? `https://zhuanlan.zhihu.com/p/${String(o.id)}`
                    : pageUrl(o.url),
            };
          })
          .slice(0, limit);
      }
      case "HOT_LIST": {
        const limit = num(args.limit, 20, 50);
        const data = await this.api("GET", `/api/v3/feed/topstory/hot-lists/total?limit=${limit}`);
        return arr(obj(data).data).map((item) => {
          const t = obj(obj(item).target);
          return {
            title: t.title,
            heat: obj(item).detail_text,
            excerpt: plain(t.excerpt, 200),
            // Ids are too big for numbers in JSON; the link keeps them whole.
            url: pageUrl(t.url),
          };
        });
      }
      case "GET_QUESTION": {
        const id = idOf(str(args, "question_id"));
        const limit = num(args.limit, 5, 20);
        // The question's own endpoint wants the app's signature; its answers carry its title.
        const answers = obj(
          await this.api(
            "GET",
            `/api/v4/questions/${id}/answers?limit=${limit}&sort_by=default&include=data[*].content,voteup_count,comment_count,question`,
          ),
        );
        const first = obj(arr(answers.data)[0]);
        return {
          title: obj(first.question).title,
          url: `https://www.zhihu.com/question/${id}`,
          top: arr(answers.data).map((a) => {
            const x = obj(a);
            return {
              id: String(x.id),
              author: obj(x.author).name,
              votes: x.voteup_count,
              comments: x.comment_count,
              text: plain(x.content, 1_500),
            };
          }),
        };
      }
      case "GET_ANSWER": {
        const id = idOf(str(args, "answer_id"));
        const a = obj(
          await this.api(
            "GET",
            `/api/v4/answers/${id}?include=content,voteup_count,comment_count,question`,
          ),
        );
        return {
          question: obj(a.question).title,
          author: obj(a.author).name,
          votes: a.voteup_count,
          comments: a.comment_count,
          url: `https://www.zhihu.com/question/${String(obj(a.question).id)}/answer/${id}`,
          text: plain(a.content),
        };
      }
      case "GET_ARTICLE": {
        const id = idOf(str(args, "article_id"));
        // The article endpoint wants the app's signature; the article page carries the same data.
        const data = obj(await this.browser.pageData(`https://zhuanlan.zhihu.com/p/${id}`));
        const a = obj(obj(obj(obj(data.initialState).entities).articles)[id]);
        if (a.content === undefined) throw new Error(`知乎 article ${id} not found`);
        return {
          title: a.title,
          author: obj(a.author).name,
          votes: a.voteup_count,
          comments: a.comment_count,
          url: `https://zhuanlan.zhihu.com/p/${id}`,
          text: plain(a.content),
        };
      }
      case "GET_COMMENTS": {
        const on = str(args, "on");
        const id = idOf(str(args, "id"));
        const limit = num(args.limit, 10, 20);
        const data = obj(
          await this.api(
            "GET",
            `/api/v4/comment_v5/${on}s/${id}/root_comment?order_by=score&limit=${limit}`,
          ),
        );
        return arr(data.data).map((c) => {
          const x = obj(c);
          return {
            comment_id: x.id,
            author: obj(x.author).name,
            likes: x.like_count,
            text: plain(x.content, 500),
            replies: x.child_comment_count,
          };
        });
      }
      case "GET_MY_PROFILE": {
        const me = obj(
          await this.api(
            "GET",
            "/api/v4/me?include=answer_count,articles_count,follower_count,voteup_count",
          ),
        );
        return {
          name: me.name,
          url: `https://www.zhihu.com/people/${String(me.url_token)}`,
          answers: me.answer_count,
          articles: me.articles_count,
          followers: me.follower_count,
          votes: me.voteup_count,
        };
      }
      case "LIST_NOTIFICATIONS": {
        const kind = (["mentions", "likes", "follows"] as const).find((k) => k === args.kind);
        return (await this.list(kind ?? "mentions", num(args.limit, 10, 20))).map((item) => ({
          ...notice(kind ?? "mentions", item),
          read: item.is_read,
        }));
      }
      case "POST_COMMENT":
      case "REPLY_COMMENT": {
        const on = str(args, "on");
        const id = idOf(str(args, "id"));
        const reply = name.endsWith("REPLY_COMMENT") ? idOf(str(args, "comment_id")) : undefined;
        const c = obj(
          await this.api("POST", `/api/v4/comment_v5/${on}s/${id}/comment`, {
            content: str(args, "content"),
            ...(reply === undefined ? {} : { reply_comment_id: reply }),
          }),
        );
        return { done: true, comment_id: c.id };
      }
      case "VOTE_UP": {
        const id = idOf(str(args, "answer_id"));
        const v = obj(await this.api("POST", `/api/v4/answers/${id}/voters`, { type: "up" }));
        return { done: true, votes: v.voteup_count };
      }
      default:
        throw new Error(`unknown tool ${name}`);
    }
  }
}

/** One notice the herd can tell the owner about. */
function notice(kind: SocialKind, item: Json): SocialNotice {
  const content = obj(item.content);
  const actor = obj(arr(content.actors)[0]);
  const target = obj(content.target);
  const verb = String(content.verb ?? "").trim();
  const extra = plain(obj(content.extend).text, 200);
  const on = typeof target.text === "string" ? plain(target.text, 80) : undefined;
  const url = pageUrl(target.link ?? obj(item.target).url);
  return {
    id: String(item.id),
    kind,
    who: typeof actor.name === "string" ? actor.name : "?",
    text: kind === "mentions" ? [verb, extra].filter((s) => s !== "").join("：") : "",
    ...(on === undefined || on === "" ? {} : { on }),
    ...(url === undefined ? {} : { url }),
  };
}
