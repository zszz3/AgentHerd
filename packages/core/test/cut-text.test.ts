import { describe, expect, it } from "vitest";
import { headTail } from "../src/cut-text.ts";

describe("headTail (ADR 0062)", () => {
  it("leaves a short text as it is", () => {
    expect(headTail("short", 100)).toBe("short");
    expect(headTail("x".repeat(100), 100)).toBe("x".repeat(100));
  });

  it("keeps the start and the end of a long text and says how much is left out", () => {
    const text = `${"a".repeat(500)}${"m".repeat(1000)}${"z".repeat(500)}`;
    const cut = headTail(text, 300, "task_read gives the whole reply");
    // 200 characters kept: 120 from the start and 80 from the end.
    expect(cut).toBe(
      `${"a".repeat(120)}\n[… 1800 characters left out; task_read gives the whole reply …]\n${"z".repeat(80)}`,
    );
    expect(cut.length).toBeLessThanOrEqual(300);
  });

  it("works without saying where the whole is", () => {
    expect(headTail("abcdefghij".repeat(30), 110)).toBe(
      "abcdef\n[… 290 characters left out …]\nghij",
    );
  });
});
