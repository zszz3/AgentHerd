import { describe, expect, it } from "vitest";
import { DEFAULT_OPTIONS, parseScript, ScriptError } from "../src/script.ts";

function parseError(text: string): ScriptError {
  try {
    parseScript(text);
  } catch (error) {
    expect(error).toBeInstanceOf(ScriptError);
    return error as ScriptError;
  }
  throw new Error("expected parseScript to throw");
}

describe("ScriptError", () => {
  it("is an Error named ScriptError", () => {
    const error = new ScriptError("boom");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ScriptError");
    expect(error.message).toBe("boom");
  });
});

describe("DEFAULT_OPTIONS", () => {
  it("lists allow_once, allow_always and reject_once", () => {
    expect(DEFAULT_OPTIONS).toEqual([
      { id: "allow", kind: "allow_once", name: "Allow" },
      { id: "always", kind: "allow_always", name: "Always allow" },
      { id: "reject", kind: "reject_once", name: "Reject" },
    ]);
  });
});

describe("parseScript", () => {
  it("defaults the name to mock-agent", () => {
    expect(parseScript("turns: []\n").name).toBe("mock-agent");
  });

  it("parses message and stderr steps", () => {
    const script = parseScript(`
turns:
  - - message: "hello"
    - stderr: "warning"
`);
    expect(script.turns).toEqual([
      [
        { type: "message", text: "hello" },
        { type: "stderr", text: "warning" },
      ],
    ]);
  });

  it("parses a tool_call with a default status of completed", () => {
    const script = parseScript(`
turns:
  - - tool_call:
        id: t1
        title: "Run tests"
        kind: execute
        command: "pnpm test"
        paths: ["src/a.ts"]
`);
    expect(script.turns[0]).toEqual([
      {
        type: "tool_call",
        toolCall: {
          id: "t1",
          title: "Run tests",
          kind: "execute",
          command: "pnpm test",
          paths: ["src/a.ts"],
        },
        status: "completed",
      },
    ]);
  });

  it("parses a tool_call with an explicit status", () => {
    const script = parseScript(`
turns:
  - - tool_call:
        id: t1
        title: "x"
        status: failed
`);
    expect(script.turns[0]).toEqual([
      {
        type: "tool_call",
        toolCall: { id: "t1", title: "x", kind: "other" },
        status: "failed",
      },
    ]);
  });

  it("parses a request_permission with DEFAULT_OPTIONS and on_reject end_turn", () => {
    const script = parseScript(`
turns:
  - - request_permission:
        toolCall: { id: t1, title: "Edit", kind: edit, paths: ["src/b.ts"] }
`);
    expect(script.turns[0]).toEqual([
      {
        type: "request_permission",
        toolCall: { id: "t1", title: "Edit", kind: "edit", paths: ["src/b.ts"] },
        options: [...DEFAULT_OPTIONS],
        onReject: "end_turn",
      },
    ]);
  });

  it("parses a request_permission with custom options, expect and on_reject", () => {
    const script = parseScript(`
turns:
  - - request_permission:
        toolCall: { id: t1, title: "Edit", kind: edit }
        options:
          - { id: yes, kind: allow_once, name: "Yes" }
          - { id: no, kind: reject_always, name: "No" }
        expect: deny
        on_reject: continue
`);
    expect(script.turns[0]).toEqual([
      {
        type: "request_permission",
        toolCall: { id: "t1", title: "Edit", kind: "edit" },
        options: [
          { id: "yes", kind: "allow_once", name: "Yes" },
          { id: "no", kind: "reject_always", name: "No" },
        ],
        expect: "deny",
        onReject: "continue",
      },
    ]);
  });

  it("parses a sleep step", () => {
    expect(parseScript("turns:\n  - - sleep: 250\n").turns[0]).toEqual([
      { type: "sleep", ms: 250 },
    ]);
  });

  it("parses steer and a read_steers step (ADR 0063)", () => {
    const script = parseScript("steer: true\nturns:\n  - - read_steers: 500\n");
    expect(script.steer).toBe(true);
    expect(script.turns[0]).toEqual([{ type: "read_steers", ms: 500 }]);
    expect(parseScript("turns: []\n").steer).toBeUndefined();
    expect(() => parseScript("steer: yes please\nturns: []\n")).toThrow(/steer: expected/);
  });

  it("parses a crash with a default code of 1", () => {
    expect(parseScript("turns:\n  - - crash:\n").turns[0]).toEqual([{ type: "crash", code: 1 }]);
  });

  it("parses a crash with an explicit code", () => {
    expect(parseScript("turns:\n  - - crash: 7\n").turns[0]).toEqual([{ type: "crash", code: 7 }]);
  });

  it("parses an end_turn with a default stopReason of end_turn", () => {
    expect(parseScript("turns:\n  - - end_turn:\n").turns[0]).toEqual([
      { type: "end_turn", stopReason: "end_turn" },
    ]);
  });

  it("parses an end_turn with an explicit stopReason", () => {
    expect(parseScript("turns:\n  - - end_turn: refusal\n").turns[0]).toEqual([
      { type: "end_turn", stopReason: "refusal" },
    ]);
  });

  it("parses multiple turns", () => {
    const script = parseScript(`
name: demo
turns:
  - - message: "first"
  - - message: "second"
`);
    expect(script.name).toBe("demo");
    expect(script.turns).toEqual([
      [{ type: "message", text: "first" }],
      [{ type: "message", text: "second" }],
    ]);
  });
});

describe("parseScript errors", () => {
  it("reports invalid YAML with its message", () => {
    expect(parseError("turns: [unclosed\n").message).toMatch(/^invalid YAML: /);
  });

  it("reports a non-mapping document", () => {
    expect(parseError("just a string\n").message).toBe("script: expected a mapping");
  });

  it("reports missing turns", () => {
    expect(parseError("name: demo\n").message).toBe("turns: expected a list");
  });

  it("reports a turn that is not a list", () => {
    expect(parseError("turns:\n  - message: hi\n").message).toBe(
      "turns[0]: expected a list of steps",
    );
  });

  it("reports a step with two keys", () => {
    expect(parseError("turns:\n  - - message: hi\n      stderr: err\n").message).toBe(
      "turns[0][0]: expected exactly one step key",
    );
  });

  it("reports an unknown step", () => {
    expect(parseError("turns:\n  - - frobnicate: 1\n").message).toBe(
      'turns[0][0]: unknown step "frobnicate"',
    );
  });

  it("reports a bad tool kind", () => {
    expect(
      parseError(
        "turns:\n  - - tool_call:\n        id: t1\n        title: x\n        kind: frobnicate\n",
      ).message,
    ).toBe(
      'turns[0][0].tool_call.kind: expected one of read, edit, delete, move, search, execute, think, fetch, other, got "frobnicate"',
    );
  });

  it("reports a bad permission kind", () => {
    expect(
      parseError(
        "turns:\n  - - request_permission:\n        toolCall: { id: t1, title: x }\n        options:\n          - { id: a, kind: maybe, name: Maybe }\n",
      ).message,
    ).toBe(
      'turns[0][0].request_permission.options[0].kind: expected one of allow_once, allow_always, reject_once, reject_always, got "maybe"',
    );
  });

  it("reports a negative sleep", () => {
    expect(parseError("turns:\n  - - sleep: -1\n").message).toBe(
      "turns[0][0].sleep: expected ms >= 0",
    );
  });

  it("reports a bad expect value", () => {
    expect(
      parseError(
        "turns:\n  - - request_permission:\n        toolCall: { id: t1, title: x }\n        expect: maybe\n",
      ).message,
    ).toBe(
      'turns[0][0].request_permission.expect: expected one of allow, deny, cancelled, got "maybe"',
    );
  });
});
