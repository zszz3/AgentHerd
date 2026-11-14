// Notice levels (ADR 0061): which small news rings the owner's phone and which only goes on the
// task board; the owner changes them through the Herder.

import { describe, expect, it } from "vitest";
import {
  changedNoticeLevels,
  DEFAULT_NOTICE_LEVELS,
  NOTICE_KINDS,
  noticeLevel,
  noticeLevels,
  setNoticeLevel,
} from "../src/notices.ts";
import { Store } from "../src/store.ts";
import { promptWords } from "../src/task-runner.ts";

describe("notice levels (ADR 0061)", () => {
  it("every kind goes on the board until the owner says otherwise", () => {
    const store = Store.open(":memory:");
    expect(noticeLevels(store)).toEqual(DEFAULT_NOTICE_LEVELS);
    for (const kind of NOTICE_KINDS) expect(noticeLevel(store, kind)).toBe("board");
    expect(changedNoticeLevels(store)).toEqual([]);
  });

  it("keeps the owner's choice, and forgets it when it goes back to the default", () => {
    const store = Store.open(":memory:");
    setNoticeLevel(store, "pr-merged", "push");
    setNoticeLevel(store, "task-ack", "off");
    expect(noticeLevel(store, "pr-merged")).toBe("push");
    expect(changedNoticeLevels(store)).toEqual([
      { kind: "pr-merged", level: "push" },
      { kind: "task-ack", level: "off" },
    ]);
    setNoticeLevel(store, "pr-merged", "board");
    expect(changedNoticeLevels(store)).toEqual([{ kind: "task-ack", level: "off" }]);
    expect(store.getState("notice.levels")).toEqual({ "task-ack": "off" });
    expect(store.auditRows("notice.level")).toHaveLength(3);
  });

  it("refuses kinds and levels it does not know", () => {
    const store = Store.open(":memory:");
    expect(() => setNoticeLevel(store, "task-result", "board")).toThrow(
      /unknown notice kind "task-result"; known: pr-approved/,
    );
    expect(() => setNoticeLevel(store, "pr-merged", "loud")).toThrow(
      'unknown level "loud"; known: push, board, off',
    );
    // A broken saved value is ignored, not trusted.
    store.setState("notice.levels", { "pr-merged": "loud", nope: "push" });
    expect(noticeLevels(store)).toEqual(DEFAULT_NOTICE_LEVELS);
  });
});

describe("promptWords", () => {
  it("keeps the words of a Herder's prompt, without its labels and added context", () => {
    expect(
      promptWords(
        "[Message from the Herder, not from the owner]\nAlso update the docs\n\n[Context added by the Herder, for reference]\nThe docs live in docs/.",
      ),
    ).toBe("Also update the docs");
    expect(promptWords("[Owner's message]\n把测试修好\n第二行")).toBe("把测试修好\n第二行");
    expect(promptWords("  plain words  ")).toBe("plain words");
  });
});
