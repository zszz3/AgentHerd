// E2E for 小红书 / 知乎 notices (ADR 0058): nothing is looked at until a platform is ready and
// watches something; the first look only learns what is there; new comments and @ are told one
// per line, likes counted; lists are opened only when something is unread; kinds turned off are
// not told; the Herder hears what the owner was told.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeChannel } from "@agentherd/channel-fake";
import type { TextView } from "@agentherd/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/clock.ts";
import { Herd } from "../../src/herd.ts";
import type { HerderEvent, HerderHost } from "../../src/herder-port.ts";
import type { SocialKind, SocialNotice, SocialSource } from "../../src/social-watch.ts";
import { Store } from "../../src/store.ts";

const dir = mkdtempSync(join(tmpdir(), "agentherd-social-"));
let herds: Herd[] = [];

afterEach(async () => {
  await Promise.all(herds.map((h) => h.stop()));
  herds = [];
});

class FakePlatform implements SocialSource {
  platform = "xiaohongshu" as const;
  name = "小红书";
  on = true;
  notices_: SocialNotice[] = [];
  unreadIds = new Set<string>();
  opened: SocialKind[] = [];
  looks = 0;

  ready(): boolean {
    return this.on;
  }

  receive(notice: SocialNotice): void {
    this.notices_.unshift(notice);
    this.unreadIds.add(notice.id);
  }

  async unread(): Promise<Partial<Record<SocialKind, number>>> {
    this.looks++;
    const counts: Partial<Record<SocialKind, number>> = {};
    for (const n of this.notices_) {
      if (this.unreadIds.has(n.id)) counts[n.kind] = (counts[n.kind] ?? 0) + 1;
    }
    return counts;
  }

  async notices(kind: SocialKind): Promise<SocialNotice[]> {
    this.opened.push(kind);
    const list = this.notices_.filter((n) => n.kind === kind);
    for (const n of list) this.unreadIds.delete(n.id);
    return list;
  }
}

async function setup() {
  const channel = new FakeChannel("owner");
  const clock = new FakeClock("2026-11-04T00:00:00.000Z");
  const store = Store.open(":memory:");
  const platform = new FakePlatform();
  let host: HerderHost | undefined;
  const events: HerderEvent[] = [];
  const herd = new Herd({
    home: dir,
    userHome: "/Users/me",
    channel,
    binding: { channelId: "fake", ownerId: "owner", data: {} },
    mode: "assist",
    locale: "en",
    profiles: [],
    store,
    clock,
    boardDebounceMs: 10,
    socials: () => [platform],
    herder: (h) => {
      host = h;
      return {
        ownerMessage() {},
        ownerAnswer() {},
        event: (e) => events.push(e),
        stop: async () => {},
      };
    },
  });
  herds.push(herd);
  await herd.start();
  if (host === undefined) throw new Error("no herder host");
  return { herd, channel, clock, store, platform, host, events };
}

const texts = (channel: FakeChannel) =>
  channel.messages.filter((m) => m.view.kind === "text").map((m) => (m.view as TextView).text);

describe("E2E-SOCIAL", () => {
  it("learns what is there first, then tells new comments once", async () => {
    const { herd, channel, platform, host, events } = await setup();
    platform.receive({ id: "old", kind: "mentions", who: "A", text: "old comment", on: "Post" });

    await herd.pollSocials();
    expect(platform.opened).toEqual(["mentions"]);
    expect(texts(channel)).toEqual([]);

    // Nothing unread: the list is not opened again.
    await herd.pollSocials();
    expect(platform.opened).toEqual(["mentions"]);

    platform.receive({
      id: "c1",
      kind: "mentions",
      who: "小羊",
      text: "怎么装？",
      on: "AgentHerd 上手",
    });
    platform.receive({ id: "l1", kind: "likes", who: "B", text: "" });
    await herd.pollSocials();
    expect(texts(channel)).toEqual(['New on 小红书:\n- 小羊 on "AgentHerd 上手": 怎么装？']);
    expect(events).toMatchObject([{ kind: "social", title: "小红书" }]);
    expect(events[0]?.text).toContain("[id c1]");

    // Told once.
    await herd.pollSocials();
    expect(texts(channel)).toHaveLength(1);

    // Likes turned on: the first look learns them, the next new one is counted.
    host.setSocialWatch?.("xiaohongshu", "likes", true);
    await herd.pollSocials();
    expect(texts(channel)).toHaveLength(1);
    platform.receive({ id: "l2", kind: "likes", who: "C", text: "" });
    platform.receive({ id: "l3", kind: "likes", who: "D", text: "" });
    await herd.pollSocials();
    expect(texts(channel).at(-1)).toBe("New on 小红书:\n- 2 new likes and saves");
    expect(host.socialWatches?.()).toEqual([
      {
        platform: "xiaohongshu",
        name: "小红书",
        ready: true,
        watch: { mentions: true, likes: true, follows: false },
      },
    ]);
  });

  it("looks rarely, and not at all while the platform is off", async () => {
    const { clock, platform } = await setup();
    // 20 minutes give or take 5: nothing in the first 14.
    await clock.advance(14 * 60_000);
    expect(platform.looks).toBe(0);
    await clock.advance(12 * 60_000);
    expect(platform.looks).toBe(1);

    platform.on = false;
    await clock.advance(120 * 60_000);
    expect(platform.looks).toBe(1);
  });
});
