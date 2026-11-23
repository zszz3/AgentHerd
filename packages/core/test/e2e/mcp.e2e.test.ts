// E2E for the agent MCP gateway in the core (docs/spec/09-agent-tools.md §1–§2): each session gets
// the agentherd server with a task token; herd_report sets the stage; the token dies with the task.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StdioMcpServer } from "@agentherd/acp-client";
import { FakeChannel, type SentMessage } from "@agentherd/channel-fake";
import type { AgentProfile, ItemView, Mode } from "@agentherd/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Herd } from "../../src/herd.ts";
import { type AppToolInfo, type AppTools, UnknownTokenError } from "../../src/mcp-gateway.ts";
import { Store } from "../../src/store.ts";

const BIN = fileURLToPath(new URL("../../../mock-agent/bin/mock-agent.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "agentherd-mcp-"));
let herds: Herd[] = [];

afterEach(async () => {
  await Promise.all(herds.map((h) => h.stop()));
  herds = [];
});

const SLOW = `
turns:
  - - sleep: 400
    - message: "Done."
    - end_turn: end_turn
`;

function profile(script: string, extra: Partial<AgentProfile> = {}): AgentProfile {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(file, script);
  return {
    id: "mock",
    name: "Mock",
    command: [process.execPath, BIN, "--script", file],
    env: {},
    exporter: null,
    ...extra,
  };
}

async function setup(p: AgentProfile, apps?: AppTools, mode: Mode = "assist") {
  const tokens: string[] = [];
  const channel = new FakeChannel("owner");
  const herd = new Herd({
    home: dir,
    userHome: "/Users/me",
    channel,
    binding: { channelId: "fake", ownerId: "owner", data: {} },
    mode,
    ...(apps === undefined ? {} : { apps: () => apps }),
    locale: "en",
    profiles: [p],
    store: Store.open(":memory:"),
    boardDebounceMs: 10,
    mcpServer: (token): StdioMcpServer => {
      tokens.push(token);
      return { name: "agentherd", command: "relay", args: [], env: [{ name: "T", value: token }] };
    },
  });
  herds.push(herd);
  await herd.start();
  return { herd, tokens, channel };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
}

const report = (state: string, summary: string) => ({
  jsonrpc: "2.0" as const,
  id: 1,
  method: "tools/call",
  params: { name: "herd_report", arguments: { state, summary } },
});

describe("E2E-MCP-HERD-REPORT", () => {
  it("a herd_report during a turn sets the stage and the board line", async () => {
    const { herd, tokens } = await setup(profile(SLOW));
    const run = herd.run("mock", dir, "Deploy the mail monitor");
    await until(() => tokens.length > 0 && herd.tasks()[0]?.stage === "working");
    const token = tokens[0] as string;
    const answer = await herd.mcp(token, report("blocked", "need the Gmail keys"));
    expect(answer?.result).toEqual({ content: [{ type: "text", text: "reported" }] });
    await run;
    const [task] = herd.tasks();
    expect(task?.stage).toBe("stuck");
    expect(task?.lastReport).not.toBe("");
  });

  it("the token stops working when the task ends", async () => {
    const { herd, tokens } = await setup(profile(SLOW));
    const { taskId, turn } = await herd.startTask("mock", dir, "Look around");
    await turn;
    const token = tokens[0] as string;
    expect((await herd.mcp(token, { jsonrpc: "2.0", id: 1, method: "ping" }))?.result).toEqual({});
    await herd.endTask(taskId, "test");
    expect(() => herd.mcp(token, { jsonrpc: "2.0", id: 2, method: "ping" })).toThrow(
      UnknownTokenError,
    );
  });

  it("a profile with mcp: false gets no server", async () => {
    const { herd, tokens } = await setup(profile(SLOW, { mcp: false }));
    await herd.run("mock", dir, "Look around");
    expect(tokens).toEqual([]);
  });
});

const hints = (h: Partial<Record<"readOnly" | "create" | "update" | "destructive", boolean>>) => ({
  readOnly: false,
  create: false,
  update: false,
  destructive: false,
  ...h,
});

function fakeApps(ran: string[]): AppTools {
  const known = {
    GMAIL_FETCH_EMAILS: {
      title: "Gmail: Fetch emails",
      toolkit: "gmail",
      hints: hints({ readOnly: true }),
    },
    GMAIL_SEND_EMAIL: {
      title: "Gmail: Send email",
      toolkit: "gmail",
      hints: hints({ create: true }),
    },
    GMAIL_CREATE_EMAIL_DRAFT: {
      title: "Gmail: Create draft",
      toolkit: "gmail",
      hints: hints({ create: true }),
    },
    GMAIL_DELETE_MESSAGE: {
      title: "Gmail: Delete message",
      toolkit: "gmail",
      hints: hints({ destructive: true }),
    },
  } as const;
  return {
    list: async () => [{ name: "COMPOSIO_MULTI_EXECUTE_TOOL", inputSchema: {} }],
    describe: async (slugs) =>
      new Map(
        slugs.flatMap((s) => (s in known ? [[s, known[s as keyof typeof known]] as const] : [])),
      ),
    call: async (_name, args) => {
      for (const t of (args as { tools: { tool_slug: string }[] }).tools) ran.push(t.tool_slug);
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
}

function fakePluginTools(ran: string[]): AppTools {
  const known = new Map<string, AppToolInfo>([
    [
      "WECom_doc_get_doc",
      { title: "WeCom: Get doc", toolkit: "builtin:wecom", hints: hints({ readOnly: true }) },
    ],
    [
      "WECOM__create_doc",
      { title: "WeCom: Create doc", toolkit: "builtin:wecom", hints: hints({ create: true }) },
    ],
    [
      "WECOM__send_message",
      { title: "WeCom: Send message", toolkit: "builtin:wecom", hints: hints({ create: true }) },
    ],
    ["WECOM__unclear", { title: "WeCom: Unclear", toolkit: "builtin:wecom" }],
    [
      "WECOM__conflict",
      {
        title: "WeCom: Conflict",
        toolkit: "builtin:wecom",
        hints: hints({ readOnly: true, update: true }),
      },
    ],
    [
      "WECOM__create_page",
      {
        title: "Third-party WeCom plugin: Create page",
        toolkit: "plugin:wecom",
        hints: hints({ create: true }),
      },
    ],
  ]);
  const execute = async (name: string) => {
    ran.push(name);
    return { content: [{ type: "text", text: "ok" }] };
  };
  return {
    list: async () => [...known.keys()].map((name) => ({ name, inputSchema: {} })),
    describe: async (names) => new Map([...known].filter(([name]) => names.includes(name))),
    preflight: (name, args) => {
      if (known.get(name)?.toolkit !== "builtin:wecom") return undefined;
      if (JSON.stringify(args) !== "{}") throw new Error("Invalid WeCom CLI tool arguments.");
      return { approvalArguments: { fields: [], listSizes: {} }, execute: () => execute(name) };
    },
    call: execute,
  };
}

const callPlugin = (name: string) => ({
  jsonrpc: "2.0" as const,
  id: 8,
  method: "tools/call",
  params: { name, arguments: {} },
});

const run = (...slugs: string[]) => ({
  jsonrpc: "2.0" as const,
  id: 7,
  method: "tools/call",
  params: {
    name: "COMPOSIO_MULTI_EXECUTE_TOOL",
    arguments: {
      tools: slugs.map((tool_slug) => ({ tool_slug, arguments: {} })),
      sync_response_to_workbench: false,
    },
  },
});

const isOpenItem = (m: SentMessage) =>
  m.view.kind === "item" && (m.view as ItemView).final === undefined;

describe("E2E-MCP-APPS", () => {
  it("a read and a write that stays in the account run without asking; the write goes into the report", async () => {
    const ran: string[] = [];
    const { herd, tokens, channel } = await setup(profile(SLOW), fakeApps(ran));
    const { taskId, turn } = await herd.startTask("mock", dir, "Mail Bob");
    await until(() => tokens.length > 0);
    const answer = await herd.mcp(
      tokens[0] as string,
      run("GMAIL_FETCH_EMAILS", "GMAIL_CREATE_EMAIL_DRAFT"),
    );
    expect(answer?.result).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(ran).toEqual(["GMAIL_FETCH_EMAILS", "GMAIL_CREATE_EMAIL_DRAFT"]);
    expect(channel.messages.some(isOpenItem)).toBe(false);
    await turn;
    expect(herd.tasks().find((t) => t.id === taskId)?.automaticDecisions).toContain(
      "Ran on its own: Gmail: Fetch emails, Gmail: Create draft",
    );
  });

  it("sending mail leaves the Mac: it waits for the owner (ADR 0056)", async () => {
    const ran: string[] = [];
    const { herd, tokens, channel } = await setup(profile(SLOW), fakeApps(ran));
    const { turn } = await herd.startTask("mock", dir, "Mail Bob");
    await until(() => tokens.length > 0);
    const pending = herd.mcp(tokens[0] as string, run("GMAIL_SEND_EMAIL"));
    const card = await channel.waitFor(isOpenItem);
    expect((card.view as ItemView).reason).toBe(
      "leaves your Mac: sends a message for you; needs your confirmation",
    );
    await channel.tap((card.view as ItemView).itemId, "allow");
    expect((await pending)?.result).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(ran).toEqual(["GMAIL_SEND_EMAIL"]);
    await turn;
  });

  it("a delete waits for the owner and a deny reaches the agent as a tool error", async () => {
    const ran: string[] = [];
    const { herd, tokens, channel } = await setup(profile(SLOW), fakeApps(ran));
    const { turn } = await herd.startTask("mock", dir, "Clean the inbox");
    await until(() => tokens.length > 0);
    const pending = herd.mcp(
      tokens[0] as string,
      run("GMAIL_FETCH_EMAILS", "GMAIL_DELETE_MESSAGE"),
    );
    const card = await channel.waitFor(isOpenItem);
    expect((card.view as ItemView).title).toBe("Gmail: Fetch emails, Gmail: Delete message");
    await channel.tap((card.view as ItemView).itemId, "deny");
    expect((await pending)?.result).toEqual({
      content: [
        {
          type: "text",
          text: "The owner did not allow Gmail: Fetch emails, Gmail: Delete message.",
        },
      ],
      isError: true,
    });
    expect(ran).toEqual([]);
    await turn;
  });

  it("in observe mode a write goes to the owner and runs once allowed", async () => {
    const ran: string[] = [];
    const { herd, tokens, channel } = await setup(profile(SLOW), fakeApps(ran), "observe");
    const { turn } = await herd.startTask("mock", dir, "Mail Bob");
    await until(() => tokens.length > 0);
    const pending = herd.mcp(tokens[0] as string, run("GMAIL_SEND_EMAIL"));
    const card = await channel.waitFor(isOpenItem);
    await channel.tap((card.view as ItemView).itemId, "allow");
    expect((await pending)?.result).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(ran).toEqual(["GMAIL_SEND_EMAIL"]);
    await turn;
  });

  it("a tool without hints goes to the owner", async () => {
    const ran: string[] = [];
    const { herd, tokens, channel } = await setup(profile(SLOW), fakeApps(ran));
    const { turn } = await herd.startTask("mock", dir, "Do something");
    await until(() => tokens.length > 0);
    const pending = herd.mcp(tokens[0] as string, run("WEIRD_TOOL"));
    const card = await channel.waitFor(isOpenItem);
    await channel.tap((card.view as ItemView).itemId, "allow");
    await pending;
    expect(ran).toEqual(["WEIRD_TOOL"]);
    await turn;
  });
});

const MODES: Mode[] = ["observe", "assist", "auto"];
const SEND_PERMITS = MODES.flatMap((mode) =>
  [false, true].map((allowSend) => ({ mode, allowSend })),
);

function addAppRule(herd: Herd, action: "allow" | "deny", command: string): string {
  const id = `wecom-${action}-${command}`;
  herd.addRule({
    id,
    action,
    match: { toolKind: "app", command },
    createdAt: "2026-11-04T00:00:00Z",
    createdBy: "owner",
  });
  return id;
}

async function startPluginTask(herd: Herd, tokens: string[], allowSend = false): Promise<string> {
  const { turn } = await herd.startTask(
    "mock",
    dir,
    "Use an app plugin",
    undefined,
    undefined,
    undefined,
    allowSend ? ["send"] : [],
  );
  // The token remains valid while the task is idle. Let the mock turn finish before testing calls.
  await turn;
  return tokens[0] as string;
}

async function pendingAppItem(channel: FakeChannel, pending: ReturnType<Herd["mcp"]>) {
  // Fail immediately if a regression lets the call finish without going through the inbox.
  const card = await Promise.race([
    channel.waitFor(isOpenItem),
    pending.then(() => {
      throw new Error("App call finished before owner confirmation");
    }),
  ]);
  return card.view as ItemView;
}

describe("E2E-MCP-WECOM", () => {
  it("rejects invalid input without creating an approval or writing an app call audit row", async () => {
    const ran: string[] = [];
    const { herd, tokens, channel } = await setup(profile(SLOW), fakePluginTools(ran));
    const token = await startPluginTask(herd, tokens);
    const request = callPlugin("WECOM__send_message");
    const insertItem = vi.spyOn(herd.store, "insertItem");
    try {
      const response = await Promise.race([
        herd.mcp(token, {
          ...request,
          params: { ...request.params, arguments: { access_token: "unused" } },
        }),
        channel.waitFor(isOpenItem).then(() => {
          throw new Error("Invalid WeCom input opened an inbox item");
        }),
      ]);
      expect(response?.result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "app call failed: Invalid WeCom CLI tool arguments." }],
      });
      expect(insertItem).not.toHaveBeenCalled();
      expect(herd.store.auditRows("app.call")).toEqual([]);
      expect(ran).toEqual([]);
    } finally {
      insertItem.mockRestore();
    }
  });

  it.each(MODES)("requires a fresh owner confirmation for each write in %s", async (mode) => {
    const ran: string[] = [];
    const { herd, tokens, channel } = await setup(profile(SLOW), fakePluginTools(ran), mode);
    const token = await startPluginTask(herd, tokens);
    const request = callPlugin("WECOM__create_doc");

    const first = herd.mcp(token, request);
    const firstItem = await pendingAppItem(channel, first);
    expect(ran).toEqual([]);
    await channel.tap(firstItem.itemId, "allow", "not-owner");
    expect(
      channel.ofKind("item").find(({ view }) => view.itemId === firstItem.itemId)?.view.final,
    ).toBeUndefined();
    expect(ran).toEqual([]);
    await channel.tap(firstItem.itemId, "allow");
    expect((await first)?.result).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(ran).toEqual(["WECOM__create_doc"]);

    const second = herd.mcp(token, { ...request, id: 9 });
    const secondItem = await pendingAppItem(channel, second);
    expect(secondItem.itemId).not.toBe(firstItem.itemId);
    expect(ran).toEqual(["WECOM__create_doc"]);
    await channel.tap(secondItem.itemId, "deny");
    expect((await second)?.result).toMatchObject({ isError: true });
    expect(ran).toEqual(["WECOM__create_doc"]);
  });

  it.each(["WECOM__create_doc", "WECOM__unclear", "WECOM__conflict"])(
    "still asks for %s with a matching allow rule",
    async (slug) => {
      const ran: string[] = [];
      const { herd, tokens, channel } = await setup(profile(SLOW), fakePluginTools(ran), "auto");
      addAppRule(herd, "allow", slug);
      const token = await startPluginTask(herd, tokens);

      const pending = herd.mcp(token, callPlugin(slug));
      const item = await pendingAppItem(channel, pending);
      expect(ran).toEqual([]);
      await channel.tap(item.itemId, "deny");
      expect((await pending)?.result).toMatchObject({ isError: true });
      expect(ran).toEqual([]);
    },
  );

  it("still asks for a send the owner allowed for the task", async () => {
    const ran: string[] = [];
    const { herd, tokens, channel } = await setup(profile(SLOW), fakePluginTools(ran));
    const token = await startPluginTask(herd, tokens, true);

    const pending = herd.mcp(token, callPlugin("WECOM__send_message"));
    const item = await pendingAppItem(channel, pending);
    expect(ran).toEqual([]);
    await channel.tap(item.itemId, "allow");
    expect((await pending)?.result).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(ran).toEqual(["WECOM__send_message"]);
  });

  it.each(SEND_PERMITS)(
    "applies a WeCom deny before outbound checks in $mode (task allows send: $allowSend)",
    async ({ mode, allowSend }) => {
      const ran: string[] = [];
      const { herd, tokens, channel } = await setup(profile(SLOW), fakePluginTools(ran), mode);
      const slugs = ["WECOM__send_message", "WECom_doc_get_doc"];
      for (const slug of slugs) {
        addAppRule(herd, "allow", slug);
        addAppRule(herd, "deny", slug);
      }
      const token = await startPluginTask(herd, tokens, allowSend);

      for (const slug of slugs) {
        const response = await Promise.race([
          herd.mcp(token, callPlugin(slug)),
          channel.waitFor(isOpenItem).then(() => {
            throw new Error("Explicit deny opened an inbox item");
          }),
        ]);
        expect(response?.result).toMatchObject({ isError: true });
        expect(channel.messages.some(isOpenItem)).toBe(false);
        expect(ran).toEqual([]);
      }
    },
  );

  it.each(SEND_PERMITS)(
    "applies a new WeCom deny after owner confirmation in $mode (task allows send: $allowSend)",
    async ({ mode, allowSend }) => {
      const ran: string[] = [];
      const { herd, tokens, channel } = await setup(profile(SLOW), fakePluginTools(ran), mode);
      const slug = "WECOM__send_message";
      addAppRule(herd, "allow", slug);
      const token = await startPluginTask(herd, tokens, allowSend);
      const pending = herd.mcp(token, callPlugin(slug));
      const item = await pendingAppItem(channel, pending);
      expect(ran).toEqual([]);

      const ruleId = addAppRule(herd, "deny", slug);
      await channel.tap(item.itemId, "allow");

      expect((await pending)?.result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining(`rule ${ruleId}`) }],
      });
      expect(ran).toEqual([]);
      expect(herd.store.decisionsFor(item.itemId)).toMatchObject([
        { source: "human", action: "allow" },
      ]);
      expect(herd.store.auditRows("app.call.recheck")).toMatchObject([
        { data: { itemId: item.itemId, action: "deny", ruleId } },
      ]);
    },
  );

  it("blocks a confirmed WeCom call if current rules cannot be read", async () => {
    const ran: string[] = [];
    const { herd, tokens, channel } = await setup(profile(SLOW), fakePluginTools(ran));
    const token = await startPluginTask(herd, tokens);
    const pending = herd.mcp(token, callPlugin("WECOM__create_doc"));
    const item = await pendingAppItem(channel, pending);
    const listRules = vi.spyOn(herd.store, "listRules").mockImplementation(() => {
      throw new Error("Rule store unavailable");
    });

    try {
      await channel.tap(item.itemId, "allow");
      expect((await pending)?.result).toMatchObject({
        isError: true,
        content: [
          { type: "text", text: expect.stringContaining("could not verify current rules") },
        ],
      });
      expect(ran).toEqual([]);
      expect(herd.store.auditRows("app.call.recheck")).toMatchObject([
        { data: { itemId: item.itemId, action: "error" } },
      ]);
    } finally {
      listRules.mockRestore();
    }
  });

  it.each(MODES)("passes a provably read-only WeCom call without prompting in %s", async (mode) => {
    const ran: string[] = [];
    const { herd, tokens, channel } = await setup(profile(SLOW), fakePluginTools(ran), mode);
    const token = await startPluginTask(herd, tokens);

    const response = await herd.mcp(token, callPlugin("WECom_doc_get_doc"));
    expect(response?.result).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(channel.messages.some(isOpenItem)).toBe(false);
    expect(ran).toEqual(["WECom_doc_get_doc"]);
  });

  it("keeps existing write behavior for a third-party plugin with the id wecom", async () => {
    const ran: string[] = [];
    const { herd, tokens, channel } = await setup(profile(SLOW), fakePluginTools(ran));
    const token = await startPluginTask(herd, tokens);

    const response = await Promise.race([
      herd.mcp(token, callPlugin("WECOM__create_page")),
      channel.waitFor(isOpenItem).then(() => {
        throw new Error("Third-party plugin unexpectedly required WeCom approval");
      }),
    ]);
    expect(response?.result).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(channel.messages.some(isOpenItem)).toBe(false);
    expect(ran).toEqual(["WECOM__create_page"]);
  });
});
