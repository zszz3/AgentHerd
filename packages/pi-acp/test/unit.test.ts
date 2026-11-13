import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeQuestion,
  encodeQuestion,
  LineSplitter,
  MAX_ARG_CHARS,
  MCP_ENV,
  MCP_PATH,
  normalizeInputSchema,
  piArgsFor,
  piCommand,
  runsWithoutAsking,
  SESSION_DIR_ENV,
  snippetOf,
  toolCallOf,
  trustedMcpTools,
} from "../src/index.ts";

describe("gate", () => {
  it("runs read tools inside the folder without asking", () => {
    expect(runsWithoutAsking("read", { path: "src/a.ts" }, "/p")).toBe(true);
    expect(runsWithoutAsking("ls", {}, "/p")).toBe(true);
    expect(runsWithoutAsking("grep", { pattern: "x", path: "/p/src" }, "/p")).toBe(true);
  });

  it("asks for reads outside the folder and for every other tool", () => {
    expect(runsWithoutAsking("read", { path: "../secret" }, "/p")).toBe(false);
    expect(runsWithoutAsking("read", { path: "/Users/me/.ssh/id_rsa" }, "/p")).toBe(false);
    expect(runsWithoutAsking("read", { path: 3 }, "/p")).toBe(false);
    expect(runsWithoutAsking("bash", { command: "ls" }, "/p")).toBe(false);
    expect(runsWithoutAsking("write", { path: "a" }, "/p")).toBe(false);
    expect(runsWithoutAsking("mcp__x", {}, "/p")).toBe(false);
  });

  it("trusts only explicit trusted MCP tool names, never built-in tools", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-gate-mcp-"));
    const file = join(dir, "mcp.json");
    writeFileSync(
      file,
      JSON.stringify({
        servers: [],
        tools: [
          { name: "herd_report", trusted: true },
          { name: "custom_tool", trusted: false },
          { name: "bash", trusted: true },
        ],
      }),
    );
    const trusted = trustedMcpTools({ [MCP_ENV]: file });
    expect([...trusted]).toEqual(["herd_report"]);
    expect(runsWithoutAsking("herd_report", {}, "/p", trusted)).toBe(true);
    expect(runsWithoutAsking("custom_tool", {}, "/p", trusted)).toBe(false);
    expect(runsWithoutAsking("bash", { command: "rm -rf /" }, "/p", trusted)).toBe(false);
    expect([...trustedMcpTools({})]).toEqual([]);
    expect([...trustedMcpTools({ [MCP_ENV]: join(dir, "missing.json") })]).toEqual([]);
  });

  it("round-trips a question and ignores other titles", () => {
    const q = { toolCallId: "c1", toolName: "bash", input: { command: "ls" } };
    expect(decodeQuestion(encodeQuestion(q))).toEqual(q);
    expect(decodeQuestion("Allow dangerous command?")).toBeUndefined();
    expect(decodeQuestion("agentherd-gate:{bad")).toBeUndefined();
  });
});

describe("piArgsFor", () => {
  it("keeps sessions only when AgentHerd gives a folder for them (ADR 0039)", () => {
    expect(piArgsFor([], {}, "pi-1").slice(0, 3)).toEqual(["--mode", "rpc", "--no-session"]);
    expect(piArgsFor([], { [SESSION_DIR_ENV]: "/h/pi-sessions" }, "pi-1").slice(0, 6)).toEqual([
      "--mode",
      "rpc",
      "--session-dir",
      "/h/pi-sessions",
      "--session-id",
      "pi-1",
    ]);
  });

  it("loads the MCP extension only when AGENTHERD_PI_MCP is set", () => {
    expect(piArgsFor([], {}, "pi-1")).not.toContain(MCP_PATH);
    expect(piArgsFor([], { [MCP_ENV]: "/tmp/mcp.json" }, "pi-1")).toContain(MCP_PATH);
  });
});

describe("mcp schema & snippet", () => {
  it("normalizes missing or partial JSON schemas to object schemas", () => {
    expect(normalizeInputSchema(undefined)).toEqual({ type: "object", properties: {} });
    expect(normalizeInputSchema({ required: ["x"] })).toEqual({
      type: "object",
      properties: {},
      required: ["x"],
    });
    expect(
      normalizeInputSchema({
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      }),
    ).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
  });

  it("extracts a concise one-line promptSnippet", () => {
    expect(snippetOf("herd_ack", "")).toBe("herd_ack");
    expect(snippetOf("herd_ack", "Send one line. More details here.")).toBe("Send one line.");
    expect(snippetOf("long", "a".repeat(200)).length).toBe(140);
  });
});

describe("toolCallOf", () => {
  it("maps Pi tools to ACP kinds, titles and locations", () => {
    expect(toolCallOf("1", "bash", { command: "npm test\nmore" }, "/p")).toMatchObject({
      kind: "execute",
      title: "npm test",
      locations: [],
    });
    expect(toolCallOf("2", "edit", { path: "a.ts" }, "/p")).toMatchObject({
      kind: "edit",
      title: "Edit /p/a.ts",
      locations: [{ path: "/p/a.ts" }],
    });
    expect(toolCallOf("3", "find", { pattern: "*.ts" }, "/p")).toMatchObject({
      kind: "search",
      title: "Find *.ts",
    });
    expect(toolCallOf("4", "web_fetch", { url: "x" }, "/p")).toMatchObject({
      kind: "other",
      title: "web_fetch",
    });
  });

  it("cuts long arguments", () => {
    const call = toolCallOf("1", "write", { path: "a", content: "x".repeat(5000) }, "/p");
    expect(String(call.rawInput.content)).toHaveLength(MAX_ARG_CHARS + " (5000 chars)".length + 1);
  });
});

describe("LineSplitter", () => {
  it("splits on LF only, keeps U+2028 inside a record, and joins split chunks", () => {
    const lines: string[] = [];
    const s = new LineSplitter();
    const record = `${JSON.stringify({ t: "a\u2028b" })}\r\n{"t":"c"}\n`;
    const bytes = Buffer.from(record, "utf8");
    s.push(bytes.subarray(0, 7), (l) => lines.push(l));
    s.push(bytes.subarray(7), (l) => lines.push(l));
    expect(lines.map((l) => JSON.parse(l).t)).toEqual(["a\u2028b", "c"]);
  });
});

describe("piCommand", () => {
  it("runs a Node script with this Node and a binary as is", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-cmd-"));
    const script = join(dir, "cli.js");
    writeFileSync(script, "#!/usr/bin/env node\nconsole.log(1)\n");
    symlinkSync(script, join(dir, "pi"));
    const real = piCommand(join(dir, "pi"), "/node")[1] ?? "";
    expect(piCommand(join(dir, "pi"), "/node")).toEqual(["/node", real]);
    const bin = join(dir, "native");
    writeFileSync(bin, "\x7fELF");
    expect(piCommand(bin, "/node")).toHaveLength(1);
    expect(piCommand(join(dir, "missing"), "/node")).toEqual([join(dir, "missing")]);
  });
});
