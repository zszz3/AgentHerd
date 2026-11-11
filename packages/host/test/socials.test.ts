// 小红书 in the host (ADR 0058): the server's REST answers become notices, tools get the
// XIAOHONGSHU_ prefix with sign-in tools hidden, writes are not read-only, and Composio and
// 小红书 tools are offered side by side.

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { AppTools } from "@agentherd/core";
import { describe, expect, it } from "vitest";
import { combineApps } from "../src/socials.ts";
import { Xiaohongshu } from "../src/xiaohongshu.ts";

function fakeServer(signedIn: boolean) {
  const calls: string[] = [];
  const json = (data: unknown) =>
    new Response(JSON.stringify({ success: true, data }), {
      headers: { "content-type": "application/json" },
    });
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace(/^http:\/\/127\.0\.0\.1:\d+/, "");
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/health") return new Response("ok");
    if (path === "/api/v1/login/status") {
      return json({ is_logged_in: signedIn, ...(signedIn ? { username: "小羊不吃草" } : {}) });
    }
    if (path === "/api/v1/notifications/unread") {
      return json({ mentions: 2, likes: 0, connections: 1, unread: 3 });
    }
    if (path === "/api/v1/notifications/list") {
      return json({
        tab: "mentions",
        items: [
          {
            id: "n1",
            title: "评论了你的笔记",
            from: { nickname: "阿花" },
            comment_text: "求链接",
            feed_id: "f1",
            feed_xsec_token: "tok=",
            feed_title: "AgentHerd 上手",
          },
        ],
      });
    }
    if (path === "/mcp") {
      const body = JSON.parse(String(init?.body)) as { id?: number; method: string };
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result =
        body.method === "tools/list"
          ? {
              tools: [
                { name: "search_feeds", inputSchema: {} },
                { name: "publish_content", inputSchema: {} },
                { name: "get_login_qrcode", inputSchema: {} },
                { name: "delete_cookies", inputSchema: {} },
              ],
            }
          : { content: [{ type: "text", text: "ok" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

function platform(signedIn: boolean) {
  const server = fakeServer(signedIn);
  const env: NodeJS.ProcessEnv[] = [];
  const states: string[] = [];
  const x: Xiaohongshu = new Xiaohongshu({
    home: "/tmp/agentherd-xhs-test",
    seed: 7,
    changed: () => states.push(x.state),
    fetch: server.fetchFn,
    binary: async () => "/bin/true",
    launch: (_bin, _args, e) => {
      env.push(e);
      const child = new EventEmitter() as ChildProcess;
      (child as unknown as { kill: () => boolean }).kill = () => true;
      return child;
    },
  });
  return { x, server, env, states };
}

describe("小红书 (ADR 0058)", () => {
  it("starts with its own token and cookie file, and reads the sign-in", async () => {
    const { x, env, states } = platform(true);
    await x.start();
    expect(states).toEqual(["starting", "ready"]);
    expect(x.account).toBe("小羊不吃草");
    expect(env[0]?.AUTH_TOKEN).toMatch(/^[0-9a-f]{48}$/);
    expect(env[0]?.COOKIES_PATH).toBe("/tmp/agentherd-xhs-test/xiaohongshu/cookies.json");
    expect(env[0]?.XHS_FP_SEED).toBe("7");
    x.stop();
    expect(x.state).toBe("off");
  });

  it("gives no tools until signed in", async () => {
    const { x } = platform(false);
    await x.start();
    expect(x.state).toBe("signed-out");
    expect(x.tools()).toBeUndefined();
    x.stop();
  });

  it("reads unread counts and notices", async () => {
    const { x } = platform(true);
    await x.start();
    expect(await x.unread()).toEqual({ mentions: 2, likes: 0, follows: 1 });
    expect(await x.notices("mentions")).toEqual([
      {
        id: "n1",
        kind: "mentions",
        who: "阿花",
        text: "求链接",
        on: "AgentHerd 上手",
        url: "https://www.xiaohongshu.com/explore/f1?xsec_token=tok%3D",
      },
    ]);
    x.stop();
  });

  it("names tools XIAOHONGSHU_, hides sign-in, and marks writes", async () => {
    const { x, server } = platform(true);
    await x.start();
    const tools = x.tools() as AppTools;
    expect((await tools.list()).map((t) => t.name)).toEqual([
      "XIAOHONGSHU_SEARCH_FEEDS",
      "XIAOHONGSHU_PUBLISH_CONTENT",
    ]);
    const info = await tools.describe(["XIAOHONGSHU_SEARCH_FEEDS", "XIAOHONGSHU_PUBLISH_CONTENT"]);
    expect(info.get("XIAOHONGSHU_SEARCH_FEEDS")?.hints?.readOnly).toBe(true);
    expect(info.get("XIAOHONGSHU_PUBLISH_CONTENT")?.hints?.readOnly).toBe(false);
    await tools.call("XIAOHONGSHU_SEARCH_FEEDS", { keyword: "agent" });
    expect(server.calls.filter((c) => c === "POST /mcp").length).toBeGreaterThan(0);
    await expect(tools.call("XIAOHONGSHU_DELETE_COOKIES", {})).rejects.toThrow(/unknown tool/);
    x.stop();
  });
});

describe("combineApps", () => {
  const source = (names: string[], calls: string[]): AppTools => ({
    list: async () => names.map((name) => ({ name, inputSchema: {} })),
    describe: async (slugs) =>
      new Map(slugs.map((s) => [s, { title: s.toLowerCase(), toolkit: names[0] ?? "" }])),
    call: async (name) => {
      calls.push(name);
      return {};
    },
  });

  it("sends each call to the source that listed the tool", async () => {
    const a: string[] = [];
    const b: string[] = [];
    const both = combineApps([
      source(["COMPOSIO_MULTI_EXECUTE_TOOL"], a),
      source(["XIAOHONGSHU_SEARCH_FEEDS"], b),
    ]) as AppTools;
    expect((await both.list()).map((t) => t.name)).toEqual([
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      "XIAOHONGSHU_SEARCH_FEEDS",
    ]);
    await both.call("XIAOHONGSHU_SEARCH_FEEDS", {});
    await both.call("COMPOSIO_MULTI_EXECUTE_TOOL", {});
    expect(a).toEqual(["COMPOSIO_MULTI_EXECUTE_TOOL"]);
    expect(b).toEqual(["XIAOHONGSHU_SEARCH_FEEDS"]);
  });

  it("is the one source when there is only one", () => {
    const only = source([], []);
    expect(combineApps([undefined, only])).toBe(only);
    expect(combineApps([undefined])).toBeUndefined();
  });
});
