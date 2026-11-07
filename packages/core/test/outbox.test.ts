import { FakeChannel } from "@agentherd/channel-fake";
import type { View } from "@agentherd/protocol";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/clock.ts";
import { Outbox, retryDelay } from "../src/outbox.ts";
import { Store } from "../src/store.ts";

const text = (t: string): View => ({ kind: "text", text: t });

function failing(channel: FakeChannel) {
  const send = channel.send.bind(channel);
  const state = { offline: true, tries: 0 };
  channel.send = async (view: View) => {
    state.tries += 1;
    if (state.offline) throw new Error("offline");
    return send(view);
  };
  return state;
}

describe("Outbox", () => {
  it("waits 2 s, then twice as long each time, at most a minute", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(retryDelay)).toEqual([
      2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
    ]);
  });

  it("sends at once and keeps nothing when the channel takes it", async () => {
    const channel = new FakeChannel("owner");
    const store = Store.open(":memory:");
    const outbox = new Outbox(channel, store, new FakeClock());
    outbox.start();
    const ref = await outbox.send(text("hi"), "task-1");
    expect(ref).toBeDefined();
    expect(store.outbox()).toEqual([]);
    expect(store.taskOfMessage(ref?.id as string)).toBe("task-1");
  });

  it("retries with growing delays and keeps the order", async () => {
    const channel = new FakeChannel("owner");
    const state = failing(channel);
    const store = Store.open(":memory:");
    const clock = new FakeClock();
    const outbox = new Outbox(channel, store, clock);
    outbox.start();
    expect(await outbox.send(text("one"))).toBeUndefined();
    expect(await outbox.send(text("two"))).toBeUndefined();
    expect(store.outbox().map((r) => r.attempts)).toEqual([1, 1]);
    await clock.advance(2000);
    expect(store.outbox().map((r) => r.attempts)).toEqual([2, 2]);
    state.offline = false;
    await clock.advance(4000);
    expect(channel.messages.map((m) => (m.view as { text: string }).text)).toEqual(["one", "two"]);
    expect(store.outbox()).toEqual([]);
  });

  it("sends what an earlier run left behind once started", async () => {
    const store = Store.open(":memory:");
    const first = new FakeChannel("owner");
    failing(first);
    const before = new Outbox(first, store, new FakeClock());
    await before.send(text("left over"), "task-9");
    before.stop();
    const channel = new FakeChannel("owner");
    const after = new Outbox(channel, store, new FakeClock());
    after.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(channel.messages.map((m) => (m.view as { text: string }).text)).toEqual(["left over"]);
    expect(store.outbox()).toEqual([]);
  });

  it("drops a message the channel refused for a day", async () => {
    const channel = new FakeChannel("owner");
    failing(channel);
    const store = Store.open(":memory:");
    const clock = new FakeClock();
    const outbox = new Outbox(channel, store, clock);
    outbox.start();
    await outbox.send(text("lost"));
    await clock.advance(25 * 60 * 60 * 1000);
    expect(store.outbox()).toEqual([]);
    expect(store.auditRows("send.dropped")).toHaveLength(1);
  });
});
