// News sources and 飞书 through lark-cli in the host (ADR 0059): GitHub Trending, Hacker News and
// arXiv answers become items, items told once are marked, turned-off sources are not offered,
// and lark-cli is found, set up with AgentHerd's app, signed in by QR and described to tasks.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Feeds, parseArxiv, parseTrending } from "../src/feeds.ts";
import { Lark, type Run } from "../src/lark.ts";

const TRENDING = `<html><article class="Box-row">
  <h2 class="h3 lh-condensed"><a href="/meta/astryx" class="Link"><svg><path d="M8 .25a.75"></path></svg>
  <span>meta /</span> astryx</a></h2>
  <p class="col-9 color-fg-muted my-1">An open source design system &amp; agents</p>
  <span itemprop="programmingLanguage">TypeScript</span>
  <a href="/meta/astryx/stargazers" class="Link"><svg><path d="M8 .25a.75.75 0 0 1"></path></svg>
    2,425</a>
  <span class="d-inline-block float-sm-right"><svg></svg>
    1,600 stars today</span>
</article><article class="Box-row">
  <h2><a href="/a/b" class="Link">b</a></h2>
  <a href="/a/b/stargazers">10</a>
</article></html>`;

const ARXIV = `<feed><entry><id>http://arxiv.org/abs/2611.14514v1</id><published>2026-11-10T00:00:00Z</published>
<title>Contrastive
  Discovery</title><summary>LLM agents are used.</summary></entry></feed>`;

function fakeFetch() {
  const urls: string[] = [];
  const fetchFn = async (url: string) => {
    urls.push(url);
    if (url.startsWith("https://github.com/trending")) return new Response(TRENDING);
    if (url.includes("export.arxiv.org")) return new Response(ARXIV);
    if (url.includes("hn.algolia.com")) {
      return Response.json({
        hits: [{ objectID: "7", title: "Agents", url: "https://x.y", points: 9 }],
      });
    }
    if (url.endsWith("topstories.json")) return Response.json([1, 2]);
    const id = /item\/(\d+)\.json/.exec(url)?.[1];
    if (id !== undefined) return Response.json({ id: Number(id), title: `Story ${id}`, score: 5 });
    return new Response("no", { status: 404 });
  };
  return { urls, fetchFn };
}

describe("news sources (ADR 0059)", () => {
  it("reads a trending page without counting the icons as stars", () => {
    const items = parseTrending(TRENDING);
    expect(items.map((i) => i.title)).toEqual(["meta/astryx", "a/b"]);
    expect(items[0]?.url).toBe("https://github.com/meta/astryx");
    expect(items[0]?.about).toBe(
      "An open source design system & agents — TypeScript · 2425 stars · +1600",
    );
  });

  it("reads arXiv entries", () => {
    expect(parseArxiv(ARXIV)).toEqual([
      expect.objectContaining({
        id: "arxiv:2611.14514",
        title: "Contrastive Discovery",
        about: "2026-11-10 — LLM agents are used.",
      }),
    ]);
  });

  it("marks what a digest told, and only then", async () => {
    const { urls, fetchFn } = fakeFetch();
    const feeds = new Feeds({ home: mkdtempSync(join(tmpdir(), "feeds-")), fetch: fetchFn });
    expect(
      (await feeds.read("github-trending", { since: "weekly", language: "Python" })).map(
        (i) => i.seen,
      ),
    ).toEqual([false, false]);
    expect(urls.at(-1)).toBe("https://github.com/trending/python?since=weekly");
    await feeds.read("github-trending", {}, true);
    expect((await feeds.read("github-trending")).map((i) => i.seen)).toEqual([true, true]);
    const hn = await feeds.read("hacker-news", { limit: 2 });
    expect(hn.map((i) => i.title)).toEqual(["Story 1", "Story 2"]);
    expect(hn[0]?.url).toBe("https://news.ycombinator.com/item?id=1");
    expect((await feeds.read("hacker-news", { query: "agent" }))[0]?.url).toBe("https://x.y");
  });

  it("offers turned-on sources to agents as read-only tools", async () => {
    const { fetchFn } = fakeFetch();
    const feeds = new Feeds({
      home: mkdtempSync(join(tmpdir(), "feeds-")),
      fetch: fetchFn,
      off: () => ["arxiv"],
    });
    const tools = feeds.tools();
    expect((await tools?.list())?.map((t) => t.name)).toEqual(["GITHUB_TRENDING", "HACKER_NEWS"]);
    expect((await tools?.describe(["HACKER_NEWS"]))?.get("HACKER_NEWS")?.hints?.readOnly).toBe(
      true,
    );
    const answer = (await tools?.call("GITHUB_TRENDING", {})) as { content: { text: string }[] };
    expect(answer.content[0]?.text).toContain("meta/astryx https://github.com/meta/astryx");
    await expect(feeds.read("arxiv")).rejects.toThrow(/turned off/);
    // An agent's read does not count as told.
    expect((await feeds.read("github-trending"))[0]?.seen).toBe(false);
  });
});

function fakeLark(state: { configured: boolean; signedIn: boolean }) {
  const calls: string[] = [];
  const run: Run = async (_file, args, opts) => {
    calls.push(`${args.join(" ")}${opts?.input === undefined ? "" : " <secret>"}`);
    const out = (o: unknown) => ({ code: 0, stdout: JSON.stringify(o), stderr: "" });
    if (args[0] === "--version") return { code: 0, stdout: "lark-cli version 1.0.98", stderr: "" };
    if (args.join(" ") === "auth status") {
      if (!state.configured) {
        return {
          code: 3,
          stdout: "",
          stderr: JSON.stringify({
            ok: false,
            error: { subtype: "not_configured", message: "not configured" },
          }),
        };
      }
      return out({
        identities: {
          user: state.signedIn ? { status: "ready", userName: "郭宇航" } : { status: "missing" },
        },
      });
    }
    if (args[0] === "config") {
      state.configured = true;
      return out({ ok: true });
    }
    if (args.includes("--no-wait"))
      return out({ device_code: "D", verification_url: "https://open.feishu.cn/x" });
    if (args.includes("--device-code")) {
      state.signedIn = true;
      return out({ ok: true });
    }
    if (args.join(" ") === "auth logout") {
      state.signedIn = false;
      return out({ ok: true });
    }
    return { code: 1, stdout: "", stderr: "unknown" };
  };
  return { calls, run };
}

describe("飞书 through lark-cli (ADR 0059)", () => {
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), "lark-"));
    // A fake lark-cli on the search path.
    writeFileSync(join(d, "lark-cli"), "");
    return d;
  };

  it("sets lark-cli up with AgentHerd's own app, signs in by QR and tells tasks", async () => {
    const state = { configured: false, signedIn: false };
    const { calls, run } = fakeLark(state);
    let changes = 0;
    const lark = new Lark({
      changed: () => changes++,
      run,
      dirs: [dir()],
      qr: async (url) => `data:qr,${url}`,
      app: async () => ({ appId: "cli_1", secret: "s", brand: "feishu" }),
    });
    expect((await lark.check()).state).toBe("no-app");
    expect(lark.note()).toBeUndefined();
    const login = await lark.connect();
    expect(login).toEqual({
      image: "data:qr,https://open.feishu.cn/x",
      url: "https://open.feishu.cn/x",
    });
    expect(calls).toContain(
      "config init --app-id cli_1 --app-secret-stdin --brand feishu <secret>",
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lark.current()).toMatchObject({ state: "ready", account: "郭宇航", version: "1.0.98" });
    expect(lark.note()).toContain("lark-cli is installed and signed in as the owner (郭宇航)");
    expect(changes).toBeGreaterThan(0);
    expect((await lark.test()).message).toBe("连接正常，账号「郭宇航」");
    await lark.logout();
    expect(lark.current().state).toBe("signed-out");
    expect((await lark.test()).message).toBe("还没登录，点「连接」扫码");
  });

  it("says when it is not installed", async () => {
    const lark = new Lark({
      changed: () => {},
      run: fakeLark({ configured: true, signedIn: true }).run,
      dirs: [],
      qr: async () => "",
    });
    lark.find = () => undefined;
    expect((await lark.check()).state).toBe("missing");
    expect((await lark.test()).message).toContain("自动安装");
  });
});
