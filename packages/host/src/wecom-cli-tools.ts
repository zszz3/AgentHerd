import type { AppToolInfo, AppTools, McpTool } from "@agentherd/core";
import { redact } from "@agentherd/rules";

const TOOLKIT = "builtin:wecom";
const DISCOVERY_FAILED = "WeCom CLI tool discovery failed.";
const CALL_FAILED = "WeCom CLI tool call failed.";
const UNAVAILABLE = "WeCom CLI tool is unavailable.";
const INVALID_ARGUMENTS = "Invalid WeCom CLI tool arguments.";

// These are the reviewed CLI 1.3.4 methods, not a claim about tenant grants.
// Do not infer safety from verbs: even a get can trigger local file handling.
const READ_ONLY = new Set([
  "calendar.schedules.free.list",
  "calendar.schedules.get",
  "calendar.schedules.list",
  "calendar.schedules.search",
  "contact.users.search",
  "disk.files.get",
  "disk.files.list",
  "disk.files.search",
  "doc.search",
  "mail.search",
  "meeting.get",
  "meeting.list",
  "meeting.search",
  "meeting.rooms.buildings.list",
  "meeting.rooms.search",
  "message.aibot.sessions.list",
  "todo.get",
  "todo.list",
]);
const CREATE = new Set([
  "calendar.schedules.create",
  "disk.folders.create",
  "doc.create",
  "mail.send",
  "meeting.create",
  "message.send",
  "message.aibot.send",
  "todo.create",
]);
const UPDATE = new Set([
  "calendar.schedules.update",
  "disk.files.rename",
  "doc.contents.append",
  "doc.contents.overwrite",
  "doc.members.update",
  "doc.names.update",
  "doc.rules.update",
  "meeting.update",
  "todo.finish",
  "todo.update",
]);
const DESTRUCTIVE = new Set([
  "calendar.schedules.cancel",
  "doc.contents.overwrite",
  "meeting.cancel",
  "todo.delete",
]);
const REVIEWED = new Set([...READ_ONLY, ...CREATE, ...UPDATE, ...DESTRUCTIVE]);
const TARGET_FIELDS = new Set([
  "chat_id",
  "userid",
  "user_id",
  "userids",
  "to",
  "to_user",
  "touser",
  "cc",
  "bcc",
  "schedule_id",
  "meeting_id",
  "meeting_code",
  "room_id",
  "todo_id",
  "docid",
  "doc_id",
  "fileid",
  "file_id",
  "spaceid",
  "space_id",
  "fatherid",
  "parent_id",
  "target_id",
  "subject",
  "title",
  "summary",
  "topic",
  "name",
  "doc_name",
  "file_name",
  "new_name",
  "start_time",
  "end_time",
  "due_time",
]);

function approvalTargets(args: RecordValue): RecordValue {
  const targets: RecordValue = {};
  const display = (value: unknown): number | string | undefined => {
    if (typeof value === "number") return value;
    if (typeof value !== "string") return undefined;
    const text = redact(value).replace(/\s+/g, " ").trim();
    return text.length > 96 ? `${text.slice(0, 95)}…` : text;
  };
  for (const [key, value] of Object.entries(args)) {
    if (!TARGET_FIELDS.has(key)) continue;
    if (Object.keys(targets).length === 8) break;
    if (Array.isArray(value)) {
      const first = value
        .slice(0, 3)
        .map(display)
        .filter((v) => v !== undefined);
      if (first.length) targets[key] = first;
    } else {
      const shown = display(value);
      if (shown !== undefined) targets[key] = shown;
    }
  }
  return targets;
}
const SESSION_LIST = "message.aibot.sessions.list";
const SERVICE_NAMES = new Map([
  ["calendar", "日历"],
  ["contact", "通讯录"],
  ["disk", "微盘"],
  ["doc", "文档"],
  ["mail", "邮件"],
  ["meeting", "会议"],
  ["message", "消息"],
  ["todo", "待办"],
]);
// Keep inline office data, not local files, sort scripts, or the nested doc.create edit DSL.
const OMITTED_FIELDS = new Map<string, ReadonlySet<string>>([
  ["doc.create", new Set(["file_path", "doc_requests", "fields", "grid_data"])],
  ["doc.search", new Set(["sort_script"])],
  ["doc.contents.overwrite", new Set(["file_path"])],
  ["mail.send", new Set(["file_path", "attachments[].file_path", "inline_images[].file_path"])],
]);

// The CLI extracts unknown top-level JSON keys as flags (including output and
// output_dir). Do not pass arbitrary keys, even where the CLI schema is open.
const FORBIDDEN_FIELD =
  /^(?:_|--|.*(?:^|_)(?:file_path|local_path|output(?:_dir|_path)?|credential[s]?|(?:access|refresh)_token|(?:client|app)_secret|api_key)$)/i;
const ARG_KEY = /^[a-zA-Z][a-zA-Z0-9_]*$/;
// Translate this exact 1.3.4 Rust pattern, whose escaped quote is invalid in JS Unicode mode.
const RUST_FILENAME_PATTERN = String.raw`^[^/\\\\:\\*\\?\"<>\\|]+$`;
const FILENAME_PATTERN = String.raw`^[^/\\:*?"<>|]+$`;
const ARG_SCHEMA_KEYS = new Set([
  "$ref",
  "type",
  "description",
  "format",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
]);
const ARG_TYPES = new Set(["object", "array", "string", "integer", "number", "boolean", "null"]);
const LIMITS = ["minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength"] as const;
const MAX_ARGV_LENGTH = 24_000; // Leave room for Windows command-line escaping and the executable path.
const MAX_SCHEMA_DEPTH = 32;

interface InputSchema {
  type: string;
  description?: string;
  format?: string;
  properties?: Record<string, InputSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: InputSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? (value as RecordValue) : undefined;
}

function unsupported(): never {
  throw new Error(DISCOVERY_FAILED);
}

function schemaRecord(value: unknown): RecordValue {
  return record(value) ?? unsupported();
}

function lookup(definitions: RecordValue, ref: unknown): unknown {
  if (typeof ref !== "string" || !Object.hasOwn(definitions, ref)) unsupported();
  return definitions[ref];
}

function responseIsDataOnly(
  raw: unknown,
  definitions: RecordValue,
  visited = new Set<unknown>(),
  depth = 0,
): void {
  if (visited.has(raw)) return; // Response schemas may be recursive.
  if (depth > MAX_SCHEMA_DEPTH) unsupported();
  const schema = schemaRecord(raw);
  visited.add(raw);
  if (Object.keys(schema).some((key) => key.startsWith("x-wecom-"))) unsupported();
  const visit = (child: unknown) => responseIsDataOnly(child, definitions, visited, depth + 1);
  if (schema.$ref !== undefined) visit(lookup(definitions, schema.$ref));
  if (schema.properties !== undefined)
    Object.values(schemaRecord(schema.properties)).forEach(visit);
  if (schema.items !== undefined) visit(schema.items);
  if (record(schema.additionalProperties)) visit(schema.additionalProperties);
  for (const key of ["anyOf", "allOf", "oneOf"]) {
    const alternatives = schema[key];
    if (Array.isArray(alternatives)) alternatives.forEach(visit);
  }
}

function inputSchema(
  raw: unknown,
  definitions: RecordValue,
  omitted: ReadonlySet<string> | undefined,
  path = "",
  depth = 0,
): InputSchema {
  if (depth > MAX_SCHEMA_DEPTH) unsupported();
  const schema = schemaRecord(raw);
  if (Object.keys(schema).some((key) => !ARG_SCHEMA_KEYS.has(key))) unsupported();
  if (schema.$ref !== undefined) {
    // The CLI emits both {$ref} and {type, description, $ref}.
    if (
      Object.keys(schema).some((key) => key !== "$ref" && key !== "type" && key !== "description")
    )
      unsupported();
    const resolved = inputSchema(
      lookup(definitions, schema.$ref),
      definitions,
      omitted,
      path,
      depth + 1,
    );
    if (schema.type !== undefined && schema.type !== resolved.type) unsupported();
    return typeof schema.description === "string"
      ? { ...resolved, description: schema.description }
      : resolved;
  }
  const type = schema.type;
  if (typeof type !== "string" || !ARG_TYPES.has(type)) unsupported();
  const result: InputSchema = { type };
  if (typeof schema.description === "string") result.description = schema.description;
  if (typeof schema.format === "string") result.format = schema.format;
  for (const key of LIMITS) {
    const value = schema[key];
    if (value === undefined) continue;
    // Some upstream identifier strings carry a numeric bound. It does not constrain a string.
    if (type === "string" && (key === "minimum" || key === "maximum")) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) unsupported();
    result[key] = value;
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") unsupported();
    result.pattern = schema.pattern === RUST_FILENAME_PATTERN ? FILENAME_PATTERN : schema.pattern;
    new RegExp(result.pattern, "u");
  }
  if (schema.enum !== undefined) {
    if (
      !Array.isArray(schema.enum) ||
      schema.enum.some((item) => item !== null && typeof item === "object")
    )
      unsupported();
    result.enum = schema.enum;
  }
  if (type === "object") {
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== false)
      unsupported();
    const properties = schema.properties === undefined ? {} : schemaRecord(schema.properties);
    const required = schema.required === undefined ? [] : schema.required;
    if (
      !Array.isArray(required) ||
      required.some((key) => typeof key !== "string" || !Object.hasOwn(properties, key))
    )
      unsupported();
    result.properties = {};
    result.additionalProperties = false;
    if (required.length) result.required = required;
    for (const [key, child] of Object.entries(properties)) {
      const childPath = path ? `${path}.${key}` : key;
      if (omitted?.has(childPath)) {
        if (required.includes(key)) unsupported();
        continue;
      }
      if (!ARG_KEY.test(key) || FORBIDDEN_FIELD.test(key) || Object.hasOwn(Object.prototype, key))
        unsupported();
      result.properties[key] = inputSchema(child, definitions, omitted, childPath, depth + 1);
    }
  } else if (type === "array") {
    result.items = inputSchema(schema.items, definitions, omitted, `${path}[]`, depth + 1);
  }
  return result;
}

function invalidArguments(): never {
  throw new Error(INVALID_ARGUMENTS);
}

// Create a fresh JSON value, rather than serializing the caller's object and
// potentially invoking accessors or a toJSON method after checking its fields.
function checkedValue(schema: InputSchema, value: unknown): unknown {
  if (schema.enum && !schema.enum.includes(value)) invalidArguments();
  switch (schema.type) {
    case "object": {
      const input = record(value) ?? invalidArguments();
      const props = schema.properties!;
      if (schema.required?.some((key) => !Object.hasOwn(input, key))) invalidArguments();
      const clean: RecordValue = Object.create(null);
      for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== "string" || !Object.hasOwn(props, key)) invalidArguments();
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) invalidArguments();
        clean[key] = checkedValue(props[key]!, descriptor.value);
      }
      return clean;
    }
    case "array": {
      if (
        !Array.isArray(value) ||
        value.length < (schema.minItems ?? 0) ||
        value.length > (schema.maxItems ?? MAX_ARGV_LENGTH) ||
        Reflect.ownKeys(value).length !== value.length + 1
      )
        invalidArguments();
      const clean: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, i);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) invalidArguments();
        clean.push(checkedValue(schema.items!, descriptor.value));
      }
      return clean;
    }
    case "string": {
      if (typeof value !== "string" || value.length > MAX_ARGV_LENGTH) invalidArguments();
      const length = [...value].length;
      if (
        length < (schema.minLength ?? 0) ||
        length > (schema.maxLength ?? Infinity) ||
        (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value))
      )
        invalidArguments();
      return value;
    }
    case "integer":
    case "number":
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (schema.type === "integer" && !Number.isSafeInteger(value)) ||
        value < (schema.minimum ?? -Infinity) ||
        value > (schema.maximum ?? Infinity)
      )
        invalidArguments();
      return value;
    default:
      if (
        (value === null && schema.type === "null") ||
        (typeof value === "boolean" && schema.type === "boolean")
      )
        return value;
      return invalidArguments();
  }
}

function recentSessions(result: unknown): unknown {
  const data = record(result);
  if (!Array.isArray(data?.sessions)) return { sessions: [], sessions_count: 0 };
  const sessions = data.sessions.slice(0, 20).flatMap((value) => {
    const session = record(value);
    if (!session || typeof session.chat_id !== "string") return [];
    const { chat_id, chat_name, chat_type, last_msg_time } = session;
    return [
      {
        chat_id,
        chat_name: typeof chat_name === "string" ? chat_name : undefined,
        chat_type: chat_type === "single" || chat_type === "group" ? chat_type : undefined,
        last_msg_time: typeof last_msg_time === "string" ? last_msg_time : undefined,
      },
    ];
  });
  return { sessions, sessions_count: sessions.length };
}

interface Entry {
  readonly method: string;
  readonly hasRequest: boolean;
  readonly schema: InputSchema;
  readonly tool: McpTool;
  readonly info: AppToolInfo;
}

type Run = (args: readonly string[], signal?: AbortSignal) => Promise<unknown>;
interface Capability {
  id: string;
  name: string;
  toolCount: number;
}
type PreparedCall = NonNullable<Awaited<ReturnType<NonNullable<AppTools["preflight"]>>>>;
export interface WecomCliCatalog extends AppTools {
  readonly capabilities: Capability[];
  preflight(name: string, args: unknown): PreparedCall;
}

/** Discover the local, built-in office catalog. Business permissions are checked by WeCom on each call. */
export async function discoverWecomCliTools(
  run: Run,
  signal?: AbortSignal,
): Promise<WecomCliCatalog> {
  const entries = new Map<string, Entry>();
  const capabilities = new Map<string, Capability>();
  const discover = (args: string[]) => {
    signal?.throwIfAborted();
    return signal ? run(args, signal) : run(args);
  };
  try {
    const catalog = await discover(["schema", "list"]);
    if (!Array.isArray(catalog)) unsupported();
    for (const rawService of catalog) {
      const service = schemaRecord(rawService);
      const id = service.name;
      if (typeof id !== "string" || !Array.isArray(service.methods)) unsupported();
      const serviceName = SERVICE_NAMES.get(id);
      if (!serviceName) continue;
      for (const rawMethod of service.methods) {
        const item = schemaRecord(rawMethod);
        const method = item.name;
        if (
          typeof method !== "string" ||
          !method.startsWith(`${service.name}.`) ||
          !REVIEWED.has(method)
        )
          continue;
        const name = `WECOM_${method.toUpperCase().replaceAll(".", "_")}`;
        if (entries.has(name)) continue;
        const rawDetail = await discover(["schema", "get", method]);
        // An unsupported or unsafe schema excludes this method, not the other services.
        try {
          const detail = schemaRecord(rawDetail);
          if (detail.method !== method) unsupported();
          const definitions = schemaRecord(detail.schemas);
          responseIsDataOnly(detail.response, definitions);
          const hasRequest = detail.request !== undefined;
          const schema = inputSchema(
            hasRequest ? detail.request : { type: "object" },
            definitions,
            OMITTED_FIELDS.get(method),
          );
          if (
            schema.type !== "object" ||
            (method === SESSION_LIST && Object.keys(schema.properties!).length)
          )
            unsupported();
          const description =
            typeof detail.description === "string"
              ? detail.description
              : typeof item.description === "string"
                ? item.description
                : method;
          entries.set(name, {
            method,
            schema,
            hasRequest,
            tool: { name, description, inputSchema: schema },
            info: {
              toolkit: TOOLKIT,
              title: `企业微信: ${method}`,
              hints: {
                readOnly: READ_ONLY.has(method),
                create: CREATE.has(method),
                update: UPDATE.has(method),
                destructive: DESTRUCTIVE.has(method),
              },
            },
          });
        } catch {
          continue;
        }
        const current = capabilities.get(id);
        if (current) current.toolCount++;
        else capabilities.set(id, { id, name: serviceName, toolCount: 1 });
      }
    }
    signal?.throwIfAborted();
  } catch {
    throw new Error(DISCOVERY_FAILED);
  }

  const preflight = (name: string, args: unknown): PreparedCall => {
    const entry = entries.get(name);
    if (!entry) throw new Error(UNAVAILABLE);
    let json: string;
    let approvalArguments: unknown;
    try {
      const checked = checkedValue(entry.schema, args) as RecordValue;
      json = JSON.stringify(checked);
      if (json.length + (json.match(/["\\]/g)?.length ?? 0) > MAX_ARGV_LENGTH) invalidArguments();
      // Only show bounded, redacted target fields for writes, never body or attachment data.
      approvalArguments = {
        targets: READ_ONLY.has(entry.method) ? {} : approvalTargets(checked),
        fields: Object.keys(checked),
        listSizes: Object.fromEntries(
          Object.entries(checked).flatMap(([key, value]) =>
            Array.isArray(value) ? [[key, value.length]] : [],
          ),
        ),
      };
    } catch {
      throw new Error(INVALID_ARGUMENTS);
    }
    const argv = entry.method.split(".");
    if (entry.hasRequest) argv.push("--json", json);
    return {
      approvalArguments,
      execute: async () => {
        try {
          const result = await run(argv);
          const data = record(result);
          if (data && Object.hasOwn(data, "errcode") && data.errcode !== 0)
            throw new Error(CALL_FAILED);
          const output = entry.method === SESSION_LIST ? recentSessions(result) : result;
          return { content: [{ type: "text", text: JSON.stringify(output) ?? "null" }] };
        } catch {
          throw new Error(CALL_FAILED);
        }
      },
    };
  };
  return {
    capabilities: [...capabilities.values()],
    list: async () => [...entries.values()].map(({ tool }) => structuredClone(tool)),
    describe: async (names) =>
      new Map(
        names.flatMap((name) => {
          const entry = entries.get(name);
          return entry ? [[name, structuredClone(entry.info)]] : [];
        }),
      ),
    preflight,
    call: async (name, args) => preflight(name, args).execute(),
  };
}
