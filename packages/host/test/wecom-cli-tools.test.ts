import { describe, expect, it, vi } from "vitest";
import { discoverWecomCliTools } from "../src/wecom-cli-tools.js";

const name = (method: string) => `WECOM_${method.toUpperCase().replaceAll(".", "_")}`;
const object = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});
const string = { type: "string" };

function mockCli(methods: Record<string, unknown>, results: Record<string, unknown> = {}) {
  const groups = new Map<string, { name: string; description: string }[]>();
  for (const method of Object.keys(methods)) {
    const service = method.split(".")[0]!;
    const entries = groups.get(service) ?? [];
    entries.push({ name: method, description: `Description of ${method}` });
    groups.set(service, entries);
  }
  const run = vi.fn(async (args: readonly string[], _signal?: AbortSignal): Promise<unknown> => {
    if (args.join(" ") === "schema list") {
      return [...groups].map(([name, methods]) => ({ name, methods }));
    }
    if (args[0] === "schema" && args[1] === "get") {
      const method = args[2]!;
      return { method, response: object(), schemas: {}, ...Object(methods[method]) };
    }
    const i = args.indexOf("--json");
    return results[args.slice(0, i < 0 ? undefined : i).join(".")] ?? { ok: true };
  });
  return run;
}

describe("WeCom CLI office tools", () => {
  it("uses only the discovered intersection of reviewed paths with conservative owner approval hints", async () => {
    const methods = [
      "calendar.schedules.list",
      "calendar.schedules.create",
      "meeting.search",
      "todo.finish",
      "doc.search",
      "mail.search",
      "disk.files.get",
      "contact.users.search",
      "message.send",
      "message.aibot.send",
      "message.aibot.sessions.list",
    ];
    const excluded = [
      "message.files.get",
      "message.aibot.messages.list",
      "chat.messages.list",
      "chat.groups.list",
      "identity.get",
      "disk.files.download",
      "meeting.original.get",
      "calendar.schedules.list.--output",
      "calendar.schedules.preview",
    ];
    const run = mockCli(
      Object.fromEntries([...methods, ...excluded].map((path) => [path, { request: object() }])),
    );
    const signal = new AbortController().signal;
    const tools = await discoverWecomCliTools(run, signal);
    expect(run.mock.calls).toEqual([
      [["schema", "list"], signal],
      ...methods.map((path) => [["schema", "get", path], signal]),
    ]);
    expect((await tools.list()).map((tool) => tool.name)).toEqual(methods.map(name));
    expect(tools.capabilities).toEqual([
      { id: "calendar", name: "日历", toolCount: 2 },
      { id: "meeting", name: "会议", toolCount: 1 },
      { id: "todo", name: "待办", toolCount: 1 },
      { id: "doc", name: "文档", toolCount: 1 },
      { id: "mail", name: "邮件", toolCount: 1 },
      { id: "disk", name: "微盘", toolCount: 1 },
      { id: "contact", name: "通讯录", toolCount: 1 },
      { id: "message", name: "消息", toolCount: 3 },
    ]);
    const info = await tools.describe([...methods, ...excluded].map(name));
    expect([...info.keys()]).toEqual(methods.map(name));
    for (const path of methods) {
      expect(info.get(name(path))).toMatchObject({
        toolkit: "builtin:wecom",
        hints: {
          readOnly: ![
            "calendar.schedules.create",
            "todo.finish",
            "message.send",
            "message.aibot.send",
          ].includes(path),
        },
      });
    }
    for (const path of [...excluded, "todo.create"]) {
      await expect(tools.call(name(path), {})).rejects.toThrow("WeCom CLI tool is unavailable.");
    }
    expect(run).toHaveBeenCalledTimes(methods.length + 1);
  });

  it("resolves bare CLI references and calls with exactly one JSON argument", async () => {
    const method = "calendar.schedules.create";
    const run = mockCli({
      [method]: {
        request: { $ref: "Request" },
        response: { $ref: "Response" },
        schemas: {
          Request: object(
            {
              title: string,
              attendees: {
                type: "array",
                items: { type: "object", $ref: "Attendee" },
                minItems: 1,
              },
            },
            ["title", "attendees"],
          ),
          Attendee: object({ user_id: { type: "string", minLength: 1 } }, ["user_id"]),
          Response: object(),
        },
      },
    });
    const tools = await discoverWecomCliTools(run);
    expect((await tools.list())[0]).toMatchObject({
      name: name(method),
      description: `Description of ${method}`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["title", "attendees"],
        properties: {
          attendees: {
            items: { type: "object", additionalProperties: false, required: ["user_id"] },
          },
        },
      },
    });
    const args = { title: '@not-a-path " --output -', attendees: [{ user_id: "u1" }] };
    await expect(tools.call(name(method), args)).resolves.toEqual({
      content: [{ type: "text", text: '{"ok":true}' }],
    });
    expect(run).toHaveBeenLastCalledWith([
      "calendar",
      "schedules",
      "create",
      "--json",
      JSON.stringify(args),
    ]);
    for (const bad of [
      [],
      { title: "missing required" },
      { ...args, "--output-dir": "sensitive-path" },
      { ...args, attendees: [{ user_id: "u1", access_token: "hidden-value" }] },
      { ...args, attendees: [{ user_id: "" }] },
      { ...args, attendees: [] },
      { ...args, attendees: [{ user_id: 123 }] },
      { ...args, title: { toJSON: () => "bad" } },
    ]) {
      await expect(tools.call(name(method), bad)).rejects.toThrow(
        /^Invalid WeCom CLI tool arguments\.$/,
      );
    }
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid input during preflight without starting an office command", async () => {
    const method = "message.send";
    const run = mockCli({ [method]: { request: object({ chat_id: string }, ["chat_id"]) } });
    const tools = await discoverWecomCliTools(run);
    run.mockClear();

    expect(() =>
      tools.preflight(name(method), { chat_id: "test-chat", access_token: "unused" }),
    ).toThrow(/^Invalid WeCom CLI tool arguments\.$/);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps private content out of approval and runs the original validated request", async () => {
    const method = "message.aibot.send";
    const run = mockCli({
      [method]: {
        request: object(
          {
            chat_id: string,
            text: object({ content: string }, ["content"]),
          },
          ["chat_id", "text"],
        ),
      },
    });
    const tools = await discoverWecomCliTools(run);
    run.mockClear();
    const args = { chat_id: "test-chat", text: { content: "private office content" } };

    const prepared = tools.preflight(name(method), args);
    expect(run).not.toHaveBeenCalled();
    expect(prepared.approvalArguments).toEqual({
      targets: { chat_id: "test-chat" },
      fields: ["chat_id", "text"],
      listSizes: {},
    });
    args.chat_id = "other-chat";
    args.text.content = "changed since validation";
    await prepared.execute();
    expect(run).toHaveBeenCalledExactlyOnceWith([
      "message",
      "aibot",
      "send",
      "--json",
      '{"chat_id":"test-chat","text":{"content":"private office content"}}',
    ]);
  });

  it("omits unsupported schemas and prevents file input, output and undocumented JSON flags", async () => {
    const upload = { type: "string", "x-wecom-file-upload": {} };
    const run = mockCli({
      "doc.create": {
        request: object({ doc_name: string, content: string, file_path: upload }, ["doc_name"]),
      },
      "doc.contents.get": {
        response: { $ref: "File" },
        schemas: { File: object({ data: { ...string, "x-wecom-file-save": {} } }) },
      },
      "doc.import": { request: object({ file_path: upload }, ["file_path"]) },
      "mail.send": { request: object({ file_path: upload }, ["file_path"]) },
      "disk.files.get": { request: object({ file_path: string }) },
      "disk.files.list": { request: { ...object(), additionalProperties: true } },
      "disk.files.search": { request: { $ref: "Unresolved" } },
      "meeting.get": { request: object({ id: string }), response: { $ref: "UnknownResponse" } },
      "mail.search": { request: object({ options: { type: "object", anyOf: [object()] } }) },
    });
    const tools = await discoverWecomCliTools(run);
    expect((await tools.list()).map((tool) => tool.name)).toEqual(["WECOM_DOC_CREATE"]);
    const [tool] = await tools.list();
    expect(tool?.inputSchema).toMatchObject({
      properties: { doc_name: string, content: string },
      additionalProperties: false,
    });
    expect(tool?.inputSchema).not.toHaveProperty("properties.file_path");
    for (const bad of [
      { doc_name: "notes", file_path: "@local-file" },
      { doc_name: "notes", output: "local-file" },
      { doc_name: "notes", output_dir: "directory" },
      { doc_name: "notes", "--output": "local-file" },
      { doc_name: "notes", dry_run: true },
      { doc_name: "notes", page_count: 10 },
      { doc_name: "notes", access_token: "secret" },
    ])
      await expect(tools.call("WECOM_DOC_CREATE", bad)).rejects.toThrow(
        "Invalid WeCom CLI tool arguments.",
      );
    await tools.call("WECOM_DOC_CREATE", { doc_name: "notes", content: "inline" });
    expect(run).toHaveBeenLastCalledWith([
      "doc",
      "create",
      "--json",
      '{"doc_name":"notes","content":"inline"}',
    ]);
  });

  it("accepts reviewed inline document creation and the pinned Rust filename pattern", async () => {
    const pattern = String.raw`^[^/\\\\:\\*\\?\"<>\\|]+$`;
    const run = mockCli({
      "doc.create": {
        request: object(
          {
            doc_name: string,
            content: string,
            file_path: { ...string, "x-wecom-file-upload": {} },
            doc_requests: { type: "array", items: { $ref: "ComplexDefinition" } },
          },
          ["doc_name"],
        ),
      },
      "disk.folders.create": {
        request: object({ folder_name: { ...string, pattern } }, ["folder_name"]),
      },
    });
    const tools = await discoverWecomCliTools(run);
    expect((await tools.list()).map((tool) => tool.name)).toEqual([
      "WECOM_DOC_CREATE",
      "WECOM_DISK_FOLDERS_CREATE",
    ]);
    await expect(
      tools.call("WECOM_DOC_CREATE", { doc_name: "notes", doc_requests: [] }),
    ).rejects.toThrow("Invalid WeCom CLI tool arguments.");
    await expect(
      tools.call("WECOM_DISK_FOLDERS_CREATE", { folder_name: "remote/subfolder" }),
    ).rejects.toThrow("Invalid WeCom CLI tool arguments.");
    await tools.call("WECOM_DISK_FOLDERS_CREATE", { folder_name: "New folder" });
    expect(run).toHaveBeenLastCalledWith([
      "disk",
      "folders",
      "create",
      "--json",
      '{"folder_name":"New folder"}',
    ]);
  });

  it("exposes ordinary document search filters but not the optional sort script", async () => {
    const method = "doc.search";
    const run = mockCli({
      [method]: {
        request: object(
          {
            keywords: { type: "array", items: string },
            sort_script: string,
          },
          ["keywords"],
        ),
      },
    });
    const tools = await discoverWecomCliTools(run);
    await expect(
      tools.call(name(method), { keywords: ["notes"], sort_script: "expression" }),
    ).rejects.toThrow("Invalid WeCom CLI tool arguments.");
    await tools.call(name(method), { keywords: ["notes"] });
    expect(run).toHaveBeenLastCalledWith(["doc", "search", "--json", '{"keywords":["notes"]}']);
  });

  it("returns recent session metadata only and rejects session inputs", async () => {
    const method = "message.aibot.sessions.list";
    const run = mockCli(
      { [method]: { request: object() } },
      {
        [method]: {
          sessions_count: 1,
          history: ["top-level history"],
          sessions: [
            {
              chat_id: "group-a",
              chat_name: "Group A",
              chat_type: "group",
              last_msg_time: "2026-01-01",
              last_message: "private message",
              members: ["private member"],
            },
          ],
        },
      },
    );
    const tools = await discoverWecomCliTools(run);
    await expect(tools.call(name(method), { cursor: "earlier" })).rejects.toThrow(
      "Invalid WeCom CLI tool arguments.",
    );
    expect(await tools.call(name(method), {})).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            sessions: [
              {
                chat_id: "group-a",
                chat_name: "Group A",
                chat_type: "group",
                last_msg_time: "2026-01-01",
              },
            ],
            sessions_count: 1,
          }),
        },
      ],
    });
    expect(run).toHaveBeenLastCalledWith(["message", "aibot", "sessions", "list", "--json", "{}"]);
  });

  it("replaces runner failures with fixed errors without retaining causes", async () => {
    const leaks = Object.assign(new Error("sensitive failure"), {
      stderr: "secret",
      argv: ["credential"],
    });
    const failed = vi.fn(async () => {
      throw leaks;
    });
    const discovery = discoverWecomCliTools(failed);
    await expect(discovery).rejects.toThrow(/^WeCom CLI tool discovery failed\.$/);
    await expect(discovery).rejects.not.toHaveProperty("cause");
    const method = "todo.list";
    const run = mockCli({ [method]: { request: object() } });
    const tools = await discoverWecomCliTools(run);
    run.mockRejectedValueOnce(leaks);
    const failure = tools.call(name(method), {});
    await expect(failure).rejects.toThrow(/^WeCom CLI tool call failed\.$/);
    await expect(failure).rejects.not.toHaveProperty("cause");
    await expect(failure).rejects.not.toHaveProperty("stderr");
  });
});
