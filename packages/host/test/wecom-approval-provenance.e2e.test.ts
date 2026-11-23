import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeChannel } from "@agentherd/channel-fake";
import { type AppToolInfo, FakeClock, Herd, Store } from "@agentherd/core";
import type { ItemView } from "@agentherd/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { PetFeed } from "../src/pet.ts";

const BIN = fileURLToPath(new URL("../../mock-agent/bin/mock-agent.ts", import.meta.url));
const WECOM = "WECOM_TODO_CREATE";
const OTHER = "OTHER_CREATE";
const tools = new Map<string, AppToolInfo>([
  [WECOM, { title: "WeCom: Create to-do", toolkit: "builtin:wecom" }],
  [OTHER, { title: "Other: Create to-do", toolkit: "other" }],
]);
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "agentherd-approval-provenance-"));
  const script = join(home, "agent.yaml");
  writeFileSync(script, 'turns:\n  - - message: "Done."\n    - end_turn: end_turn\n');
  const channel = new FakeChannel();
  const pet = new PetFeed({ changed: () => {} });
  const tokens: string[] = [];
  const ran: string[] = [];
  const herd = new Herd({
    home,
    userHome: home,
    channel: pet.wrap(channel),
    binding: { channelId: channel.id, ownerId: "owner", data: {} },
    mode: "assist",
    locale: "en",
    profiles: [
      {
        id: "mock",
        name: "Mock",
        command: [process.execPath, BIN, "--script", script],
        env: {},
        exporter: null,
      },
    ],
    store: Store.open(":memory:"),
    clock: new FakeClock(),
    apps: () => ({
      list: async () => [],
      describe: async () => tools,
      preflight: (name) =>
        name === WECOM
          ? {
              approvalArguments: { target: "Example to-do" },
              execute: async () => {
                ran.push(name);
                return { content: [{ type: "text", text: "done" }] };
              },
            }
          : undefined,
      call: async (name) => {
        ran.push(name);
        return { content: [{ type: "text", text: "done" }] };
      },
    }),
    mcpServer: (token) => {
      tokens.push(token);
      return { name: "agentherd", command: "unused", args: [], env: [] };
    },
  });
  cleanups.push(async () => {
    await herd.stop();
    rmSync(home, { recursive: true, force: true });
  });
  await herd.start();

  async function call(name: string) {
    const { turn } = await herd.startTask("mock", home, name);
    await turn;
    const token = tokens.at(-1);
    if (token === undefined) throw new Error("Expected a task token");
    const result = herd.mcp(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: {} },
    });
    const item = (
      await channel.waitFor(
        ({ view }) =>
          view.kind === "item" &&
          view.final === undefined &&
          (view.title === tools.get(name)?.title ||
            view.lines?.some((line) => line.title === tools.get(name)?.title) === true),
      )
    ).view as ItemView;
    return { item, result };
  }

  return { herd, pet, channel, ran, call };
}

describe("WeCom approval provenance", () => {
  it("leaves a desktop button approval pending for the owner on the channel", async () => {
    const { call, pet, channel, ran } = await setup();
    const { item, result } = await call(WECOM);
    expect(item.lines?.[0]?.body ?? item.body).toContain("Example to-do");

    await pet.press(item.itemId, "allow");
    expect(ran).toEqual([]);
    await channel.tap(item.itemId, "allow", "someone-else");
    expect(ran).toEqual([]);
    await channel.tap(item.itemId, "allow");

    expect((await result)?.result).toEqual({ content: [{ type: "text", text: "done" }] });
    expect(ran).toEqual([WECOM]);
  });

  it("does not trust channel-looking metadata on a local injection", async () => {
    const { call, herd, channel, ran } = await setup();
    const { result } = await call(WECOM);
    const inbound = {
      kind: "message" as const,
      text: "allow 1",
      from: "owner",
      ref: { channelId: channel.id, id: "in123" },
    };

    await herd.handle(inbound);
    expect(ran).toEqual([]);
    await channel.say("allow 1");

    expect((await result)?.result).toEqual({ content: [{ type: "text", text: "done" }] });
    expect(ran).toEqual([WECOM]);
  });

  it.each(["allow-all button", "approve all", "allow 1 and 2"])(
    "keeps WeCom pending for a desktop %s but allows other tools",
    async (approval) => {
      const { call, pet, channel, ran } = await setup();
      const wecom = await call(WECOM);
      const other = await call(OTHER);

      if (approval === "allow-all button") await pet.press(other.item.itemId, "allow-all");
      else await pet.say(approval);

      expect((await other.result)?.result).toEqual({ content: [{ type: "text", text: "done" }] });
      expect(ran).toEqual([OTHER]);
      await channel.say("approve all");
      expect((await wecom.result)?.result).toEqual({ content: [{ type: "text", text: "done" }] });
      expect(ran).toEqual([OTHER, WECOM]);
    },
  );

  it.each(["deny", "skip"])("can %s a WeCom call on the desktop", async (action) => {
    const { call, pet, ran } = await setup();
    const { item, result } = await call(WECOM);

    await pet.press(item.itemId, action);

    expect((await result)?.result).toMatchObject({ isError: true });
    expect(ran).toEqual([]);
  });

  it("still allows a non-WeCom call from the desktop button", async () => {
    const { call, pet, ran } = await setup();
    const { item, result } = await call(OTHER);

    await pet.press(item.itemId, "allow");

    expect((await result)?.result).toEqual({ content: [{ type: "text", text: "done" }] });
    expect(ran).toEqual([OTHER]);
  });
});
