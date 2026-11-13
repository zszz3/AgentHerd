// E2E-PI-MCP: real Herd + serveMcp socket + piProfile + fake-pi (running real gate.ts and mcp.ts).
// Verifies herd_ack, app tool approvals (without duplicate gate cards), background progress holds,
// and continuing an ended Pi task with a refreshed MCP token via session/load.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeChannel, type SentMessage } from "@agentherd/channel-fake";
import { type AppTools, FakeClock, Herd, Store } from "@agentherd/core";
import type { ItemView, TextView } from "@agentherd/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { mcpServerFor, mcpSocketPath, serveMcp } from "../src/mcp-socket.ts";
import { piProfile } from "../src/profiles.ts";

const FAKE_PI = fileURLToPath(new URL("../../pi-acp/test/fake-pi.ts", import.meta.url));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
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
    GMAIL_CREATE_EMAIL_DRAFT: {
      title: "Gmail: Create draft",
      toolkit: "gmail",
      hints: hints({ create: true }),
    },
    GMAIL_SEND_EMAIL: {
      title: "Gmail: Send email",
      toolkit: "gmail",
      hints: hints({ create: true }),
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
      return { content: [{ type: "text", text: "app-ok" }] };
    },
  };
}

const isOpenItem = (m: SentMessage) =>
  m.view.kind === "item" && (m.view as ItemView).final === undefined;
const reports = (ch: FakeChannel) => ch.messages.filter((m) => m.view.kind === "report");
const texts = (ch: FakeChannel) =>
  ch.messages.filter((m) => m.view.kind === "text").map((m) => (m.view as TextView).text);

async function setup(plan: object, apps?: AppTools) {
  const home = mkdtempSync(join(tmpdir(), "agentherd-pi-mcp-"));
  const workDir = join(home, "work");
  mkdirSync(workDir, { recursive: true });
  const sessionDir = join(home, "pi-sessions");
  const channel = new FakeChannel("owner");
  const clock = new FakeClock();
  const base = piProfile(FAKE_PI, {
    AGENTHERD_PI_SESSION_DIR: sessionDir,
    FAKE_PI: JSON.stringify(plan),
  });
  let herd!: Herd;
  const server = await serveMcp(mcpSocketPath(home), (token, msg) => herd.mcp(token, msg));
  herd = new Herd({
    home,
    userHome: home,
    channel,
    binding: { channelId: "fake", ownerId: "owner", data: {} },
    mode: "assist",
    ...(apps === undefined ? {} : { apps: () => apps }),
    locale: "en",
    profiles: [base],
    store: Store.open(":memory:"),
    clock,
    boardDebounceMs: 10,
    backgroundCheckMinutes: 1,
    mcpServer: (token) => mcpServerFor(server.path, token),
  });
  cleanups.push(async () => {
    await herd.stop();
    await server.close();
    rmSync(home, { recursive: true, force: true });
  });
  await herd.start();
  return { herd, channel, clock, workDir, home };
}

describe("E2E-PI-MCP", () => {
  it("runs herd_ack, app calls (with a single app approval card) and background herd_report through Pi", async () => {
    const ran: string[] = [];
    const { herd, channel, clock, workDir } = await setup(
      {
        turns: [
          {
            calls: [
              { toolName: "herd_ack", input: { text: "Checking mail and starting build" } },
              {
                toolName: "COMPOSIO_MULTI_EXECUTE_TOOL",
                input: {
                  tools: [
                    { tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} },
                    { tool_slug: "GMAIL_CREATE_EMAIL_DRAFT", arguments: {} },
                  ],
                  sync_response_to_workbench: false,
                },
              },
              {
                toolName: "COMPOSIO_MULTI_EXECUTE_TOOL",
                input: {
                  tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: {} }],
                  sync_response_to_workbench: false,
                },
              },
              {
                toolName: "herd_report",
                input: { state: "progress", summary: "build running" },
              },
            ],
            reply: "Turn 1: {results}",
          },
          {
            calls: [{ toolName: "herd_report", input: { state: "ready", summary: "mail sent" } }],
            reply: "Turn 2: {results}",
          },
        ],
      },
      fakeApps(ran),
    );
    const { taskId, turn } = await herd.startTask("pi", workDir, "Check and send mail");
    const card = await channel.waitFor(isOpenItem);
    const view = card.view as ItemView;
    expect(view.title).toBe("Gmail: Send email");
    expect(view.reason).toContain("leaves your Mac");
    await channel.tap(view.itemId, "allow");
    await turn;

    const itemCards = channel.messages.filter((m) => m.view.kind === "item");
    expect(itemCards).toHaveLength(1);
    expect(ran).toEqual(["GMAIL_FETCH_EMAILS", "GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_SEND_EMAIL"]);
    expect(texts(channel)).toContain("Checking mail and starting build");

    // `herd_report({ state: "progress" })` held the completion report until the background check ran.
    expect(reports(channel)).toEqual([]);
    const task = () => herd.tasks().find((t) => t.id === taskId);
    expect(task()?.stage).toBe("working");

    await clock.advance(60_000);
    await expect.poll(() => reports(channel).length).toBe(1);
    expect(task()?.stage).toBe("done");
    expect(task()?.automaticDecisions).toContain(
      "Ran on its own: Gmail: Fetch emails, Gmail: Create draft",
    );
  });

  it("continues an ended Pi task with session/load and uses the refreshed MCP token", async () => {
    const { herd, channel, workDir } = await setup({
      turns: [
        {
          calls: [{ toolName: "herd_report", input: { state: "ready", summary: "first run ok" } }],
          reply: "first: {results}",
        },
        {
          calls: [{ toolName: "herd_report", input: { state: "ready", summary: "continued ok" } }],
          reply: "second: {results}",
        },
      ],
    });
    const { taskId, turn } = await herd.startTask("pi", workDir, "Do work");
    await turn;
    await herd.endTask(taskId, "test");

    await herd.promptTask(taskId, "Keep going");
    expect(reports(channel)).toHaveLength(2);
    expect(herd.tasks().find((t) => t.id === taskId)?.lastReport).toBe("Reported: continued ok");
  });
});
