// E2E-HERDER-ALERT-CLOSES (ADR 0037): a 「重试」 card does not keep waiting for the owner once what it
// held ran, or once nothing waits on it any more (a restart, or a tap on an old card).

import { FakeChannel } from "@agentherd/channel-fake";
import type { TextView } from "@agentherd/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Herd } from "../../src/herd.ts";
import { HERDER_RETRY_TARGET, type HerderHost } from "../../src/herder-port.ts";
import { Store } from "../../src/store.ts";
import { CORE_TEXTS } from "../../src/texts.ts";

const T = CORE_TEXTS["zh-CN"];
let herds: Herd[] = [];

afterEach(async () => {
  await Promise.all(herds.map((h) => h.stop()));
  herds = [];
});

function herdOn(store: Store, channel = new FakeChannel("owner")) {
  const got: { host?: HerderHost } = {};
  const herd = new Herd({
    home: "/tmp/agentherd-alert",
    userHome: "/Users/me",
    channel,
    binding: { channelId: "fake", ownerId: "owner", data: {} },
    mode: "assist",
    profiles: [],
    store,
    closeStaleTasks: false,
    herder: (host) => {
      got.host = host;
      return {
        ownerMessage: () => {},
        ownerAnswer: () => {},
        event: () => {},
        stop: async () => {},
      };
    },
  });
  herds.push(herd);
  const host = () => {
    if (got.host === undefined) throw new Error("no Herder host");
    return got.host;
  };
  return { channel, herd, host };
}

const alertCards = (c: FakeChannel) =>
  c.messages.filter((m) => (m.view as TextView).target === HERDER_RETRY_TARGET);

function only<T>(list: T[]): T {
  const [one] = list;
  if (one === undefined || list.length !== 1) throw new Error(`expected one, got ${list.length}`);
  return one;
}

describe("E2E-HERDER-ALERT-CLOSES (ADR 0037)", () => {
  it("closes the 「重试」 card once what it held ran", async () => {
    const store = Store.open(":memory:");
    const { channel, herd, host } = herdOn(store);
    await herd.start();
    await host().alert(T.herderHeld("Connection error.", "在吗"), true);
    const card = only(alertCards(channel));
    expect((card.view as TextView).options).toHaveLength(1);

    await host().closeAlerts?.("done");
    const view = card.view as TextView;
    expect(view.text).toBe(T.herderHeldDone);
    expect(view.options).toBeUndefined();
    // Closed for good: the next close finds nothing to do.
    const before = card.history.length;
    await host().closeAlerts?.("stale");
    expect(card.history.length).toBe(before);
    expect(store.ownerCards().map((c) => (c.view as TextView).text)).toEqual([T.herderHeldDone]);
  });

  it("a restart closes the card the last run left, and drops one it never sent", async () => {
    const store = Store.open(":memory:");
    const first = herdOn(store);
    await first.herd.start();
    await first.host().alert(T.herderHeld("Connection error."), true);
    await first.herd.stop();
    herds = [];
    // A second card was still waiting for the channel when the app stopped.
    store.addOutbox({
      id: "unsent-1",
      view: {
        kind: "text",
        text: T.herderHeld("Connection error."),
        tone: "error",
        target: HERDER_RETRY_TARGET,
        options: [{ action: "retry", label: T.retry }],
      },
      attempts: 3,
      nextAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    // The same chat: the old card can still be changed.
    const second = herdOn(store, first.channel);
    await second.herd.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(store.outbox()).toEqual([]);
    const old = only(alertCards(first.channel));
    expect((old.view as TextView).text).toBe(T.herderHeldStale);
    expect((old.view as TextView).options).toBeUndefined();
    expect(first.channel.messages).toHaveLength(1);
    const cards = store.ownerCards().map((c) => c.view as TextView);
    expect(cards.map((c) => c.text)).toEqual([T.herderHeldStale]);
    expect(cards[0]?.options).toBeUndefined();
  });
});
