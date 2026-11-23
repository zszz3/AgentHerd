import type { PermissionOption } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { ToolCallTracker, toAcpOutcome, toToolCallInfo } from "../src/mapping.ts";

const ALLOW_ONCE: PermissionOption = { optionId: "allow", name: "Allow", kind: "allow_once" };
const ALLOW_ALWAYS: PermissionOption = {
  optionId: "always",
  name: "Always allow",
  kind: "allow_always",
};
const REJECT_ONCE: PermissionOption = { optionId: "reject", name: "Reject", kind: "reject_once" };
const REJECT_ALWAYS: PermissionOption = {
  optionId: "reject-always",
  name: "Reject always",
  kind: "reject_always",
};

describe("toAcpOutcome", () => {
  it("allow picks the allow_once option", () => {
    expect(toAcpOutcome({ kind: "allow" }, [ALLOW_ONCE, ALLOW_ALWAYS])).toEqual({
      outcome: "selected",
      optionId: "allow",
    });
  });

  it("allow never picks allow_always, even when listed first", () => {
    expect(toAcpOutcome({ kind: "allow" }, [ALLOW_ALWAYS, ALLOW_ONCE])).toEqual({
      outcome: "selected",
      optionId: "allow",
    });
  });

  it("allow with only an allow_always option is cancelled", () => {
    expect(toAcpOutcome({ kind: "allow" }, [ALLOW_ALWAYS])).toEqual({ outcome: "cancelled" });
  });

  it("deny picks reject_once over reject_always", () => {
    expect(toAcpOutcome({ kind: "deny" }, [REJECT_ONCE, REJECT_ALWAYS])).toEqual({
      outcome: "selected",
      optionId: "reject",
    });
  });

  it("deny falls back to reject_always", () => {
    expect(toAcpOutcome({ kind: "deny" }, [REJECT_ALWAYS])).toEqual({
      outcome: "selected",
      optionId: "reject-always",
    });
  });

  it("deny with no reject option is cancelled", () => {
    expect(toAcpOutcome({ kind: "deny" }, [ALLOW_ONCE])).toEqual({ outcome: "cancelled" });
  });

  it("cancelled stays cancelled", () => {
    expect(toAcpOutcome({ kind: "cancelled" }, [ALLOW_ONCE, REJECT_ONCE])).toEqual({
      outcome: "cancelled",
    });
  });
});

describe("toToolCallInfo", () => {
  it("defaults kind to other, title to toolCallId and paths to empty", () => {
    expect(toToolCallInfo({ toolCallId: "abc" })).toEqual({
      kind: "other",
      title: "abc",
      paths: [],
    });
  });

  it("copies an explicit kind and title", () => {
    expect(toToolCallInfo({ toolCallId: "abc", kind: "execute", title: "Run" })).toEqual({
      kind: "execute",
      title: "Run",
      paths: [],
    });
  });

  it("maps locations to paths", () => {
    expect(
      toToolCallInfo({
        toolCallId: "abc",
        locations: [{ path: "/a.ts", line: 1 }, { path: "/b.ts" }],
      }),
    ).toEqual({ kind: "other", title: "abc", paths: ["/a.ts", "/b.ts"] });
  });

  it("takes the command from a string", () => {
    expect(toToolCallInfo({ toolCallId: "abc", rawInput: { command: "ls -la" } })).toMatchObject({
      command: "ls -la",
    });
  });

  it("joins a string array command with spaces", () => {
    expect(
      toToolCallInfo({ toolCallId: "abc", rawInput: { command: ["ls", "-la", "src"] } }),
    ).toMatchObject({ command: "ls -la src" });
  });

  it("ignores a non-string command", () => {
    // Antigravity's run_command names it CommandLine (ADR 0104).
    expect(
      toToolCallInfo({
        toolCallId: "abc",
        rawInput: { CommandLine: "rm -rf ./*", toolSummary: "x" },
      }),
    ).toMatchObject({ command: "rm -rf ./*" });
    expect(toToolCallInfo({ toolCallId: "abc", rawInput: { command: 42 } })).not.toHaveProperty(
      "command",
    );
    expect(
      toToolCallInfo({ toolCallId: "abc", rawInput: { command: ["ls", 42] } }),
    ).not.toHaveProperty("command");
  });

  it("copies rawInput when present", () => {
    const rawInput = { command: "ls", nested: { x: 1 } };
    expect(toToolCallInfo({ toolCallId: "abc", rawInput })).toMatchObject({
      command: "ls",
      rawInput,
    });
  });

  it("does not copy a null rawInput", () => {
    expect(toToolCallInfo({ toolCallId: "abc", rawInput: null })).not.toHaveProperty("rawInput");
  });
});

describe("ToolCallTracker", () => {
  it("fills a permission request that carries only the id from the earlier tool call", () => {
    const t = new ToolCallTracker();
    t.merge("s1", {
      toolCallId: "c1",
      title: "bash",
      kind: "execute",
      rawInput: { command: "echo hi > out.txt" },
    });
    t.merge("s1", { toolCallId: "c1", status: "in_progress", title: null });
    const info = toToolCallInfo(t.merge("s1", { toolCallId: "c1" }));
    expect(info).toMatchObject({ kind: "execute", title: "bash", command: "echo hi > out.txt" });
  });

  it("keeps sessions apart and forgets cleared sessions", () => {
    const t = new ToolCallTracker();
    t.merge("s1", { toolCallId: "c1", title: "one" });
    expect(t.merge("s2", { toolCallId: "c1" }).title).toBeUndefined();
    t.clear("s1");
    expect(t.merge("s1", { toolCallId: "c1" }).title).toBeUndefined();
  });
});
