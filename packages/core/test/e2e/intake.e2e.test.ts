// E2E for new-work watches (docs/spec/04-herder.md "New work", ADR 0052): nothing is searched
// until the owner asks; what is already there is not offered; a new item is offered once with
// 「开任务 / 忽略」, and only 「开任务」 reaches the Herder; an automatic watch first runs on a trial
// (ADR 0064), then starts by itself.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeChannel } from "@agentherd/channel-fake";
import type { AskView, TextView } from "@agentherd/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/clock.ts";
import { Herd } from "../../src/herd.ts";
import type { HerderEvent, HerderHost } from "../../src/herder-port.ts";
import { searchArgs } from "../../src/intake.ts";
import { Store } from "../../src/store.ts";

const dir = mkdtempSync(join(tmpdir(), "agentherd-intake-"));
let herds: Herd[] = [];

afterEach(async () => {
  await Promise.all(herds.map((h) => h.stop()));
  herds = [];
});

interface Found {
  number: number;
  title: string;
  url: string;
  repository: { nameWithOwner: string };
}

/** `gh search issues|prs` answering like the real one. */
class FakeGh {
  issues: Found[] = [];
  reviews: Found[] = [];
  calls: string[][] = [];
  fail: string | undefined;

  add(kind: "issues" | "reviews", repo: string, number: number, title: string): void {
    const path = kind === "issues" ? "issues" : "pull";
    this[kind].push({
      number,
      title,
      url: `https://github.com/${repo}/${path}/${number}`,
      repository: { nameWithOwner: repo },
    });
  }

  run = async (args: string[]): Promise<string> => {
    this.calls.push(args);
    if (this.fail !== undefined) throw new Error(this.fail);
    if (args[0] === "repo") return JSON.stringify({ nameWithOwner: `me/${args[2]}` });
    const list = args[1] === "issues" ? this.issues : this.reviews;
    const repo = args[args.indexOf("--repo") + 1];
    return JSON.stringify(
      args.includes("--repo") ? list.filter((i) => i.repository.nameWithOwner === repo) : list,
    );
  };
}

async function setup() {
  const channel = new FakeChannel("owner");
  const clock = new FakeClock("2026-11-04T00:00:00.000Z");
  const store = Store.open(":memory:");
  const gh = new FakeGh();
  let host: HerderHost | undefined;
  const events: HerderEvent[] = [];
  const intakes: { text: string; auto: boolean; trial?: boolean }[] = [];
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
    github: { run: gh.run, pollMinutes: 60 },
    intakePollMinutes: 5,
    herder: (h) => {
      host = h;
      return {
        ownerMessage() {},
        ownerAnswer() {},
        intake: (text, auto, trial) =>
          intakes.push({ text, auto, ...(trial === true ? { trial } : {}) }),
        event: (e) => events.push(e),
        stop: async () => {},
      };
    },
  });
  herds.push(herd);
  await herd.start();
  if (host === undefined) throw new Error("no herder host");
  return { herd, channel, clock, gh, host, events, intakes };
}

const searches = (gh: FakeGh) => gh.calls.filter((c) => c[0] === "search");
const asks = (channel: FakeChannel) => channel.messages.filter((m) => m.view.kind === "ask");
const texts = (channel: FakeChannel) =>
  channel.messages.filter((m) => m.view.kind === "text").map((m) => (m.view as TextView).text);

function offerAt(channel: FakeChannel): AskView {
  const view = asks(channel)[0]?.view;
  if (view?.kind !== "ask") throw new Error("no offer");
  return view;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
}

describe("E2E-INTAKE", () => {
  it("searches only after the owner asks, and offers a new item once", async () => {
    const { herd, channel, clock, gh, host, events, intakes } = await setup();
    gh.add("issues", "acme/app", 1, "Old bug");

    await clock.advance(30 * 60_000);
    expect(searches(gh)).toEqual([]);

    const watch = await host.watchIntake?.({ kind: "issues", repo: "acme/app" });
    expect(watch?.auto).toBe(false);
    expect(searches(gh)[0]).toEqual(searchArgs({ kind: "issues", repo: "acme/app" }));
    expect(searches(gh)[0]).toContain("--assignee=@me");

    // What was there before the watch is not news; a new one is offered once.
    gh.add("issues", "acme/app", 7, "Login fails on Safari");
    await clock.advance(5 * 60_000);
    await until(() => asks(channel).length > 0);
    await clock.advance(5 * 60_000);
    await herd.pollIntake();
    expect(asks(channel)).toHaveLength(1);
    const offer = offerAt(channel);
    expect(offer.text).toContain("acme/app #7 Login fails on Safari");
    expect(offer.text).toContain("https://github.com/acme/app/issues/7");
    expect(offer.options.map((o) => o.label)).toEqual(["Start a task", "Ignore"]);
    expect(events.map((e) => e.kind)).toEqual(["intake"]);
    expect(intakes).toEqual([]);

    // 「开任务」 reaches the Herder with the item; the card loses its buttons.
    await channel.tap(offer.askId, "start");
    await until(() => intakes.length > 0);
    expect(intakes).toEqual([
      {
        text: "issue acme/app#7: Login fails on Safari https://github.com/acme/app/issues/7",
        auto: false,
      },
    ]);
    expect(offerAt(channel).final).toBe("Start a task");
    // A second tap does nothing.
    await channel.tap(offer.askId, "start");
    expect(intakes).toHaveLength(1);
  });

  it("「忽略」 starts nothing, and an automatic watch runs on a trial before it starts by itself", async () => {
    const { herd, channel, gh, host, intakes } = await setup();
    await host.watchIntake?.({ kind: "reviews" });
    gh.add("reviews", "acme/api", 3, "Add rate limits");
    await herd.pollIntake();
    const offer = offerAt(channel);
    expect(offer.text).toContain("waits for your review");
    await channel.tap(offer.askId, "ignore");
    await until(() => offerAt(channel).final !== undefined);
    expect(offerAt(channel).final).toBe("Ignore");
    expect(intakes).toEqual([]);

    // A bare repository name is the owner's own repository.
    const own = await host.watchIntake?.({ kind: "issues", repo: "app" });
    expect(own?.repo).toBe("me/app");
    expect(searches(gh).at(-1)).toEqual(searchArgs({ kind: "issues", repo: "me/app" }));
    host.unwatchIntake?.(own?.id ?? "");

    // Asking again for the same watch with auto makes it automatic, on a trial run first
    // (ADR 0064): the owner still gets the offer, and the Herder only says what it would do.
    const changed = await host.watchIntake?.({ kind: "reviews", auto: true });
    expect(changed?.auto).toBe(true);
    expect(changed?.trial).toBe(true);
    expect(host.intakeWatches?.()).toHaveLength(1);
    gh.add("reviews", "acme/api", 4, "Fix typo");
    await herd.pollIntake();
    expect(asks(channel)).toHaveLength(2);
    const trial = asks(channel)[1]?.view as AskView;
    expect(trial.text).toContain("acme/api #4 Fix typo");
    expect(trial.text).toContain("Trial run, item 1:");
    expect(trial.options.map((o) => o.label)).toEqual(["Start a task", "Ignore"]);
    expect(texts(channel)).toEqual([]);
    expect(intakes).toEqual([
      {
        text: "pull request to review acme/api#4: Fix typo https://github.com/acme/api/pull/4",
        auto: true,
        trial: true,
      },
    ]);
    expect(host.intakeWatches?.()[0]?.trials).toBe(1);

    // The owner lets it start work: the next item starts by itself.
    const released = await host.watchIntake?.({ kind: "reviews", trial: false });
    expect(released?.auto).toBe(true);
    expect(released?.trial).toBeUndefined();
    gh.add("reviews", "acme/api", 5, "Bump deps");
    await herd.pollIntake();
    expect(asks(channel)).toHaveLength(2);
    expect(texts(channel)).toEqual(["Started by your rule: review of acme/api #5 Bump deps"]);
    expect(intakes.at(-1)).toEqual({
      text: "pull request to review acme/api#5: Bump deps https://github.com/acme/api/pull/5",
      auto: true,
    });

    // Turning auto off and on again starts a new trial run.
    await host.watchIntake?.({ kind: "reviews", auto: false });
    const again = await host.watchIntake?.({ kind: "reviews", auto: true });
    expect(again?.trial).toBe(true);
  });

  it("a new automatic watch the owner said needs no trial starts by itself", async () => {
    const { herd, channel, gh, host, intakes } = await setup();
    const watch = await host.watchIntake?.({ kind: "issues", auto: true, trial: false });
    expect(watch?.trial).toBeUndefined();
    gh.add("issues", "acme/app", 9, "Crash on start");
    await herd.pollIntake();
    expect(asks(channel)).toEqual([]);
    expect(texts(channel)).toEqual(["Started by your rule: issue acme/app #9 Crash on start"]);
    expect(intakes).toEqual([
      {
        text: "issue acme/app#9: Crash on start https://github.com/acme/app/issues/9",
        auto: true,
      },
    ]);
  });

  it("refuses a watch gh cannot run, and stops searching when the last watch goes", async () => {
    const { clock, gh, host } = await setup();
    gh.fail = "gh: To get started with GitHub CLI, please run:  gh auth login";
    await expect(host.watchIntake?.({ kind: "issues" })).rejects.toThrow(/gh auth login/);
    expect(host.intakeWatches?.()).toEqual([]);

    gh.fail = undefined;
    const watch = await host.watchIntake?.({ kind: "issues" });
    expect(host.unwatchIntake?.(watch?.id ?? "")).toBe(true);
    const before = searches(gh).length;
    await clock.advance(30 * 60_000);
    expect(searches(gh)).toHaveLength(before);
  });
});
