// E2E for following the pull requests tasks open (docs/spec/04-herder.md "Pull requests"): people's comments
// wake the task, bots do not, failed checks go to the task, a merge is noted once and the watch
// stays for later comments (ADR 0051). What the task handled on its own, approvals and merges go
// on the task board, not to the phone, unless the owner asked otherwise (ADR 0061).

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeChannel } from "@agentherd/channel-fake";
import type { AgentProfile, TextView } from "@agentherd/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/clock.ts";
import type { GhRun } from "../../src/github-watch.ts";
import { Herd } from "../../src/herd.ts";
import { setNoticeLevel } from "../../src/notices.ts";
import { Store } from "../../src/store.ts";

const BIN = fileURLToPath(new URL("../../../mock-agent/bin/mock-agent.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "agentherd-github-"));
let herds: Herd[] = [];

afterEach(async () => {
  await Promise.all(herds.map((h) => h.stop()));
  herds = [];
});

const SCRIPT = `
turns:
  - - message: "Opened https://github.com/acme/app/pull/7 and see https://github.com/acme/app/pull/3"
    - end_turn: end_turn
  - - message: "Renamed it."
    - end_turn: end_turn
  - - message: "Fixed the build."
    - end_turn: end_turn
  - - message: "Answered on the merged PR."
    - end_turn: end_turn
`;

function profile(script: string): AgentProfile {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(file, script);
  return {
    id: "mock",
    name: "Mock",
    command: [process.execPath, BIN, "--script", file],
    env: {},
    exporter: null,
  };
}

interface FakeComment {
  id: number;
  user: { login: string; type: string };
  body: string;
}

/** A GitHub with pull requests acme/app#7 (ours) and #3 (someone else's), read through `gh`. */
class FakeGitHub {
  state = "OPEN";
  checks: { name: string; status: string; conclusion: string }[] = [];
  comments: FakeComment[] = [
    { id: 1, user: { login: "ci-bot[bot]", type: "Bot" }, body: "Preview ready" },
  ];
  reviews: (FakeComment & { state: string })[] = [];
  calls: string[][] = [];
  private nextId = 10;

  comment(login: string, body: string, type = "User"): void {
    this.comments.push({ id: this.nextId++, user: { login, type }, body });
  }

  review(login: string, state: string, body: string): void {
    this.reviews.push({ id: this.nextId++, user: { login, type: "User" }, state, body });
  }

  run: GhRun = async (args) => {
    this.calls.push(args);
    const [cmd, sub] = args;
    if (cmd === "api" && sub === "user") return "me\n";
    if (cmd === "pr" && sub === "view") {
      const mine = args[2] === "7";
      return JSON.stringify({
        state: this.state,
        author: { login: mine ? "me" : "someone" },
        createdAt: "2100-01-01T00:00:00Z",
        headRefOid: `sha${this.checks.length}`,
        statusCheckRollup: this.checks,
      });
    }
    if (cmd === "api" && sub?.includes("/issues/")) return JSON.stringify(this.comments);
    if (cmd === "api" && sub?.includes("/reviews")) return JSON.stringify(this.reviews);
    if (cmd === "api" && sub?.includes("/pulls/")) return "[]";
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
}

async function setup(script = SCRIPT) {
  const channel = new FakeChannel("owner");
  const clock = new FakeClock();
  const store = Store.open(":memory:");
  const github = new FakeGitHub();
  const herd = new Herd({
    home: dir,
    userHome: "/Users/me",
    channel,
    binding: { channelId: "fake", ownerId: "owner", data: {} },
    mode: "assist",
    locale: "en",
    profiles: [profile(script)],
    store,
    clock,
    boardDebounceMs: 10,
    github: { run: github.run, pollMinutes: 2 },
  });
  herds.push(herd);
  await herd.start();
  return { herd, channel, clock, store, github };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
}

const texts = (channel: FakeChannel) =>
  channel.messages.filter((m) => m.view.kind === "text").map((m) => (m.view as TextView).text);
const reports = (channel: FakeChannel) => channel.messages.filter((m) => m.view.kind === "report");
/** What the task's row on the board says (ADR 0061: small news goes there, not to the phone). */
const boardReport = (herd: Herd, taskId: string) =>
  herd.tasks().find((t) => t.id === taskId)?.lastReport;
const noticed = (store: Store, kind: string) =>
  store.auditRows("notice").filter((r) => r.data.kind === kind);

describe("E2E-GITHUB", () => {
  it("follows the pull request a task opened until it merges", async () => {
    const { herd, channel, clock, store, github } = await setup();
    const { taskId, turn } = await herd.startTask("mock", dir, "Fix the bug and open a PR");
    await turn;
    // Only the pull request the task opened is followed, not one it mentioned.
    await until(() => store.prWatches().length > 0);
    await until(() => github.calls.some((c) => c[2] === "3"));
    expect(store.prWatches().map((w) => [w.url, w.taskId])).toEqual([
      ["https://github.com/acme/app/pull/7", taskId],
    ]);
    expect(reports(channel)).toHaveLength(1);
    // What was there before is not news.
    await clock.advance(120_000);
    expect(texts(channel).filter((t) => t.includes("PR #7"))).toEqual([]);

    // A person's comment wakes the task; a bot's does not. The task handled it on its own, so
    // its result goes on the board and the phone stays quiet (ADR 0061).
    github.comment("alice", "Please rename foo to bar.\nIt reads better.");
    github.comment("lint-bot[bot]", "Style nits", "Bot");
    await clock.advance(120_000);
    await until(() => boardReport(herd, taskId) === "Renamed it.");
    expect(boardReport(herd, taskId)).toBe("Renamed it.");
    expect(reports(channel)).toHaveLength(1);
    expect(store.auditRows("report.unpushed")).toHaveLength(1);
    expect(texts(channel).filter((t) => t.startsWith("New comment"))).toEqual([]);
    const prompts = store.transcript(taskId).filter((e) => e.role === "prompt");
    expect(prompts[1]?.text).toContain("alice commented: Please rename foo to bar.");
    expect(prompts[1]?.text).not.toContain("Style nits");

    // A bare approval is not worked on, and goes on the board.
    github.review("bob", "APPROVED", "");
    await clock.advance(120_000);
    await until(() => boardReport(herd, taskId) === "PR #7 was approved by bob.");
    expect(boardReport(herd, taskId)).toBe("PR #7 was approved by bob.");
    expect(texts(channel)).not.toContain("PR #7 was approved by bob.");
    expect(noticed(store, "pr-approved")).toMatchObject([{ data: { level: "board", taskId } }]);

    // Failed checks go to the task once per head commit; no separate notice says the same.
    github.checks = [{ name: "build", status: "COMPLETED", conclusion: "FAILURE" }];
    await clock.advance(120_000);
    await until(() => boardReport(herd, taskId) === "Fixed the build.");
    expect(boardReport(herd, taskId)).toBe("Fixed the build.");
    const third = store.transcript(taskId).filter((e) => e.role === "prompt");
    expect(third.at(-1)?.text).toContain("Checks failed: build.");
    await clock.advance(120_000);
    expect(store.transcript(taskId).filter((e) => e.role === "prompt")).toHaveLength(3);
    expect(texts(channel).filter((t) => t.startsWith("Checks failed"))).toEqual([]);

    // The merge is noted once; the watch stays, so a later comment still reaches the task
    // (ADR 0051).
    github.state = "MERGED";
    await clock.advance(120_000);
    await until(() => boardReport(herd, taskId) === "PR #7 was merged.");
    expect(boardReport(herd, taskId)).toBe("PR #7 was merged.");
    await clock.advance(120_000);
    expect(noticed(store, "pr-merged")).toHaveLength(1);
    expect(texts(channel)).not.toContain("PR #7 was merged.");
    expect(store.prWatches()).toMatchObject([{ number: 7, closed: "merged" }]);
    await herd.endTask(taskId, "done");
    github.comment("carol", "Why was foo renamed?");
    await clock.advance(120_000);
    // The ended task opens again with a new agent (the mock starts its script over); its
    // result goes on the board too.
    await until(() => store.auditRows("report.unpushed").length === 3);
    expect(store.auditRows("report.unpushed")).toHaveLength(3);
    expect(boardReport(herd, taskId)).toMatch(/^Opened https:\/\/github\.com\/acme\/app\/pull\/7/);
    const after = store.transcript(taskId).filter((e) => e.role === "prompt");
    expect(after.at(-1)?.text).toContain("carol commented: Why was foo renamed?");
    expect(after.at(-1)?.text).toContain("already merged");
    // Everything after the first report went to the board: one message on the phone in all.
    expect(reports(channel)).toHaveLength(1);
    expect(texts(channel)).toEqual([]);

    // Fourteen quiet days after that, the watch ends.
    await clock.advance(15 * 24 * 60 * 60_000);
    await until(() => store.prWatches().length === 0);
    expect(store.auditRows("github.expired")).toHaveLength(1);
  }, 20_000);

  it("pushes what the owner asked to have pushed (ADR 0061)", async () => {
    const { herd, channel, clock, store, github } = await setup();
    setNoticeLevel(store, "pr-follow-up", "push");
    setNoticeLevel(store, "pr-approved", "push");
    setNoticeLevel(store, "pr-merged", "off");
    const { taskId, turn } = await herd.startTask("mock", dir, "Fix the bug and open a PR");
    await turn;
    await until(() => store.prWatches().length > 0);
    await clock.advance(120_000);

    github.comment("alice", "Please rename foo to bar.");
    await clock.advance(120_000);
    await until(() => reports(channel).length === 2);
    expect(reports(channel)).toHaveLength(2);
    expect(store.auditRows("report.unpushed")).toEqual([]);

    github.review("bob", "APPROVED", "");
    await clock.advance(120_000);
    await until(() => texts(channel).includes("PR #7 was approved by bob."));
    expect(texts(channel)).toContain("PR #7 was approved by bob.");

    // Off: neither the phone nor the board, only the audit log.
    github.state = "MERGED";
    await clock.advance(120_000);
    await until(() => noticed(store, "pr-merged").length === 1);
    expect(noticed(store, "pr-merged")).toMatchObject([{ data: { level: "off" } }]);
    expect(texts(channel)).not.toContain("PR #7 was merged.");
    expect(boardReport(herd, taskId)).not.toBe("PR #7 was merged.");
  }, 20_000);

  it("waits for the owner after three wake-ups in a row (ADR 0062)", async () => {
    const rounds = [1, 2, 3, 4, 5]
      .map((n) => `  - - message: "Round ${n}."\n    - end_turn: end_turn\n`)
      .join("");
    const script = `turns:\n  - - message: "Opened https://github.com/acme/app/pull/7"\n    - end_turn: end_turn\n${rounds}`;
    const { herd, channel, clock, store, github } = await setup(script);
    const { taskId, turn } = await herd.startTask("mock", dir, "Fix the bug and open a PR");
    await turn;
    await until(() => store.prWatches().length > 0);
    await clock.advance(120_000);
    const prompts = () => store.transcript(taskId).filter((e) => e.role === "prompt");

    // Three comments in a row: the task handles each one by itself.
    for (const n of [1, 2, 3]) {
      github.comment("alice", `Comment ${n}`);
      await clock.advance(120_000);
      await until(() => boardReport(herd, taskId) === `Round ${n}.`);
      expect(boardReport(herd, taskId)).toBe(`Round ${n}.`);
    }
    expect(store.prWatches()[0]?.wakesInRow).toBe(3);

    // The fourth is not handed to it: the owner is asked once.
    github.comment("alice", "Comment 4");
    await clock.advance(120_000);
    const asked =
      "More on PR #7 (alice wrote: Comment 4).\nThe task already handled this PR 3 times in a row on its own, so it was not woken this time. Reply to this message to have it go on; it gets this news with your reply.";
    await until(() => texts(channel).includes(asked));
    expect(texts(channel)).toEqual([asked]);
    expect(prompts()).toHaveLength(4);

    // More news while it waits only changes the board.
    github.comment("bob", "Comment 5");
    await clock.advance(120_000);
    await until(() => boardReport(herd, taskId) === "More news on PR #7, waiting for your reply");
    expect(boardReport(herd, taskId)).toBe("More news on PR #7, waiting for your reply");
    expect(texts(channel)).toEqual([asked]);
    expect(store.prWatches()[0]?.held).toHaveLength(2);

    // The owner's reply goes to the task with everything held back, and the count starts over.
    const message = channel.ofKind("text").find((m) => (m.view as TextView).text === asked);
    if (message?.ref === undefined) throw new Error("no message to reply to");
    void channel.reply(message.ref, "Go on.");
    await until(() => boardReport(herd, taskId) === "Round 4.");
    const fifth = prompts()[4]?.text ?? "";
    expect(fifth).toMatch(/^Go on\.\n\n\(AgentHerd\) Also new on the pull request you follow/);
    expect(fifth).toContain("alice commented: Comment 4");
    expect(fifth).toContain("bob commented: Comment 5");
    expect(store.prWatches()[0]?.wakesInRow).toBe(0);
    expect(store.prWatches()[0]?.held).toBeUndefined();

    // So the next comment wakes the task again.
    github.comment("carol", "Comment 6");
    await clock.advance(120_000);
    await until(() => boardReport(herd, taskId) === "Round 5.");
    expect(boardReport(herd, taskId)).toBe("Round 5.");
    expect(prompts().at(-1)?.text).toContain("carol commented: Comment 6");
    expect(store.prWatches()[0]?.wakesInRow).toBe(1);
  }, 20_000);

  it("follows a pull request the owner hands to a task, whoever opened it", async () => {
    const { herd, channel, clock, store, github } = await setup();
    const { taskId, turn } = await herd.startTask(
      "mock",
      dir,
      "Follow up on https://github.com/acme/app/pull/3 please",
    );
    await turn;
    await until(() => store.prWatches().length > 0);
    // #3 is someone else's: followed only because the owner handed it over.
    expect(store.prWatches().find((w) => w.number === 3)).toMatchObject({ taskId, handed: true });
    github.comment("dave", "Can you also update the docs?");
    await clock.advance(120_000);
    const handed = () =>
      store
        .transcript(taskId)
        .filter((e) => e.role === "prompt")
        .find((e) => e.text.includes("pull/3") && e.text.startsWith("(AgentHerd)"));
    await until(() => handed() !== undefined);
    expect(handed()?.text).toContain("the pull request the owner asked you to follow");
    expect(handed()?.text).toContain("dave commented: Can you also update the docs?");
    expect(texts(channel)).toEqual([]);
  }, 20_000);

  it("keeps quiet without gh", async () => {
    const { herd, store, clock } = await setup();
    const failing = new Herd({
      home: dir,
      userHome: "/Users/me",
      channel: new FakeChannel("owner"),
      binding: { channelId: "fake", ownerId: "owner", data: {} },
      mode: "assist",
      locale: "en",
      profiles: [profile(SCRIPT)],
      store,
      clock,
      github: {
        run: async () => {
          throw new Error("gh: command not found");
        },
      },
    });
    herds.push(failing);
    await failing.start();
    const { turn } = await failing.startTask("mock", dir, "Open a PR");
    await turn;
    await until(() => store.auditRows("github.error").length > 0);
    expect(store.prWatches()).toEqual([]);
    expect(herd).toBeDefined();
  });
});
