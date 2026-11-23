import { describe, expect, it } from "vitest";
import type { AppCall } from "../src/app-calls.ts";
import {
  type AppToolInfo,
  type AppTools,
  type HerdReport,
  McpGateway,
  parseReport,
  UnknownTokenError,
} from "../src/mcp-gateway.ts";

function gateway() {
  const reports: [string, HerdReport][] = [];
  const g = new McpGateway((taskId, report) => reports.push([taskId, report]));
  return { g, reports, token: g.register("task-1") };
}

const call = (id: number, method: string, params?: unknown) => ({
  jsonrpc: "2.0" as const,
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

describe("McpGateway", () => {
  it("gives each registration a fresh 64-hex token", async () => {
    const g = new McpGateway(() => {});
    const a = g.register("t");
    const b = g.register("t");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).not.toBe(a);
    expect(g.taskOf(a)).toBeUndefined();
    expect(g.taskOf(b)).toBe("t");
  });

  it("refuses an unknown or revoked token", async () => {
    const { g, token } = gateway();
    expect(() => g.handle("nope", call(1, "ping"))).toThrow(UnknownTokenError);
    g.revoke("task-1");
    expect(() => g.handle(token, call(1, "ping"))).toThrow(UnknownTokenError);
  });

  it("answers initialize with a version it speaks", async () => {
    const { g, token } = gateway();
    const known = await g.handle(token, call(1, "initialize", { protocolVersion: "2025-03-26" }));
    expect(known?.result).toMatchObject({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "agentherd" },
    });
    const other = await g.handle(token, call(2, "initialize", { protocolVersion: "2099-01-01" }));
    expect(other?.result).toMatchObject({ protocolVersion: "2025-06-18" });
  });

  it("answers ping, lists herd_report and ignores notifications", async () => {
    const { g, token } = gateway();
    expect(await g.handle(token, call(1, "ping"))).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    const list = (await g.handle(token, call(2, "tools/list")))?.result as {
      tools: { name: string }[];
    };
    expect(list.tools.map((t) => t.name)).toEqual(["herd_report"]);
    expect(
      await g.handle(token, { jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toBeUndefined();
  });

  it("hands a valid herd_report to the core for the token's task", async () => {
    const { g, token, reports } = gateway();
    const answer = await g.handle(
      token,
      call(1, "tools/call", {
        name: "herd_report",
        arguments: { state: "blocked", summary: "need keys", risks: ["no tests"] },
      }),
    );
    expect(answer?.result).toEqual({ content: [{ type: "text", text: "reported" }] });
    expect(reports).toEqual([
      ["task-1", { state: "blocked", summary: "need keys", risks: ["no tests"] }],
    ]);
  });

  it("answers a bad report or unknown tool as a tool error", async () => {
    const { g, token, reports } = gateway();
    const bad = await g.handle(
      token,
      call(1, "tools/call", { name: "herd_report", arguments: { state: "great" } }),
    );
    expect(bad?.result).toMatchObject({ isError: true });
    const unknown = await g.handle(token, call(2, "tools/call", { name: "rm_rf", arguments: {} }));
    expect(unknown?.result).toMatchObject({ isError: true });
    expect(reports).toEqual([]);
  });

  it("answers other methods with -32601", async () => {
    const { g, token } = gateway();
    expect((await g.handle(token, call(1, "resources/list")))?.error).toMatchObject({
      code: -32601,
    });
  });
});

describe("McpGateway with apps", () => {
  const SEND: AppToolInfo = {
    title: "Gmail: Send email",
    toolkit: "gmail",
    hints: { readOnly: false, create: true, update: false, destructive: false },
  };

  function withApps(answer: boolean) {
    const ran: [string, unknown][] = [];
    const asked: [string, AppCall[]][] = [];
    const apps: AppTools = {
      list: async () => [
        { name: "COMPOSIO_SEARCH_TOOLS", inputSchema: {} },
        { name: "COMPOSIO_MULTI_EXECUTE_TOOL", inputSchema: {} },
        { name: "COMPOSIO_MANAGE_CONNECTIONS", inputSchema: {} },
        { name: "COMPOSIO_REMOTE_WORKBENCH", inputSchema: {} },
      ],
      describe: async (slugs) =>
        new Map(slugs.filter((s) => s === "GMAIL_SEND_EMAIL").map((s) => [s, SEND])),
      call: async (name, args) => {
        ran.push([name, args]);
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const g = new McpGateway(() => {}, {
      apps: () => apps,
      approve: async (taskId, calls) => {
        asked.push([taskId, calls]);
        return answer;
      },
      denied: (t) => `no: ${t}`,
    });
    return { g, ran, asked, token: g.register("task-1") };
  }

  it("lists herd_report and the app tools agents may use", async () => {
    const { g, token } = withApps(true);
    const list = (await g.handle(token, call(1, "tools/list")))?.result as {
      tools: { name: string }[];
    };
    expect(list.tools.map((t) => t.name)).toEqual([
      "herd_report",
      "COMPOSIO_SEARCH_TOOLS",
      "COMPOSIO_MULTI_EXECUTE_TOOL",
    ]);
  });

  it("runs a search without asking", async () => {
    const { g, token, ran, asked } = withApps(false);
    const args = { queries: [{ use_case: "send mail" }] };
    const answer = await g.handle(
      token,
      call(1, "tools/call", { name: "COMPOSIO_SEARCH_TOOLS", arguments: args }),
    );
    expect(answer?.result).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(asked).toEqual([]);
    expect(ran).toEqual([["COMPOSIO_SEARCH_TOOLS", args]]);
  });

  it("asks about each tool of a multi-execute call and runs it when allowed", async () => {
    const { g, token, ran, asked } = withApps(true);
    const args = {
      tools: [
        { tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "a@b.c" } },
        { tool_slug: "SLACK_POST", arguments: { text: "hi" } },
      ],
      sync_response_to_workbench: false,
    };
    await g.handle(
      token,
      call(1, "tools/call", { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: args }),
    );
    expect(asked).toEqual([
      [
        "task-1",
        [
          {
            slug: "GMAIL_SEND_EMAIL",
            title: "Gmail: Send email",
            toolkit: "gmail",
            hints: SEND.hints,
            arguments: { to: "a@b.c" },
          },
          { slug: "SLACK_POST", title: "SLACK_POST", toolkit: "slack", arguments: { text: "hi" } },
        ],
      ],
    ]);
    expect(ran).toEqual([["COMPOSIO_MULTI_EXECUTE_TOOL", args]]);
  });

  it("answers a denied call with a tool error and does not run it", async () => {
    const { g, token, ran } = withApps(false);
    const answer = await g.handle(
      token,
      call(1, "tools/call", {
        name: "COMPOSIO_MULTI_EXECUTE_TOOL",
        arguments: {
          tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: {} }],
          sync_response_to_workbench: false,
        },
      }),
    );
    expect(answer?.result).toEqual({
      content: [{ type: "text", text: "no: Gmail: Send email" }],
      isError: true,
    });
    expect(ran).toEqual([]);
  });

  it("refuses hidden meta tools and a multi-execute without slugs", async () => {
    const { g, token, ran } = withApps(true);
    const hidden = await g.handle(
      token,
      call(1, "tools/call", { name: "COMPOSIO_REMOTE_WORKBENCH", arguments: {} }),
    );
    expect(hidden?.result).toMatchObject({ isError: true });
    const bad = await g.handle(
      token,
      call(2, "tools/call", { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{}] } }),
    );
    expect(bad?.result).toMatchObject({ isError: true });
    expect(ran).toEqual([]);
  });
});

describe("McpGateway app preflight", () => {
  const name = "WECOM_MESSAGE_SEND";
  const info = { title: "WeCom: Send message", toolkit: "builtin:wecom" };

  it("rejects invalid arguments before looking up or asking about a call", async () => {
    const effects: string[] = [];
    const apps = {
      list: async () => [],
      describe: async () => {
        effects.push("describe");
        return new Map();
      },
      preflight: async () => {
        throw new Error("Invalid WeCom CLI tool arguments.");
      },
      call: async () => {
        effects.push("call");
      },
    } satisfies AppTools;
    const g = new McpGateway(() => {}, {
      apps: () => apps,
      approve: async () => {
        effects.push("approve");
        return true;
      },
    });
    const answer = await g.handle(
      g.register("task-1"),
      call(1, "tools/call", {
        name,
        arguments: { access_token: "not-a-real-credential" },
      }),
    );

    expect({ result: answer?.result, effects }).toEqual({
      result: {
        isError: true,
        content: [{ type: "text", text: "app call failed: Invalid WeCom CLI tool arguments." }],
      },
      effects: [],
    });
  });

  it("gives approval only the preflight summary and runs only the prepared call if allowed", async () => {
    const asked: AppCall[] = [];
    const ran: string[] = [];
    const args = { text: "private office content" };
    const apps = {
      list: async () => [],
      describe: async () => new Map([[name, info]]),
      preflight: () => {
        const text = args.text;
        return {
          approvalArguments: { text: "omitted" },
          execute: async () => {
            ran.push(text);
            return { content: [{ type: "text", text: "ok" }] };
          },
        };
      },
      call: async () => {
        ran.push("unprepared call");
      },
    } satisfies AppTools;
    const g = new McpGateway(() => {}, {
      apps: () => apps,
      approve: async (_taskId, calls) => {
        expect(ran).toEqual([]);
        asked.push(...calls);
        args.text = "changed while waiting";
        return true;
      },
    });
    const answer = await g.handle(
      g.register("task-1"),
      call(1, "tools/call", {
        name,
        arguments: args,
      }),
    );

    expect(answer?.result).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(asked).toEqual([{ slug: name, ...info, arguments: { text: "omitted" } }]);
    expect(ran).toEqual(["private office content"]);
  });

  it.each(["WECOM_MESSAGE_SEND", "COMPOSIO_MULTI_EXECUTE_TOOL"])(
    "rejects WeCom arguments without a prepared call when invoked via %s",
    async (toolName) => {
      const effects: string[] = [];
      const apps: AppTools = {
        list: async () => [],
        describe: async () => {
          effects.push("describe");
          return new Map();
        },
        call: async () => {
          effects.push("call");
        },
      };
      const g = new McpGateway(() => {}, {
        apps: () => apps,
        approve: async () => {
          effects.push("approve");
          return true;
        },
      });
      const args = { text: "private office content" };
      const answer = await g.handle(
        g.register("task-1"),
        call(1, "tools/call", {
          name: toolName,
          arguments: toolName === name ? args : { tools: [{ tool_slug: name, arguments: args }] },
        }),
      );

      expect(answer?.result).toMatchObject({ isError: true });
      expect(effects).toEqual([]);
    },
  );
});

describe("parseReport", () => {
  it("cuts a long summary to 600 characters", async () => {
    const r = parseReport({ state: "ready", summary: "x".repeat(700) });
    expect(typeof r === "string" ? r : r.summary.length).toBe(600);
  });

  it("rejects a missing summary and non-string lists", async () => {
    expect(typeof parseReport({ state: "ready" })).toBe("string");
    expect(typeof parseReport({ state: "ready", summary: "s", tests: [1] })).toBe("string");
    expect(typeof parseReport("nope")).toBe("string");
  });
});
