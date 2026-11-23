// The 信箱 page's words and filters (ADR 0099, 0100).

import { describe, expect, it } from "vitest";
import { sampleMailbox } from "../src/renderer/src/dev-fixtures.ts";
import {
  actChoice,
  actText,
  draftOf,
  draftProblem,
  editPatch,
  everyText,
  fateCounts,
  fateOf,
  filterLetters,
  sourceLine,
  sourceState,
  startsOver,
  suggestedName,
  whatText,
  whenProblem,
  whenText,
} from "../src/renderer/src/mailbox.ts";

describe("the 信箱 page (ADR 0099)", () => {
  const view = sampleMailbox(false);
  const [codex, simon, hn, prices] = view.sources as [
    (typeof view.sources)[0],
    (typeof view.sources)[0],
    (typeof view.sources)[0],
    (typeof view.sources)[0],
  ];

  it("says what each source looks at, how often, and whether it works", () => {
    expect(whatText(codex)).toBe("openai/codex 的新 issue、发布");
    expect(whatText(simon)).toBe("https://simonwillison.net/atom/everything/");
    expect(whatText(hn)).toBe("「agent memory」，50 分以上");
    expect(whatText(prices)).toBe("python3 ~/bin/flights.py");
    expect(sourceState(codex)).toEqual({ label: "正常", tone: "green" });
    expect(sourceState(hn)).toEqual({ label: "上次没取到", tone: "red" });
    expect(sourceState({ ...hn, fails: 3 })).toEqual({ label: "连着 3 次没取到", tone: "red" });
    expect(sourceState(prices)).toEqual({ label: "停着", tone: "gray" });
    expect(sourceState({ ...codex, started: false })).toEqual({
      label: "第一次还没看",
      tone: "amber",
    });
    expect(everyText(10)).toBe("每 10 分钟");
    expect(everyText(120)).toBe("每 2 小时");
    expect(everyText(1440)).toBe("每天");
    const now = new Date(codex.lastRunAt ?? "");
    expect(sourceLine(codex, now)).toMatch(
      /^每 10 分钟 · 上次 今天 \d\d:\d\d · 来了 4 封 · 主管加的$/,
    );
    expect(sourceLine({ ...prices, lastRunAt: undefined }, now)).toBe("每 2 小时 · 还没来过信");
  });

  it("shows what became of each letter and filters by it", () => {
    const fates = view.letters.map((l) => fateOf(l).label);
    expect(fates).toEqual([
      "告诉你了",
      "告诉你了",
      "等主管看",
      "留到汇总",
      "告诉你了",
      "留到汇总",
      "已汇总",
      "记下了",
      "记下了",
    ]);
    expect(fateCounts(view.letters)).toEqual({ all: 9, now: 3, digest: 3, noted: 2, waiting: 1 });
    expect(filterLetters(view.letters, "noted").map((l) => l.id)).toEqual([4, 3]);
    expect(filterLetters(view.letters, "all", "m-simon").map((l) => l.id)).toEqual([5, 3]);
    expect(filterLetters(view.letters, "waiting").map((l) => l.id)).toEqual([9]);
    const sent = view.letters[2];
    if (sent === undefined) throw new Error("no letter");
    expect(fateOf({ ...sent, sentAt: "2026-11-22T00:00:00Z" }).label).toBe("主管在看");
  });

  it("tells the owner what is missing before a source can be added", () => {
    expect(draftProblem({ kind: "github", name: "" }, view)).toBe("起个名字");
    expect(draftProblem({ kind: "github", name: "x", repo: "codex" }, view)).toMatch(/owner\/name/);
    expect(
      draftProblem({ kind: "github", name: "x", repo: "https://github.com/openai/codex" }, view),
    ).toBe(undefined);
    expect(draftProblem({ kind: "github", name: "x", repo: "a/b", what: [] }, view)).toMatch(
      /至少选一样/,
    );
    expect(draftProblem({ kind: "rss", name: "x", url: "feed" }, view)).toMatch(/地址/);
    expect(draftProblem({ kind: "hn", name: "x" }, view)).toBe("填要搜的词");
    expect(draftProblem({ kind: "script", name: "x" }, view)).toBe("填要运行的命令");
    expect(draftProblem({ kind: "timer", name: "x" }, view)).toBe("选好什么时候");
    expect(
      draftProblem({ kind: "timer", name: "x", when: { kind: "daily", at: "09:00" } }, view),
    ).toBe("写下到点要主管做什么");
    expect(draftProblem({ kind: "work", name: "x", what: [] }, view)).toMatch(/派给你的 issue/);
    expect(draftProblem({ kind: "mail", name: "x" }, view)).toMatch(/Gmail 的搜索条件/);
    expect(draftProblem({ kind: "social", name: "x" }, view)).toBe("选一个平台");
    expect(draftProblem({ kind: "work", name: "x", what: ["assigned"] }, view)).toBe(undefined);
    expect(draftProblem({ kind: "github", name: "x", repo: "a/b", everyMinutes: 2 }, view)).toBe(
      "GitHub 仓库最快每 5 分钟看一次",
    );
    expect(
      suggestedName({ kind: "github", name: "", repo: "https://github.com/openai/codex/" }),
    ).toBe("codex");
    expect(suggestedName({ kind: "rss", name: "", url: "https://www.example.com/feed" })).toBe(
      "example.com",
    );
    expect(suggestedName({ kind: "hn", name: "", words: " agent " })).toBe("HN：agent");
    expect(suggestedName({ kind: "work", name: "", what: ["reviews"] })).toBe("等我评审的 PR");
    expect(suggestedName({ kind: "work", name: "", what: ["assigned", "reviews"] })).toBe(
      "派给我的活",
    );
    expect(suggestedName({ kind: "social", name: "", platform: "xiaohongshu" })).toBe(
      "小红书的评论和@",
    );
  });

  it("shows GitHub work, mail, 小红书 and timers in the same list (ADR 0100)", () => {
    const work = view.sources.find((s) => s.kind === "work");
    const timer = view.sources.find((s) => s.kind === "timer");
    const social = view.sources.find((s) => s.kind === "social");
    if (work === undefined || timer === undefined || social === undefined) {
      throw new Error("sample sources missing");
    }
    expect(whatText(work)).toBe("vastsa/PI-Desktop 里派给你的 issue");
    expect(whatText(timer)).toBe("工作日 09:00");
    expect(whatText(social)).toBe("小红书的新评论和 @");
    expect(whatText({ ...work, kind: "mail", config: { query: "from:li@uni.edu" } })).toBe(
      "Gmail 搜「from:li@uni.edu」",
    );
    expect(sourceLine(timer, new Date(timer.lastRunAt ?? ""))).toMatch(
      /^下次：\d+月\d+日 \d\d:\d\d · 上次 今天 \d\d:\d\d · 主管加的$/,
    );
    expect(sourceLine({ ...timer, paused: true, nextAt: undefined })).toMatch(/^已暂停/);
    expect(actText(work)).toBe("每封都问你");
    expect(actText({ act: "trial", trials: 0 })).toBe("试跑中");
    expect(actText({ act: "trial", trials: 2 })).toBe("试跑中 · 已经 2 件");
    expect(actText({ act: "auto", trials: 3 })).toBe("直接开任务");
    expect(actText(timer)).toBe(undefined);
    expect(actChoice("trial")).toBe("auto");
    expect(actChoice("offer")).toBe("offer");
  });

  it("checks a timer's time before it can be added", () => {
    expect(whenProblem(undefined)).toBe("选好什么时候");
    expect(whenProblem({ kind: "every", hours: 0 })).toBe("每隔 1 到 168 小时");
    expect(whenProblem({ kind: "every", hours: 3 })).toBe(undefined);
    expect(whenProblem({ kind: "daily", at: "9:00" })).toBe("时间写成 09:00 这样");
    expect(whenProblem({ kind: "daily", at: "09:00", days: [] })).toBe("至少选一天");
    expect(whenProblem({ kind: "daily", at: "09:00", days: [1, 2] })).toBe(undefined);
    expect(whenProblem({ kind: "once", at: "2026-11-23" })).toMatch(/2026-11-23 09:00/);
    expect(whenProblem({ kind: "once", at: "2026-11-23 09:00" })).toBe(undefined);
  });

  it("writes times the way people say them", () => {
    const now = new Date(2026, 10, 22, 15, 0);
    expect(whenText(new Date(2026, 10, 22, 9, 5).toISOString(), now)).toBe("今天 09:05");
    expect(whenText(new Date(2026, 10, 21, 23, 0).toISOString(), now)).toBe("昨天 23:00");
    expect(whenText(new Date(2026, 10, 19, 21, 31).toISOString(), now)).toBe("11-19 21:31");
    expect(whenText(undefined, now)).toBe("");
  });
});

describe("changing a source (信箱)", () => {
  const view = sampleMailbox(false);
  const byId = (id: string) => {
    const s = view.sources.find((x) => x.id === id);
    if (s === undefined) throw new Error(`no ${id}`);
    return s;
  };

  it("fills the form with what the source has", () => {
    expect(draftOf(byId("m-codex"))).toEqual({
      kind: "github",
      name: "codex",
      note: "macOS 上崩溃、卡住的马上告诉我，新版本早上汇总",
      everyMinutes: 10,
      act: "sort",
      repo: "openai/codex",
      what: ["issues", "releases"],
    });
    const timer = draftOf(byId("m-morning"));
    expect(timer.when).toEqual({ kind: "daily", at: "09:00", days: [1, 2, 3, 4, 5] });
    expect(timer.everyMinutes).toBeUndefined();
    expect(draftOf(byId("m-xhs")).platform).toBe("xiaohongshu");
  });

  it("sends only what changed, and a new place to look starts over", () => {
    const codex = byId("m-codex");
    const form = draftOf(codex);
    expect(editPatch(codex, form)).toEqual({});
    const noted = editPatch(codex, { ...form, note: "只要崩溃的", everyMinutes: 30 });
    expect(noted).toEqual({ note: "只要崩溃的", everyMinutes: 30 });
    expect(startsOver(noted, "github")).toBe(false);
    const moved = editPatch(codex, { ...form, repo: "openai/codex-cli", words: "crash" });
    expect(moved.fields).toEqual({
      repo: "openai/codex-cli",
      what: ["issues", "releases"],
      words: "crash",
    });
    expect(startsOver(moved, "github")).toBe(true);
    const timer = byId("m-morning");
    const later = editPatch(timer, {
      ...draftOf(timer),
      when: { kind: "daily", at: "09:30", days: [1, 2, 3, 4, 5] },
    });
    expect(later.fields?.when).toEqual({ kind: "daily", at: "09:30", days: [1, 2, 3, 4, 5] });
    expect(startsOver(later, "timer")).toBe(false);
  });
});
