import { expect, it, vi } from "vitest";
import type { BoundDingTalkRun } from "../src/dingtalk-account.ts";
import { dingtalkTools } from "../src/dingtalk-tools.ts";

function fixture(
  result: unknown = {
    ok: true,
    identity: "user",
    tool: "send_personal_message",
    result: { result: { openMessageId: "new-msg", sendStatus: "accepted" } },
    sendReceipt: {
      contractVersion: "im.message-send-receipt.v1",
      messageRef: { openMessageId: "new-msg" },
    },
  },
) {
  const run = vi.fn<BoundDingTalkRun>().mockImplementation(async ({ args }) =>
    args[1] === "+conversation-info"
      ? {
          success: true,
          result: {
            openConversationId: "cidExample",
            singleChat: false,
            conversationName: "Example group",
          },
        }
      : result,
  );
  const view = vi.fn(async () => ({ state: "connected" as const, capabilities: [] }));
  return { run, tools: dingtalkTools({ bind: async () => run, view }) };
}

it("exposes nine reads and three protected writes", async () => {
  const { tools } = fixture();
  const list = await tools.list();
  expect(list).toHaveLength(12);
  expect(
    (await tools.describe(list.map(({ name }) => name))).get("dingtalk_group_send_text"),
  ).toMatchObject({ toolkit: "builtin:dingtalk", hints: { readOnly: false } });
});

it("preflights the exact group, freezes literal text and will not dispatch twice", async () => {
  const { run, tools } = fixture();
  const args = { groupId: "cidExample", text: "--file=private.txt" };
  await expect(tools.call("dingtalk_group_send_text", args)).rejects.toThrow();
  const prepared = await tools.preflight?.("dingtalk_group_send_text", args);
  expect(prepared?.approvalArguments).toMatchObject({
    target: "Example group",
    groupId: "cidExample",
  });
  expect(run).toHaveBeenCalledTimes(1);
  args.text = "changed";
  await prepared?.execute();
  await expect(prepared?.execute()).rejects.toThrow();
  expect(run.mock.lastCall?.[0].args).toEqual([
    "chat",
    "+messages-send",
    "--as=user",
    "--group=cidExample",
    "--msg-type=text",
    "--text=--file=private.txt",
    "--yes",
  ]);
});

it("rejects unverified groups before reading messages", async () => {
  const { tools, run } = fixture();
  run.mockResolvedValue({
    success: true,
    result: { openConversationId: "cidExample", singleChat: true, name: "Direct chat" },
  });
  await expect(tools.call("dingtalk_group_history", { groupId: "cidExample" })).rejects.toThrow();
  expect(run).toHaveBeenCalledTimes(1);
});

it("does not treat a partial list as complete or expose provider failure details", async () => {
  const { tools, run } = fixture({
    contractVersion: "doc.list.v1",
    status: "success",
    documents: [],
    hasMore: true,
    nextCursor: "next",
    complete: false,
  });
  await expect(tools.call("dingtalk_doc_search", { query: "plan" })).resolves.toEqual({
    content: [
      { type: "text", text: JSON.stringify({ items: [], nextCursor: "next", partial: true }) },
    ],
  });
  expect(run.mock.lastCall?.[0].args).toEqual(["doc", "+search", "--query=plan", "--limit=20"]);
  run.mockResolvedValue({ ok: false, message: "FAKE_PRIVATE_PROVIDER_ERROR" });
  await expect(tools.call("dingtalk_doc_search", { query: "plan" })).rejects.toThrow("无法验证");
});

it("rejects path-like arguments, unknown flags, resource markup and invalid dates", async () => {
  const { tools, run } = fixture();
  await expect(tools.call("dingtalk_doc_fetch", { nodeId: "../private.txt" })).rejects.toThrow();
  await expect(
    tools.call("dingtalk_doc_fetch", { nodeId: "example", output: "private.txt" }),
  ).rejects.toThrow();
  for (const text of ["![local](private.png)", "<img src='private.png'>", "@private.txt"]) {
    await expect(
      tools.preflight?.("dingtalk_doc_create", { title: "Test", text }),
    ).rejects.toThrow();
  }
  await expect(
    tools.call("dingtalk_calendar_list", {
      start: "2026-02-30T10:00:00Z",
      end: "2026-03-05T10:00:00Z",
    }),
  ).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});

it("reads the full summary from the pinned single-ID minutes detail envelope", async () => {
  const { tools, run } = fixture({
    complete: true,
    failureCount: 0,
    taskUuid: "minute-example",
    summary: { success: true, result: { fullSummary: "Example summary" } },
  });
  await expect(
    tools.call("dingtalk_minutes_summary", { minutesId: "minute-example" }),
  ).resolves.toEqual({
    content: [{ type: "text", text: JSON.stringify({ summary: "Example summary" }) }],
  });
  expect(run.mock.lastCall?.[0].args).toEqual([
    "minutes",
    "+detail",
    "--id=minute-example",
    "--artifacts=summary",
  ]);
  run.mockResolvedValue({
    complete: false,
    taskUuid: "minute-example",
    summary: { error: "FAKE_PRIVATE_PROVIDER_ERROR" },
  });
  await expect(
    tools.call("dingtalk_minutes_summary", { minutesId: "minute-example" }),
  ).rejects.toThrow("无法验证");
});

it("retains verified document receipt and passes inline text by stdin only", async () => {
  const { tools, run } = fixture({
    contractVersion: "doc.operation.v1",
    status: "success",
    complete: true,
    data: { verified: true, nodeId: "node123" },
  });
  const prepared = await tools.preflight?.("dingtalk_doc_create", {
    title: "Test",
    text: "Line one\nLine two",
  });
  expect(run).not.toHaveBeenCalled();
  await expect(prepared?.execute()).resolves.toEqual({
    content: [{ type: "text", text: JSON.stringify({ nodeId: "node123", verified: true }) }],
  });
  expect(run.mock.lastCall?.[0]).toEqual({
    args: ["doc", "+create", "--name=Test", "--content=-"],
    stdin: "Line one\nLine two",
  });
});
