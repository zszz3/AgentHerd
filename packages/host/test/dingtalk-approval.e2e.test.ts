import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeChannel } from "@agentherd/channel-fake";
import { FakeClock, Herd, Store } from "@agentherd/core";
import type { ItemView } from "@agentherd/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { DingTalkAccount } from "../src/dingtalk-account.ts";
import type { DingTalkCliPort } from "../src/dingtalk-cli.ts";
import { dingtalkTools } from "../src/dingtalk-tools.ts";
import { PetFeed } from "../src/pet.ts";

const BIN = fileURLToPath(new URL("../../mock-agent/bin/mock-agent.ts", import.meta.url));
const writes = {
  dingtalk_group_send_text: { groupId: "cidExample", text: "Hello" },
  dingtalk_calendar_create: {
    title: "Example",
    start: "2026-11-25T10:00:00+08:00",
    end: "2026-11-25T11:00:00+08:00",
  },
  dingtalk_doc_create: { title: "Example", text: "Body" },
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
  const identity = { corpId: "corp", userId: "owner", corpName: "Example", userName: "Owner" };
  const status = vi.fn<DingTalkCliPort["status"]>().mockResolvedValue(identity);
  const ran: string[] = [];
  const lookups: string[] = [];
  const account = new DingTalkAccount({
    status,
    login: async () => {},
    markResetPending: async () => {},
    reset: async () => {},
    run: async (_identity, { args }, _signal, beforeDispatch) => {
      beforeDispatch?.();
      const leaf = args[1] ?? "";
      if (leaf === "+conversation-info") {
        lookups.push(leaf);
        return {
          success: true,
          result: { singleChat: false, openConversationId: "cidExample", title: "Example group" },
        };
      }
      ran.push(leaf);
      if (leaf === "+messages-send")
        return {
          ok: true,
          identity: "user",
          tool: "send_personal_message",
          result: { result: { openTaskId: "send-task" } },
          sendReceipt: { contractVersion: "im.message-send-receipt.v1", openTaskId: "send-task" },
        };
      if (args[0] === "doc")
        return {
          contractVersion: "doc.operation.v1",
          status: "success",
          complete: true,
          data: { nodeId: "example", verified: true },
        };
      return {
        ok: true,
        outcome: "success",
        data: { verified: true, success: true, eventId: "event" },
      };
    },
  });
  const app = dingtalkTools(account);
  const home = mkdtempSync(join(tmpdir(), "agentherd-dingtalk-approval-"));
  const script = join(home, "agent.yaml");
  writeFileSync(script, 'turns:\n  - - message: "Done."\n    - end_turn: end_turn\n');
  const channel = new FakeChannel();
  const pet = new PetFeed({ changed: () => {} });
  const tokens: string[] = [];
  const herd = new Herd({
    home,
    userHome: home,
    channel: pet.wrap(channel),
    binding: { channelId: channel.id, ownerId: "owner", data: {} },
    mode: "auto",
    locale: "en",
    store: Store.open(":memory:"),
    clock: new FakeClock(),
    profiles: [
      {
        id: "mock",
        name: "Mock",
        command: [process.execPath, BIN, "--script", script],
        env: {},
        exporter: null,
      },
    ],
    apps: () => ({
      ...app,
      call: async (name) => {
        ran.push(name);
        return { content: [{ type: "text", text: "unexpected dispatch" }] };
      },
    }),
    mcpServer: (token) => {
      tokens.push(token);
      return { name: "agentherd", command: "unused", args: [], env: [] };
    },
  });
  cleanups.push(async () => {
    await account.stop();
    await herd.stop();
    rmSync(home, { recursive: true, force: true });
  });
  await herd.start();
  let id = 0;
  const startTask = async () => {
    const { turn } = await herd.startTask("mock", home, "DingTalk office operation");
    await turn;
    const token = tokens.at(-1);
    if (token === undefined) throw new Error("Expected a task token");
    return (name: string, args: unknown) =>
      herd.mcp(token, {
        jsonrpc: "2.0",
        id: ++id,
        method: "tools/call",
        params: { name, arguments: args },
      });
  };
  const call = await startTask();
  const rule = (action: "allow" | "deny", slug: string) =>
    herd.addRule({
      id: `${action}-${slug}`,
      action,
      match: { toolKind: "app", command: slug },
      createdAt: "2026-11-04T00:00:00Z",
      createdBy: "owner",
    });
  const card = async (result: ReturnType<typeof call>) =>
    (
      await Promise.race([
        channel.waitFor(({ view }) => view.kind === "item" && view.final === undefined),
        result.then(() => {
          throw new Error("App call finished before owner confirmation");
        }),
      ])
    ).view as ItemView;
  return { call, card, rule, ran, lookups, status, channel, pet, account, startTask };
}

it.each(Object.entries(writes))(
  "requires a new owner confirmation for %s despite an allow rule",
  async (name, args) => {
    const { call, card, rule, ran, channel, pet } = await setup();
    rule("allow", name);
    const result = call(name, args);
    const item = await card(result);
    if (name === "dingtalk_group_send_text")
      expect(item.lines?.[0]?.body ?? item.body).toContain("Example group");
    await pet.press(item.itemId, "allow");
    await channel.tap(item.itemId, "allow", "someone-else");
    expect(ran).toEqual([]);
    await channel.tap(item.itemId, "allow");
    expect((await result)?.result).not.toMatchObject({ isError: true });
    expect(ran).toHaveLength(1);
    const second = call(name, args);
    const next = await card(second);
    expect(next.itemId).not.toBe(item.itemId);
    await pet.press(next.itemId, "deny");
    expect((await second)?.result).toMatchObject({ isError: true });
    expect(ran).toHaveLength(1);
  },
);

it("publishes each DingTalk write on its own Feishu card even when updates fail", async () => {
  const { call, startTask, card, channel, ran } = await setup();
  const otherCall = await startTask();
  const first = call("dingtalk_calendar_create", writes.dingtalk_calendar_create);
  const firstItem = await card(first);
  vi.spyOn(channel, "update").mockRejectedValue(new Error("update failed"));
  const second = otherCall("dingtalk_doc_create", writes.dingtalk_doc_create);
  await vi.waitFor(() => expect(channel.ofKind("item")).toHaveLength(2));
  const secondItem = channel.ofKind("item")[1]?.view;
  if (secondItem === undefined) throw new Error("Expected a separate card");
  expect(secondItem.itemId).not.toBe(firstItem.itemId);
  expect(secondItem.lines).toBeUndefined();
  await channel.tap(`card-${firstItem.itemId}`, "allow-all");
  expect(ran).toEqual([]);
  await channel.tap(firstItem.itemId, "allow");
  expect((await first)?.result).not.toMatchObject({ isError: true });
  expect(ran).toEqual(["+create"]);
  await channel.tap(secondItem.itemId, "deny");
  expect((await second)?.result).toMatchObject({ isError: true });
  expect(ran).toHaveLength(1);
});

it("fails closed when Feishu cannot publish a DingTalk approval", async () => {
  const { call, channel, ran } = await setup();
  vi.spyOn(channel, "send").mockRejectedValueOnce(new Error("send failed"));
  const name = "dingtalk_calendar_create";
  expect((await call(name, writes[name]))?.result).toMatchObject({ isError: true });
  expect(ran).toEqual([]);
});

it("does not let Composio's batch route dispatch a DingTalk slug", async () => {
  const { call, rule, ran } = await setup();
  const name = "dingtalk_group_send_text";
  rule("allow", name);
  const answer = await call("COMPOSIO_MULTI_EXECUTE_TOOL", {
    tools: [{ tool_slug: name, arguments: writes[name] }],
  });
  expect(answer?.result).toMatchObject({ isError: true });
  expect(ran).toEqual([]);
});

it.each(["deny", "disconnect", "identity change"])(
  "fails closed when %s occurs while waiting for confirmation",
  async (change) => {
    const { call, card, rule, ran, status, channel, account } = await setup();
    const name = "dingtalk_calendar_create";
    const result = call(name, writes[name]);
    const item = await card(result);
    if (change === "deny") rule("deny", name);
    else if (change === "disconnect") await account.disconnect();
    else status.mockResolvedValue({ corpId: "other", userId: "owner" });
    await channel.tap(item.itemId, "allow");
    expect((await result)?.result).toMatchObject({ isError: true });
    expect(ran).toEqual([]);
  },
);

it.each([
  ["dingtalk_group_history", { groupId: "cidExample" }],
  ["dingtalk_group_search_messages", { groupId: "cidExample", query: "Hello" }],
  ["dingtalk_group_send_text", writes.dingtalk_group_send_text],
] as const)("blocks %s before a DingTalk lookup", async (name, args) => {
  const { call, rule, ran, lookups } = await setup();
  rule("deny", name);
  expect((await call(name, args))?.result).toMatchObject({ isError: true });
  expect(lookups).toEqual([]);
  expect(ran).toEqual([]);
});

it("checks for a new deny after verifying the connected account", async () => {
  const { call, card, rule, ran, status, channel } = await setup();
  const name = "dingtalk_calendar_create";
  const result = call(name, writes[name]);
  const item = await card(result);
  let finishStatus!: (identity: { corpId: string; userId: string }) => void;
  status.mockReturnValueOnce(
    new Promise((resolve) => {
      finishStatus = resolve;
    }),
  );
  const checks = status.mock.calls.length;
  const approved = channel.tap(item.itemId, "allow");
  await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(checks + 1));
  rule("deny", name);
  finishStatus({ corpId: "corp", userId: "owner" });
  await approved;
  expect((await result)?.result).toMatchObject({ isError: true });
  expect(ran).toEqual([]);
});

it("does not dispatch denied reads or writes", async () => {
  const { call, rule, ran } = await setup();
  rule("deny", "dingtalk_doc_fetch");
  rule("deny", "dingtalk_doc_create");
  expect((await call("dingtalk_doc_fetch", { nodeId: "example" }))?.result).toMatchObject({
    isError: true,
  });
  expect((await call("dingtalk_doc_create", writes.dingtalk_doc_create))?.result).toMatchObject({
    isError: true,
  });
  expect(ran).toEqual([]);
});
