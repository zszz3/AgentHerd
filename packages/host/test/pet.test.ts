import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeChannel, type SentMessage } from "@agentherd/channel-fake";
import { Herd, type HerderTurn, type OwnerCard, Store } from "@agentherd/core";
import type { Inbound, ItemView, ReportView, View } from "@agentherd/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { PET_DROP_MAX, type PetCardView } from "../src/api.ts";
import {
  echoQuote,
  historyOf,
  PET_CARD_TEXT_MAX,
  PET_HISTORY_MAX,
  PET_HISTORY_TEXT_MAX,
  PetFeed,
  petConversation,
} from "../src/pet.ts";
import { droppedFiles, droppedPictureType } from "../src/pet-drop.ts";

const BINDING = { channelId: "fake", ownerId: "owner", data: {} };

async function started(echo?: (text: string) => string, echoHoldMs?: number) {
  let changes = 0;
  const feed = new PetFeed({
    changed: () => changes++,
    ...(echo === undefined ? {} : { echo }),
    ...(echoHoldMs === undefined ? {} : { echoHoldMs }),
    now: () => new Date("2026-11-17T12:00:00Z"),
  });
  const fake = new FakeChannel("owner");
  const channel = feed.wrap(fake);
  const inbound: Inbound[] = [];
  await channel.start(BINDING, async (i) => {
    inbound.push(i);
  });
  return { feed, fake, channel, inbound, changes: () => changes };
}

describe("PetFeed (ADR 0070)", () => {
  it("passes everything to the chat and keeps the latest line", async () => {
    const t = await started();
    await t.channel.send({ kind: "text", text: "好的，我开个任务去看。" });
    await t.channel.send({ kind: "text", text: "跑测试", taskLabel: "修登录", tone: "progress" });
    expect(t.fake.messages).toHaveLength(2);
    expect(t.feed.last).toEqual({
      id: 2,
      at: "2026-11-17T12:00:00.000Z",
      kind: "task",
      text: "跑测试",
      task: "修登录",
    });
    await t.channel.send({
      kind: "report",
      taskId: "t1",
      result: "done",
      title: "修登录",
      body: "登录修好了，测试都过了。",
      summarized: false,
      automaticDecisions: [],
    });
    expect(t.feed.last).toMatchObject({ id: 3, kind: "report", result: "done", task: "修登录" });
    await t.channel.send({ kind: "text", text: "出错了", tone: "error" });
    expect(t.feed.last?.kind).toBe("error");
    expect(t.changes()).toBeGreaterThanOrEqual(5);
  });

  it("keeps the board out of the bubble", async () => {
    const t = await started();
    await t.channel.send({ kind: "board", tasks: [], mode: "assist" } as never);
    expect(t.feed.last).toBeUndefined();
  });

  it("lists open cards and drops them once answered", async () => {
    const t = await started();
    const item: ItemView = {
      kind: "item",
      itemId: "i1",
      taskLabel: "清理",
      title: "运行 rm -rf ./*",
      body: "rm -rf ./*",
      risk: "high",
      options: [
        { action: "allow", label: "同意" },
        { action: "deny", label: "拒绝" },
      ],
    };
    const ref = await t.channel.send(item);
    const askRef = await t.channel.send({
      kind: "ask",
      askId: "a1",
      text: "用哪个文件夹？",
      options: [{ action: "0", label: "learnspace" }],
    });
    await t.channel.send({
      kind: "text",
      text: "有 3 个新 issue",
      target: "offer-1",
      options: [{ action: "take", label: "看看" }],
    });
    expect(t.feed.pending().map((p) => p.target)).toEqual(["i1", "a1", "offer-1"]);
    expect(t.feed.pending()[0]).toMatchObject({ task: "清理", body: "rm -rf ./*" });
    expect(t.feed.last).toMatchObject({ kind: "say", text: "有 3 个新 issue" });

    await t.channel.update(ref, { ...item, options: [], final: "你已同意" });
    await t.channel.update(askRef, {
      kind: "ask",
      askId: "a1",
      text: "用哪个文件夹？",
      options: [],
      final: "learnspace",
    });
    expect(t.feed.pending().map((p) => p.target)).toEqual(["offer-1"]);
  });

  it("shows a combined card as one entry with its open lines", async () => {
    const t = await started();
    const line = (n: number, final?: string) => ({
      itemId: `i${n}`,
      n,
      title: `命令 ${n}`,
      body: "",
      risk: "high" as const,
      options: [],
      ...(final === undefined ? {} : { final }),
    });
    await t.channel.send({
      kind: "item",
      itemId: "card",
      title: "3 件事等你",
      body: "",
      risk: "high",
      options: [{ action: "allow-all", label: "都同意" }],
      lines: [line(1), line(2, "你已拒绝"), line(3)],
    });
    expect(t.feed.pending()[0]).toMatchObject({
      target: "card",
      count: 2,
      body: "1. 命令 1\n3. 命令 3",
    });
  });

  it("sends a button press and a typed message as the owner", async () => {
    const t = await started((text) => `（在桌宠里说）${text}`);
    await t.channel.send({
      kind: "item",
      itemId: "i1",
      title: "运行 rm -rf ./*",
      body: "",
      risk: "high",
      options: [{ action: "allow", label: "同意" }],
    });
    await t.feed.press("i1", "allow");
    await t.feed.say("  今天有什么新任务  ");
    expect(t.inbound).toEqual([
      { kind: "action", target: "i1", action: "allow", from: "owner" },
      { kind: "message", text: "今天有什么新任务", from: "owner" },
    ]);
    // No message of its own, so the chat app does not ring for what the owner wrote.
    expect(t.fake.messages).toHaveLength(1);
    expect(t.feed.last?.kind).toBe("ask");
  });

  it("quotes what the owner typed on top of the Herder's next answer", async () => {
    const t = await started((text) => `（在桌宠里说）${text}`);
    await t.feed.say("在吗");
    await t.feed.say("帮我看看登录");
    // A task's message and an offer are not the answer: they go as they are.
    await t.channel.send({ kind: "text", text: "跑测试", taskLabel: "修登录", tone: "progress" });
    await t.channel.send({
      kind: "text",
      text: "有 3 个新 issue",
      target: "offer-1",
      options: [{ action: "take", label: "看看" }],
    });
    const ref = await t.channel.send({ kind: "text", text: "在的，我开个任务去看。" });
    // Set apart: a quote per message, then a rule, then the Herder's words.
    const quote = "> （在桌宠里说）在吗\n>\n> （在桌宠里说）帮我看看登录\n\n---\n\n";
    expect(t.fake.messages.map((m) => m.view)).toEqual([
      { kind: "text", text: "跑测试", taskLabel: "修登录", tone: "progress" },
      expect.objectContaining({ text: "有 3 个新 issue" }),
      { kind: "text", text: `${quote}在的，我开个任务去看。` },
    ]);
    // The pet shows the Herder's words alone; an update in place keeps the quote in the chat.
    expect(t.feed.last).toMatchObject({ kind: "say", text: "在的，我开个任务去看。" });
    await t.channel.update(ref, { kind: "text", text: "在的，任务开好了。" });
    expect(t.fake.messages[2]?.view).toEqual({ kind: "text", text: `${quote}在的，任务开好了。` });
    // Taken once: the next answer goes as it is.
    await t.channel.send({ kind: "text", text: "还有别的吗？" });
    expect(t.fake.messages.at(-1)?.view).toEqual({ kind: "text", text: "还有别的吗？" });
  });

  it("quotes a message of several lines line by line", () => {
    expect(echoQuote(["（在桌宠里说）第一行\n第二行"])).toBe("> （在桌宠里说）第一行\n> 第二行");
  });

  it("quotes it on a Herder question and on a reply with herd-ui choices", async () => {
    const t = await started((text) => `（在桌宠里说）${text}`);
    await t.feed.say("找个面馆");
    await t.channel.send({
      kind: "ask",
      askId: "a1",
      text: "要走路能到的吗？",
      options: [{ action: "0", label: "要" }],
    });
    expect(t.fake.messages[0]?.view).toMatchObject({
      kind: "ask",
      text: "> （在桌宠里说）找个面馆\n\n---\n\n要走路能到的吗？",
    });
    expect(t.feed.pending()[0]?.title).toBe("要走路能到的吗？");

    await t.feed.say("你好");
    await t.channel.send({ kind: "text", text: "要设提醒吗？", target: "ui:abc" });
    expect(t.fake.messages[1]?.view).toEqual({
      kind: "text",
      text: "> （在桌宠里说）你好\n\n---\n\n要设提醒吗？",
      target: "ui:abc",
    });
  });

  it("posts it alone first when the owner presses or writes something else", async () => {
    const t = await started((text) => `（在桌宠里说）${text}`);
    await t.channel.send({
      kind: "ask",
      askId: "a1",
      text: "继续吗？",
      options: [{ action: "0", label: "继续" }],
    });
    await t.feed.say("等等");
    await t.feed.press("a1", "0");
    expect(t.fake.messages.at(-1)?.view).toEqual({ kind: "text", text: "（在桌宠里说）等等" });
    expect(t.inbound.at(-1)).toMatchObject({ kind: "action", target: "a1" });

    await t.feed.say("还在吗");
    await t.fake.say("我在飞书里说的");
    expect(t.fake.messages.at(-1)?.view).toEqual({ kind: "text", text: "（在桌宠里说）还在吗" });
    expect(t.inbound.at(-1)).toMatchObject({ kind: "message", text: "我在飞书里说的" });
    // The answer after that is not quoted: the line already went.
    await t.channel.send({ kind: "text", text: "在。" });
    expect(t.fake.messages.at(-1)?.view).toEqual({ kind: "text", text: "在。" });
  });

  it("posts it alone when no answer comes in time, or when the channel stops", async () => {
    const t = await started((text) => `（在桌宠里说）${text}`, 20);
    await t.feed.say("在吗");
    await t.fake.waitFor((m: SentMessage) => m.view.kind === "text");
    expect(t.fake.messages.map((m) => m.view)).toEqual([
      { kind: "text", text: "（在桌宠里说）在吗" },
    ]);
    expect(t.feed.last).toBeUndefined();

    const s = await started((text) => `（在桌宠里说）${text}`);
    await s.feed.say("先停一下");
    await s.channel.stop();
    expect(s.fake.messages.map((m) => m.view)).toEqual([
      { kind: "text", text: "（在桌宠里说）先停一下" },
    ]);
  });

  it("shows the Herder's conversation from herd.db for the expanded pet", () => {
    const at = "2026-11-17T12:00:00.000Z";
    const turns: HerderTurn[] = [
      { id: 7, at, role: "owner", text: "西岸附近有什么好吃的面" },
      { id: 8, at, role: "ask", text: "要走路能到的吗？\n- 要\n- 不用" },
      { id: 9, at, role: "answer", text: "要" },
      { id: 10, at, role: "herder", text: "好，我开个任务去小红书搜。" },
      { id: 11, at, role: "event", text: "面馆: （没有回复）", taskId: "t9" },
      { id: 12, at, role: "herder", text: "找到了，传媒港 B1 那一排。", taskId: "t1" },
      { id: 13, at, role: "herder", text: "   " },
      { id: 14, at, role: "herder", text: "旧任务说完了", taskId: "gone" },
      { id: 15, at, role: "herder", text: "[安静]" },
    ];
    const titles: Record<string, string> = { t1: "小红书：西岸面馆" };
    expect(historyOf(turns, (id) => titles[id])).toEqual([
      { id: 7, at, kind: "owner", text: "西岸附近有什么好吃的面" },
      { id: 8, at, kind: "ask", text: "要走路能到的吗？\n- 要\n- 不用" },
      { id: 9, at, kind: "owner", text: "要" },
      { id: 10, at, kind: "say", text: "好，我开个任务去小红书搜。" },
      { id: 11, at, kind: "task", text: "面馆: （没有回复）" },
      { id: 12, at, kind: "say", text: "找到了，传媒港 B1 那一排。", task: "小红书：西岸面馆" },
      { id: 14, at, kind: "say", text: "旧任务说完了" },
    ]);
    const long = historyOf(
      [{ id: 1, at, role: "herder", text: "长".repeat(5000) }],
      () => undefined,
    );
    expect(long[0]?.text).toHaveLength(PET_HISTORY_TEXT_MAX);
    const tagged = historyOf(
      [{ id: 2, at, role: "herder", text: '<acp tokens="39" type="text">m00205</p>\n找到两个' }],
      () => undefined,
    );
    expect(tagged[0]?.text).toBe("找到两个");
  });

  it("refuses stale buttons, empty text and a stopped herd", async () => {
    const t = await started();
    await expect(t.feed.press("gone", "allow")).rejects.toThrow("这件事已经处理过了");
    await expect(t.feed.say("   ")).rejects.toThrow("说点什么再发送");
    await t.channel.send({
      kind: "ask",
      askId: "a1",
      text: "继续吗？",
      options: [{ action: "0", label: "继续" }],
    });
    await t.channel.stop();
    expect(t.feed.connected).toBe(false);
    expect(t.feed.pending()).toEqual([]);
    await expect(t.feed.say("在吗")).rejects.toThrow("还没连上飞书");
  });

  it("a late stop of the old channel leaves the new one alone", async () => {
    const feed = new PetFeed({ changed: () => {} });
    const old = feed.wrap(new FakeChannel("owner"));
    await old.start(BINDING, async () => {});
    const next = feed.wrap(new FakeChannel("owner"));
    await next.start(BINDING, async () => {});
    await old.stop();
    expect(feed.connected).toBe(true);
  });

  it("delivers petSay without waiting on a slow Feishu, and the reply carries the echo", async () => {
    let releaseSend!: () => void;
    const fake = new FakeChannel("owner");
    const sent: string[] = [];
    const slow: typeof fake = Object.assign(Object.create(fake) as FakeChannel, {
      async send(view: Parameters<FakeChannel["send"]>[0]) {
        await new Promise<void>((r) => {
          releaseSend = r;
        });
        if (view.kind === "text") sent.push(view.text);
        return fake.send(view);
      },
      start: fake.start.bind(fake),
      stop: fake.stop.bind(fake),
      update: fake.update.bind(fake),
      pin: fake.pin.bind(fake),
    });
    const feed = new PetFeed({ changed: () => {}, echo: (text) => `（在桌宠里说）${text}` });
    const channel = feed.wrap(slow);
    const inbound: Inbound[] = [];
    await channel.start(BINDING, async (i) => {
      inbound.push(i);
    });
    // Nothing goes to Feishu yet, so a slow Feishu cannot hold up the owner's message.
    await feed.say("你好");
    expect(inbound).toEqual([{ kind: "message", text: "你好", from: "owner" }]);
    expect(sent).toEqual([]);
    const reply = channel.send({ kind: "text", text: "回复" });
    await new Promise((r) => setImmediate(r));
    releaseSend();
    await reply;
    expect(sent).toEqual(["> （在桌宠里说）你好\n\n---\n\n回复"]);
  });
});

const REPORT: ReportView = {
  kind: "report",
  taskId: "t1",
  result: "done",
  title: "修登录",
  subtitle: "已完成 · demo · Pi · 3 分钟",
  body: "登录修好了，测试都过了。",
  summarized: true,
  fullReply: "我改了 auth.ts……",
  fullReplyBy: "Pi",
  automaticDecisions: [],
};

describe("exact approvals through PetFeed.wrap", () => {
  it("forwards only an explicit opt-in from the underlying channel", () => {
    const feed = new PetFeed({ changed: () => {} });
    const fake = new FakeChannel("owner");
    expect(feed.wrap(fake).exactApproval).toBe(true);
    Reflect.deleteProperty(fake, "exactApproval");
    expect(feed.wrap(fake).exactApproval).toBeUndefined();
    // Untyped adapters do not opt in with a merely truthy value.
    Reflect.set(fake, "exactApproval", "true");
    expect(feed.wrap(fake).exactApproval).toBeUndefined();
  });

  it.each(["send", "update"] as const)(
    "passes an exact %s to chat without exposing it to the pet",
    async (op) => {
      const store = Store.open(":memory:");
      try {
        let changes = 0;
        const feed = new PetFeed({
          changed: () => changes++,
          keep: (ref, view) => store.putOwnerCard(ref, view),
        });
        const fake = new FakeChannel("owner");
        const channel = feed.wrap(fake);
        const inbound: Inbound[] = [];
        await channel.start(BINDING, (event) => {
          inbound.push(event);
        });
        const ordinary = await channel.send(REPORT);
        const last = feed.last;
        const before = changes;
        const item: ItemView = {
          kind: "item",
          itemId: "exact-1",
          title: "Confirm an exact operation",
          body: "",
          exactApproval: `  <lamp> & **literal**\n${"value ".repeat(120)}end  `,
          risk: "high",
          options: [{ action: "allow", label: "Allow" }],
        };
        const view = op === "send" ? item : { ...item, title: "Confirm this operation" };
        const expected = structuredClone(view);
        // For update, seed the same exact card in chat without taking the wrapper's send path.
        const ref = op === "send" ? await channel.send(view) : await fake.send(item);
        if (op === "update") await channel.update(ref, view);
        expect(fake.ofKind("item")[0]?.ref).toBe(ref);
        expect(fake.ofKind("item")[0]?.view).toEqual(expected);

        expect(feed.last).toEqual(last);
        expect(changes).toBe(before);
        expect(feed.pending()).toEqual([]);
        expect(feed.isOpen(`fake:${ref.id}`)).toBe(false);
        await expect(feed.press(item.itemId, "allow")).rejects.toThrow("这件事已经处理过了");
        expect(inbound).toEqual([]);
        expect(store.ownerCards().map((card) => card.ref)).toEqual([`fake:${ordinary.id}`]);
        expect(
          petConversation(
            [],
            store.ownerCards(),
            () => undefined,
            (key) => feed.isOpen(key),
          ).cards.map((card) => card.ref),
        ).toEqual([`fake:${ordinary.id}`]);

        await fake.tap(item.itemId, "allow");
        expect(inbound).toEqual([
          { kind: "action", target: item.itemId, action: "allow", from: "owner", cardRef: ref },
        ]);
        const closed = { ...view, options: [], final: "Allowed by you" };
        await channel.update(ref, closed);
        expect(fake.ofKind("item")[0]?.view).toEqual({
          ...expected,
          options: [],
          final: "Allowed by you",
        });
        expect(store.ownerCards().map((card) => card.ref)).toEqual([`fake:${ordinary.id}`]);
        expect(changes).toBe(before);
      } finally {
        store.close();
      }
    },
  );
});

describe("cards in the pet (ADR 0072)", () => {
  it("keeps every card in its latest form and knows which still take a press", async () => {
    const kept: [string, View][] = [];
    const feed = new PetFeed({ changed: () => {}, keep: (ref, view) => kept.push([ref, view]) });
    const fake = new FakeChannel("owner");
    const channel = feed.wrap(fake);
    const inbound: Inbound[] = [];
    await channel.start(BINDING, async (i) => {
      inbound.push(i);
    });
    await channel.send({ kind: "text", text: "好的" });
    const reportRef = await channel.send(REPORT);
    const line = (n: number) => ({
      itemId: `i${n}`,
      n,
      title: `命令 ${n}`,
      body: "",
      risk: "high" as const,
      options: [{ action: "allow", label: "同意" }],
    });
    const combined: ItemView = {
      kind: "item",
      itemId: "card",
      title: "2 件事等你",
      body: "",
      risk: "high",
      options: [{ action: "allow-all", label: "都同意" }],
      lines: [line(1), line(2)],
    };
    const cardRef = await channel.send(combined);
    // Plain text is a line, not a card; the report is a card from its first send.
    expect(kept.map(([ref, v]) => [ref, v.kind])).toEqual([
      [`fake:${reportRef.id}`, "report"],
      [`fake:${cardRef.id}`, "item"],
    ]);
    expect(feed.last).toMatchObject({ kind: "ask", card: `fake:${cardRef.id}` });
    expect(feed.isOpen(`fake:${reportRef.id}`)).toBe(false);
    expect(feed.isOpen(`fake:${cardRef.id}`)).toBe(true);
    // One line of a combined card can be answered on its own, as on the Feishu card.
    await feed.press("i2", "allow");
    expect(inbound).toEqual([{ kind: "action", target: "i2", action: "allow", from: "owner" }]);
    await expect(feed.press("i3", "allow")).rejects.toThrow("这件事已经处理过了");
    await channel.update(cardRef, { ...combined, options: [], final: "都处理完了" });
    expect(kept.at(-1)?.[1]).toMatchObject({ kind: "item", final: "都处理完了" });
    expect(feed.isOpen(`fake:${cardRef.id}`)).toBe(false);
  });

  it("shows cards with the conversation and leaves out the lines they already show", () => {
    const at = (m: number) => `2026-11-18T10:${String(m).padStart(2, "0")}:00.000Z`;
    const ask: PetCardView = {
      kind: "ask",
      askId: "a1",
      text: "要走路能到的吗？",
      options: [{ action: "0", label: "要" }],
    };
    const item: ItemView = {
      kind: "item",
      itemId: "i1",
      title: "Run rm -rf ./logs",
      body: "rm -rf ./logs",
      risk: "high",
      options: [],
      final: "你已同意",
    };
    const quiet: ReportView = { ...REPORT, taskId: "t2", title: "清理", body: "清完了。" };
    const turns: HerderTurn[] = [
      { id: 1, at: at(1), role: "owner", text: "西岸附近有什么好吃的面" },
      { id: 2, at: at(2), role: "ask", text: "要走路能到的吗？\n- 要\n- 不用" },
      { id: 3, at: at(3), role: "answer", text: "要" },
      { id: 4, at: at(9), role: "herder", text: "登录修好了，测试都过了。", taskId: "t1" },
      { id: 5, at: at(9), role: "herder", text: "另外，明天再看看缓存。", taskId: "t1" },
      { id: 6, at: at(10), role: "event", text: "清理: Run rm -rf ./logs", taskId: "t2" },
      { id: 7, at: at(11), role: "event", text: "清理: 清完了。", taskId: "t2" },
    ];
    const cards: OwnerCard[] = [
      { ref: "f:old", at: at(0), updatedAt: at(0), view: REPORT },
      { ref: "f:a", at: at(2), updatedAt: at(3), view: ask },
      { ref: "f:r", at: at(9), updatedAt: at(9), taskId: "t1", view: REPORT },
      { ref: "f:i", at: at(10), updatedAt: at(10), view: item },
      { ref: "f:q", at: at(11), updatedAt: at(11), taskId: "t2", view: quiet },
      { ref: "f:b", at: at(12), updatedAt: at(12), view: { kind: "board" } as never },
      {
        ref: "f:exact",
        at: at(13),
        updatedAt: at(13),
        view: { ...item, exactApproval: "literal" },
      },
    ];
    const { history, cards: shown } = petConversation(
      turns,
      cards,
      () => "修登录",
      (ref) => ref === "f:a",
    );
    expect(history.map((l) => l.id)).toEqual([1, 3, 5]);
    // Older cards stay in a short window; the board and any stored exact approval stay hidden.
    expect(shown.map((c) => [c.ref, c.open])).toEqual([
      ["f:old", false],
      ["f:a", true],
      ["f:r", false],
      ["f:i", false],
      ["f:q", false],
    ]);
    // A full window of lines starts at its first line: cards before it are left out.
    const full: HerderTurn[] = Array.from({ length: PET_HISTORY_MAX }, (_, i) => ({
      id: i + 1,
      at: at(1),
      role: "owner",
      text: `第 ${i + 1} 句`,
    }));
    expect(
      petConversation(
        full,
        cards,
        () => undefined,
        () => false,
      ).cards[0]?.ref,
    ).toBe("f:a");
  });

  it("cuts long reports for the pet", () => {
    const long: OwnerCard = {
      ref: "f:1",
      at: "2026-11-18T10:00:00.000Z",
      updatedAt: "2026-11-18T10:00:00.000Z",
      view: { ...REPORT, body: "长".repeat(9000), fullReply: "原".repeat(9000) },
    };
    const [card] = petConversation(
      [],
      [long],
      () => undefined,
      () => false,
    ).cards;
    const view = card?.view as ReportView;
    expect(view.body).toHaveLength(PET_CARD_TEXT_MAX);
    expect(view.fullReply).toHaveLength(PET_CARD_TEXT_MAX);
  });
});

const BIN = fileURLToPath(new URL("../../mock-agent/bin/mock-agent.ts", import.meta.url));
const herds: Herd[] = [];
afterEach(async () => {
  await Promise.all(herds.splice(0).map((h) => h.stop()));
});

describe("E2E-PET-APPROVE (ADR 0070)", () => {
  it("the owner allows a mass delete from the pet and the chat card closes too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ah-pet-"));
    const script = join(dir, "script.yaml");
    writeFileSync(
      script,
      `
turns:
  - - tool_call: { id: t1, title: "Run rm -rf ./*", kind: execute, command: "rm -rf ./*", status: pending }
    - request_permission:
        toolCall: { id: t1, title: "Run rm -rf ./*", kind: execute, command: "rm -rf ./*" }
        expect: allow
    - message: "done"
    - end_turn: end_turn
`,
    );
    const feed = new PetFeed({ changed: () => {} });
    const fake = new FakeChannel("owner");
    const herd = new Herd({
      home: dir,
      userHome: "/Users/me",
      channel: feed.wrap(fake),
      binding: BINDING,
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
    });
    herds.push(herd);
    await herd.start();
    const run = herd.run("mock", dir, "go");
    const card = await fake.waitFor(
      (m: SentMessage) => m.view.kind === "item" && (m.view as ItemView).final === undefined,
    );
    expect(feed.pending()).toMatchObject([{ target: (card.view as ItemView).itemId }]);
    await feed.press((card.view as ItemView).itemId, "allow");
    const result = await run;
    expect(result.stopReason).toBe("end_turn");
    expect((card.view as ItemView).final).toBe("Allowed by you");
    expect(feed.pending()).toEqual([]);
  });
});

describe("E2E-PET-CARDS (ADR 0072)", () => {
  it("keeps a task's report card in herd.db and stops a working task for the owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ah-pet-cards-"));
    const done = join(dir, "done.yaml");
    writeFileSync(done, `turns:\n  - - message: "登录修好了"\n    - end_turn: end_turn\n`);
    const slow = join(dir, "slow.yaml");
    writeFileSync(
      slow,
      `turns:\n  - - message: "在看"\n    - sleep: 30000\n    - end_turn: end_turn\n`,
    );
    const store = Store.open(":memory:");
    const feed = new PetFeed({
      changed: () => {},
      keep: (ref, view) =>
        store.putOwnerCard(ref, view, view.kind === "report" ? view.taskId : undefined),
    });
    const fake = new FakeChannel("owner");
    const profile = (id: string, script: string) => ({
      id,
      name: id,
      command: [process.execPath, BIN, "--script", script],
      env: {},
      exporter: null,
    });
    const herd = new Herd({
      home: dir,
      userHome: "/Users/me",
      channel: feed.wrap(fake),
      binding: BINDING,
      mode: "assist",
      locale: "zh-CN",
      profiles: [profile("done", done), profile("slow", slow)],
      store,
    });
    herds.push(herd);
    await herd.start();
    await herd.run("done", dir, "修登录");
    await fake.waitFor((m: SentMessage) => m.view.kind === "report");
    const [card] = store.ownerCards();
    expect(card).toMatchObject({ taskId: herd.tasks()[0]?.id, view: { kind: "report" } });

    const run = herd.run("slow", dir, "慢慢看").catch((e: Error) => e);
    let task = herd.tasks().find((t) => t.agent === "slow");
    for (let i = 0; i < 100 && task?.stage !== "working"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      task = herd.tasks().find((t) => t.agent === "slow");
    }
    expect(task?.stage).toBe("working");
    await herd.stopTask(task?.id ?? "");
    await run;
    const stoppedCard = fake.messages
      .map((m) => m.view)
      .find((v): v is ReportView => v.kind === "report" && v.taskId === task?.id);
    expect(stoppedCard).toMatchObject({
      result: "stopped",
      body: "你停下了这个任务，做到一半的事没有做完。",
    });
    expect(store.ownerCards().map((c) => c.view.kind)).toEqual(["report", "report"]);
    await expect(herd.stopTask("nope")).rejects.toThrow("no task nope");
  }, 20000);
});

const CHOICE_REPLY = [
  "找到两个 magpie：",
  "",
  "```herd-ui",
  '{"items":[{"type":"choices","question":"下一步？","options":["下载跑一下","先不用"]}]}',
  "```",
].join("\n");

describe("herd-ui choices in the pet (ADR 0074)", () => {
  it("a reply with choices is a card whose answers work until one is picked", async () => {
    const t = await started();
    const view: View = { kind: "text", text: CHOICE_REPLY, target: "ui:1" };
    const ref = await t.channel.send(view);
    expect(t.feed.last?.card).toBe(`${ref.channelId}:${ref.id}`);
    expect(t.feed.isOpen(`${ref.channelId}:${ref.id}`)).toBe(true);
    // Choices are offers, not something waiting for the owner.
    expect(t.feed.pending()).toEqual([]);
    await t.feed.press("ui:1", "1");
    expect(t.inbound).toEqual([{ kind: "action", target: "ui:1", action: "1", from: "owner" }]);
    await expect(t.feed.press("ui:1", "2")).rejects.toThrow("这件事已经处理过了");
    await t.channel.update(ref, { ...view, chosen: "先不用" });
    expect(t.feed.isOpen(`${ref.channelId}:${ref.id}`)).toBe(false);
    await expect(t.feed.press("ui:1", "0")).rejects.toThrow("这件事已经处理过了");
    // A reply with a block but no choices stays a line, and keeps its whole block.
    const table = `看这个：\n\n\`\`\`herd-ui\n{"type":"text","content":"${"字".repeat(1000)}"}\n\`\`\``;
    await t.channel.send({ kind: "text", text: table });
    expect(t.feed.last).toMatchObject({ kind: "say", text: table });
    expect(t.feed.last?.card).toBeUndefined();
  });

  it("shows the reply once, as its card", () => {
    const at = "2026-11-18T10:00:00.000Z";
    const turns: HerderTurn[] = [
      { id: 1, at, role: "owner", text: "找一下 magpie" },
      { id: 2, at, role: "herder", text: CHOICE_REPLY },
      { id: 3, at, role: "answer", text: "先不用" },
    ];
    const card: OwnerCard = {
      ref: "f:c",
      at,
      updatedAt: at,
      view: { kind: "text", text: CHOICE_REPLY, target: "ui:1", chosen: "先不用" },
    };
    const { history, cards } = petConversation(
      turns,
      [card],
      () => undefined,
      () => false,
    );
    expect(history.map((l) => l.id)).toEqual([1, 3]);
    expect(cards).toMatchObject([{ ref: "f:c", open: false, view: { chosen: "先不用" } }]);
  });
});

describe("E2E-HERD-UI-CHOICES in the pet (ADR 0074)", () => {
  it("a pick in the pet reaches the Herder and the card shows it after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ah-pet-choices-"));
    const store = Store.open(":memory:");
    const feed = new PetFeed({
      changed: () => {},
      keep: (ref, view) => store.putOwnerCard(ref, view),
    });
    const fake = new FakeChannel("owner");
    const answers: string[] = [];
    let say: ((text: string) => Promise<void>) | undefined;
    const herd = new Herd({
      home: dir,
      userHome: "/Users/me",
      channel: feed.wrap(fake),
      binding: BINDING,
      mode: "assist",
      locale: "zh-CN",
      profiles: [],
      store,
      herder: (h) => {
        say = h.say;
        return {
          ownerMessage: () => {},
          ownerAnswer: (q, a) => answers.push(`${q} ${a}`),
          event: () => {},
          stop: async () => {},
        };
      },
    });
    herds.push(herd);
    await herd.start();
    await say?.(CHOICE_REPLY);
    const [stored] = store.ownerCards();
    expect(stored?.view).toMatchObject({ kind: "text", target: expect.stringMatching(/^ui:/) });
    const target = (stored?.view as { target?: string } | undefined)?.target ?? "";
    await feed.press(target, "0");
    expect(answers).toEqual(["下一步？ 下载跑一下"]);
    expect(store.ownerCards()[0]?.view).toMatchObject({ chosen: "下载跑一下" });
    // Feishu's card got the same update.
    expect(fake.messages[0]?.view).toMatchObject({ chosen: "下载跑一下" });
  });
});

describe("files dropped on the pet (ADR 0082)", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  it("sends a picture as an image of the message and other files by their path", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentherd-drop-"));
    const picture = join(dir, "screen.png");
    const doc = join(dir, "plan.pdf");
    const fake = join(dir, "not-really.png");
    writeFileSync(picture, PNG);
    writeFileSync(doc, "%PDF-1.4");
    writeFileSync(fake, "hello");
    const dropped = droppedFiles([picture, doc, fake, dir, picture], "zh-CN");
    expect(dropped.images.map((x) => [x.mimeType, [...x.data]])).toEqual([["image/png", [...PNG]]]);
    expect(dropped.lines).toEqual([
      `[主人拖来文件「plan.pdf」：${doc}]`,
      `[主人拖来文件「not-really.png」：${fake}]`,
      `[主人拖来文件夹「${basename(dir)}」：${dir}]`,
    ]);
    expect(droppedFiles([doc], "en").lines).toEqual([
      `[The owner dropped the file "plan.pdf" on the pet: ${doc}]`,
    ]);
  });

  it("refuses what is not there, relative paths and too many files", () => {
    expect(() => droppedFiles(["/nowhere/at/all.txt"], "zh-CN")).toThrow(
      "找不到 /nowhere/at/all.txt",
    );
    expect(() => droppedFiles(["notes.txt"], "en")).toThrow("cannot find notes.txt");
    const many = Array.from({ length: PET_DROP_MAX + 1 }, (_, i) => `/tmp/${i}`);
    expect(() => droppedFiles(many, "zh-CN")).toThrow(`一次最多拖 ${PET_DROP_MAX} 个文件`);
    expect(droppedPictureType(new Uint8Array([0xff, 0xd8, 0xff, 0]))).toBe("image/jpeg");
    expect(droppedPictureType(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it("passes the dropped files on as the owner's message, with no words needed", async () => {
    const t = await started((text) => `（在桌宠里说）${text}`);
    const image = { mimeType: "image/png", data: PNG };
    await t.feed.say("", { images: [image] });
    await t.feed.say("看看这个", { lines: ["[主人拖来文件「a.pdf」：/tmp/a.pdf]"] });
    expect(t.inbound).toEqual([
      { kind: "message", text: "", from: "owner", images: [image] },
      { kind: "message", text: "看看这个\n[主人拖来文件「a.pdf」：/tmp/a.pdf]", from: "owner" },
    ]);
    await expect(t.feed.say("  ", { images: [], lines: [] })).rejects.toThrow("说点什么再发送");
  });
});
