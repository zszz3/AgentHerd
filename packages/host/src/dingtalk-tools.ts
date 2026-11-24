import type { AppTools } from "@agentherd/core";
import { redact } from "@agentherd/rules";
import type { DingTalkView } from "./api.ts";
import type { BoundDingTalkRun, DingTalkAccount } from "./dingtalk-account.ts";
import {
  calendarReceipt,
  chatPage,
  documentContent,
  documentList,
  documentReceipt,
  groupName,
  messageReceipt,
  minutesSummary,
  unifiedPage,
} from "./dingtalk-results.ts";

const TOOLKIT = "builtin:dingtalk";
const UNAVAILABLE = "该钉钉工具不可用。";
const invalid = () => new Error("钉钉工具参数不合法。");
const string = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const query = string(120);
const title = string(200);
const date = { ...string(35), format: "date-time" };
const token = string(128);
const group = string(160);
const cursor = string(512);
const limit = { type: "integer", minimum: 1, maximum: 50 };
const page = { cursor, limit };
const categories = { calendar: "日历", doc: "文档", group: "群聊", minutes: "AI 听记" };

type Field = ReturnType<typeof string> | typeof limit;
type Input = Record<string, string | number>;
type Decoder = (value: unknown) => unknown;
type Command = {
  args: string[];
  decode: Decoder;
  stdin?: string;
  approval?: Record<string, string>;
};

function entry(
  category: keyof typeof categories,
  label: string,
  properties: Record<string, Field>,
  required: string[],
  build: (input: Input, run: BoundDingTalkRun) => Command | Promise<Command>,
  write = false,
) {
  return { category, label, properties, required, build, write };
}

function validate(value: unknown, tool: ReturnType<typeof entry>): Input {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  const validated: Input = Object.create(null);
  for (const [key, field] of Object.entries(value)) {
    if (!Object.hasOwn(tool.properties, key)) throw invalid();
    const schema = tool.properties[key];
    if (schema === undefined) throw invalid();
    if ("maxLength" in schema) {
      if (
        typeof field !== "string" ||
        !field.trim() ||
        field.length > schema.maxLength ||
        /[\p{Cc}\p{Cf}]/u.test(key === "text" ? field.replace(/[\r\n\t]/g, "") : field)
      )
        throw invalid();
      if ((key === "nodeId" || key === "minutesId") && !/^[\w-]+$/.test(field)) throw invalid();
      if (key === "groupId" && !/^cid[\w+/=-]+$/.test(field)) throw invalid();
      if (key === "cursor" && !/^[!-~]+$/.test(field)) throw invalid();
    } else if (typeof field !== "number" || !Number.isInteger(field) || field < 1 || field > 50)
      throw invalid();
    validated[key] = field;
  }
  if (tool.required.some((key) => !Object.hasOwn(validated, key))) throw invalid();
  return validated;
}

const flag = (name: string, value: string | number) => `--${name}=${value}`;
const read = (input: Input, key: string): string => String(input[key]);
const continuation = (input: Input, name = "cursor") =>
  input.cursor === undefined ? [] : [flag(name, input.cursor)];
const bounded = (input: Input, name?: string) => [
  flag("limit", input.limit ?? 20),
  ...continuation(input, name),
];

function epoch(text: string): number {
  const match = /^(\d{4})-(\d\d)-(\d\d)T\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.exec(
    text,
  );
  if (match === null) throw invalid();
  const [, y, m, d] = match;
  const day = Date.parse(`${y}-${m}-${d}T00:00:00Z`);
  const time = Date.parse(text);
  if (
    !Number.isFinite(day) ||
    !Number.isFinite(time) ||
    new Date(day).getUTCDate() !== Number(d) ||
    /T24:/.test(text)
  )
    throw invalid();
  return time;
}

function windowArgs(input: Input): [string, string] {
  const start = read(input, "start");
  const end = read(input, "end");
  if (epoch(start) >= epoch(end)) throw invalid();
  return [flag("start", start), flag("end", end)];
}

function preview(text: string): string {
  const safe = redact(text)
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
    .trim();
  return safe.length > 160 ? `${safe.slice(0, 159)}…` : safe;
}

async function verifyGroup(run: BoundDingTalkRun, id: string) {
  return groupName(await run({ args: ["chat", "+conversation-info", flag("group", id)] }), id);
}

const catalog = new Map(
  Object.entries({
    dingtalk_calendar_list: entry(
      "calendar",
      "查询主日历日程",
      { start: date, end: date, ...page },
      ["start", "end"],
      (input) => ({
        args: ["calendar", "+agenda", ...windowArgs(input), ...bounded(input)],
        decode: (v) => unifiedPage(v, "events"),
      }),
    ),
    dingtalk_doc_search: entry("doc", "搜索可见文档", { query, ...page }, ["query"], (input) => ({
      args: ["doc", "+search", flag("query", read(input, "query")), ...bounded(input)],
      decode: documentList,
    })),
    dingtalk_doc_fetch: entry("doc", "读取文档正文", { nodeId: token }, ["nodeId"], (input) => ({
      args: ["doc", "+fetch", flag("node", read(input, "nodeId"))],
      decode: documentContent,
    })),
    dingtalk_group_find: entry(
      "group",
      "按名称查找当前可见群聊（逐页）",
      { query, ...page },
      ["query"],
      (input) => ({
        args: ["chat", "+my-groups", ...bounded(input)],
        decode: (v) => {
          const found = chatPage(v, "groups");
          const term = read(input, "query").trim().toLowerCase();
          return {
            ...found,
            items: found.items.filter(
              (row) =>
                typeof row.name === "string" &&
                typeof row.openConversationId === "string" &&
                row.name.toLowerCase().includes(term),
            ),
          };
        },
      }),
    ),
    dingtalk_group_history: entry(
      "group",
      "读取群聊消息（不含附件下载）",
      { groupId: group, ...page },
      ["groupId"],
      async (input, run) => {
        const id = read(input, "groupId");
        await verifyGroup(run, id);
        return {
          args: [
            "chat",
            "+chat-messages",
            flag("group", id),
            "--no-reactions",
            ...bounded(input, "page-token"),
          ],
          decode: (v) => chatPage(v, "messages"),
        };
      },
    ),
    dingtalk_group_search_messages: entry(
      "group",
      "搜索指定群消息（钉钉默认最近七天）",
      { groupId: group, query, ...page },
      ["groupId", "query"],
      async (input, run) => {
        const id = read(input, "groupId");
        await verifyGroup(run, id);
        return {
          args: [
            "chat",
            "+search-msg",
            flag("group", id),
            flag("query", read(input, "query")),
            ...bounded(input),
          ],
          decode: (v) => chatPage(v, "messages"),
        };
      },
    ),
    dingtalk_minutes_search: entry(
      "minutes",
      "搜索有权访问的 AI 听记",
      { query, ...page },
      ["query"],
      (input) => ({
        args: [
          "minutes",
          "+search",
          "--scope=all",
          flag("query", read(input, "query")),
          ...bounded(input),
        ],
        decode: (v) => unifiedPage(v, "minutes"),
      }),
    ),
    dingtalk_minutes_summary: entry(
      "minutes",
      "读取 AI 听记摘要",
      { minutesId: token },
      ["minutesId"],
      (input) => ({
        args: ["minutes", "+detail", flag("id", read(input, "minutesId")), "--artifacts=summary"],
        decode: (v) => minutesSummary(v, read(input, "minutesId")),
      }),
    ),
    dingtalk_minutes_transcript: entry(
      "minutes",
      "逐页读取 AI 听记逐字稿",
      { minutesId: token, cursor },
      ["minutesId"],
      (input) => ({
        args: [
          "minutes",
          "+transcript",
          flag("id", read(input, "minutesId")),
          "--single-page",
          ...continuation(input),
        ],
        decode: (v) => unifiedPage(v, "paragraphList"),
      }),
    ),
    dingtalk_group_send_text: entry(
      "group",
      "向指定群发送纯文本",
      { groupId: group, text: string(2000) },
      ["groupId", "text"],
      async (input, run) => {
        const id = read(input, "groupId");
        const target = preview(await verifyGroup(run, id));
        if (!target) throw invalid();
        const text = read(input, "text");
        return {
          args: [
            "chat",
            "+messages-send",
            "--as=user",
            flag("group", id),
            "--msg-type=text",
            flag("text", text),
            "--yes",
          ],
          decode: messageReceipt,
          approval: { target, groupId: id, preview: preview(text) },
        };
      },
      true,
    ),
    dingtalk_calendar_create: entry(
      "calendar",
      "在主日历创建日程（不邀请他人）",
      { title, start: date, end: date },
      ["title", "start", "end"],
      (input) => ({
        args: [
          "calendar",
          "+create",
          flag("title", read(input, "title")),
          ...windowArgs(input),
          "--yes",
        ],
        decode: calendarReceipt,
        approval: {
          target: "已连接账号的主日历",
          title: preview(read(input, "title")),
          start: read(input, "start"),
          end: read(input, "end"),
        },
      }),
      true,
    ),
    dingtalk_doc_create: entry(
      "doc",
      "创建纯文本钉钉文档（默认位置）",
      { title, text: string(16384) },
      ["title", "text"],
      (input) => {
        const text = read(input, "text");
        if (Buffer.byteLength(text) > 16384 || /[[\]<>!]|^\s*@/m.test(text)) throw invalid();
        return {
          args: ["doc", "+create", flag("name", read(input, "title")), "--content=-"],
          stdin: text,
          decode: documentReceipt,
          approval: {
            target: "钉钉默认文档位置",
            title: preview(read(input, "title")),
            preview: preview(text),
          },
        };
      },
      true,
    ),
  }),
);

export function dingtalkCapabilities(): DingTalkView["capabilities"] {
  const items = [...catalog.values()];
  return Object.entries(categories).map(([id, name]) => ({
    id,
    name,
    toolCount: items.filter((entry) => entry.category === id).length,
  }));
}

export function dingtalkTools(account: Pick<DingTalkAccount, "bind" | "view">): AppTools {
  const prepare = async (name: string, value: unknown) => {
    const tool = catalog.get(name);
    if (tool === undefined) throw new Error(UNAVAILABLE);
    const args = validate(value, tool);
    const run = await account.bind();
    const { args: argv, stdin, decode, approval } = await tool.build(args, run);
    const command = Object.freeze({
      args: Object.freeze(argv),
      ...(stdin === undefined ? {} : { stdin }),
    });
    let used = false;
    return {
      approvalArguments: approval ?? {},
      execute: async (beforeDispatch?: () => void) => {
        if (used) throw new Error("此钉钉操作已提交，请勿重试。");
        used = true;
        const output = decode(await run(command, beforeDispatch));
        return { content: [{ type: "text", text: JSON.stringify(output) }] };
      },
    };
  };
  const active = async () => (await account.view()).state === "connected";
  return {
    list: async () =>
      (await active())
        ? [...catalog].map(([name, tool]) => ({
            name,
            description: `钉钉：${tool.label}`,
            inputSchema: {
              type: "object",
              properties: tool.properties,
              required: tool.required,
              additionalProperties: false,
            },
          }))
        : [],
    describe: async (names) => {
      const entries = new Map();
      if (await active())
        for (const name of names) {
          const tool = catalog.get(name);
          if (tool !== undefined)
            entries.set(name, {
              title: `钉钉：${tool.label}`,
              toolkit: TOOLKIT,
              hints: {
                readOnly: !tool.write,
                create: tool.write,
                update: false,
                destructive: false,
              },
            });
        }
      return entries;
    },
    preflight: prepare,
    call: async (name, args) => {
      if (catalog.get(name)?.write !== false) throw new Error(UNAVAILABLE);
      return (await prepare(name, args)).execute();
    },
  };
}
