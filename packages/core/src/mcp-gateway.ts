// The core side of the agent MCP gateway (docs/spec/09-agent-tools.md §1–§2). The host carries
// JSON-RPC lines between an agent's relay script and `handle`; the token says which task speaks.

import { randomBytes } from "node:crypto";
import type { AppHints, ReportState } from "@agentherd/protocol";
import type { AppCall } from "./app-calls.ts";
import { ACK_WORDS_MAX, OWNER_WORDS_MAX, tooLong } from "./owner-text.ts";

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** A token no task holds (never given out, or revoked when the task ended). */
export class UnknownTokenError extends Error {
  constructor() {
    super("unknown task token");
    this.name = "UnknownTokenError";
  }
}

/** docs/spec/04-herder.md §2 */
export interface HerdReport {
  state: ReportState;
  summary: string;
  changes?: string[];
  tests?: string[];
  risks?: string[];
  links?: string[];
}

export const REPORT_SUMMARY_MAX = 600;
const STATES: readonly ReportState[] = [
  "progress",
  "waiting",
  "ready",
  "blocked",
  "failed",
  "dropped",
];
const LISTS = ["changes", "tests", "risks", "links"] as const;
const VERSIONS = ["2025-06-18", "2025-03-26"];

const stringList = { type: "array", items: { type: "string" } };

export const HERD_REPORT_TOOL = {
  name: "herd_report",
  description:
    "Tell AgentHerd (and the owner) where this task stands. Call it when you finish, get stuck, " +
    "need the owner, or give up. state: progress | waiting (need the owner) | ready (done) | " +
    "blocked | failed | dropped. summary: one or two plain sentences and at most " +
    `${OWNER_WORDS_MAX} words: the result and what the owner has to do, not the steps (details go ` +
    "in changes, tests, risks, links). A longer summary is refused. AgentHerd's Herder reads it " +
    "with your reply and tells the owner in its own words; " +
    "waiting, blocked and failed reach the owner at once. If you end your turn while work you " +
    "started still runs in the background (a build, a test run, a subagent), call it with state " +
    "progress last: AgentHerd then checks back with you later instead of reporting the task done.",
  inputSchema: {
    type: "object",
    properties: {
      state: { type: "string", enum: [...STATES] },
      summary: { type: "string", maxLength: REPORT_SUMMARY_MAX },
      changes: stringList,
      tests: stringList,
      risks: stringList,
      links: stringList,
    },
    required: ["state", "summary"],
    additionalProperties: false,
  },
} as const;

export const ACK_MAX = 200;

export const HERD_ACK_TOOL = {
  name: "herd_ack",
  description:
    "Tell the owner in one short line what you are about to do, before you start real work on " +
    'a new request (e.g. "Running the core tests, then fixing what fails"). It is sent as a ' +
    `reply to their message. At most once per turn and ${ACK_WORDS_MAX} words. Not for progress ` +
    "or results: use herd_report for those.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", maxLength: ACK_MAX } },
    required: ["text"],
    additionalProperties: false,
  },
} as const;

/** The report, or why it is not one. */
export function parseReport(input: unknown): HerdReport | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "arguments must be an object";
  }
  const v = input as Record<string, unknown>;
  if (typeof v.state !== "string" || !STATES.includes(v.state as ReportState)) {
    return `state must be one of ${STATES.join(", ")}`;
  }
  if (typeof v.summary !== "string" || v.summary.trim() === "") return "summary is required";
  const long = tooLong(v.summary.trim());
  if (long !== undefined) return `summary ${long}`;
  const report: HerdReport = {
    state: v.state as ReportState,
    summary: v.summary.slice(0, REPORT_SUMMARY_MAX),
  };
  for (const key of LISTS) {
    const list = v[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || !list.every((x) => typeof x === "string")) {
      return `${key} must be a list of strings`;
    }
    report[key] = list;
  }
  return report;
}

const toolText = (text: string, isError = false) => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

/** An MCP tool as tools/list shows it. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** What AgentHerd knows about one app tool (docs/spec/09-agent-tools.md §3). */
export interface AppToolInfo {
  title: string;
  toolkit: string;
  hints?: AppHints;
}

export interface ExactApprovalPreview {
  readonly text: string;
  /** Unserialized fields for the redaction check only; never stored or sent. */
  readonly source: readonly string[];
}

export type AppToolPreflight = {
  /** Runs with the exact arguments validated during preflight. */
  execute: (beforeDispatch?: () => void) => Promise<unknown>;
} & (
  | { approvalArguments: unknown; exactApproval?: never }
  | {
      approvalArguments?: never;
      exactApproval: {
        preview: ExactApprovalPreview;
        expiresAt: number;
        cancel(): void;
        signal?: AbortSignal;
      };
    }
);

/** The owner's connected apps, as the gateway uses them. */
export interface AppToolAttempt {
  readonly signal: AbortSignal;
  /** One opaque identity per actual prompt. */
  readonly key: object;
}

export interface AppTools {
  list(): Promise<McpTool[]>;
  /** Titles and hints of app tools by slug; unknown slugs are missing from the map. */
  describe(slugs: readonly string[]): Promise<Map<string, AppToolInfo>>;
  /** Validates a call before approval. Returns undefined for tools without preflight. */
  preflight?(
    name: string,
    args: unknown,
    attempt?: AppToolAttempt,
  ): AppToolPreflight | undefined | Promise<AppToolPreflight | undefined>;
  /** Runs one tool; the answer is an MCP tools/call result. */
  call(name: string, args: unknown): Promise<unknown>;
}

export interface GatewayOptions {
  /** The connected apps now, if any. */
  apps?: () => AppTools | undefined;
  /** Throws if an explicit deny must prevent a provider preflight from running. */
  checkPreflight?: (taskId: string, call: AppCall) => void;
  /** Whether the calls may run (the approval pipeline, maybe the owner). */
  approve?: (taskId: string, calls: AppCall[]) => Promise<boolean>;
  approveExact?: (
    taskId: string,
    call: AppCall,
    preview: ExactApprovalPreview,
    expiresAt: number,
    signal: AbortSignal,
  ) => Promise<"allow" | "refused" | "closed">;
  /** Tool error text for calls the owner did not allow. */
  denied?: (title: string) => string;
  /** Sends an agent's `herd_ack` line to the owner; returns why it was not sent. */
  ack?: (taskId: string, text: string) => string | undefined;
}

/** Meta tools that only search or describe tools: no approval. */
export const DIRECT_META = new Set(["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS"]);
export const MULTI_EXECUTE = "COMPOSIO_MULTI_EXECUTE_TOOL";
export const MIJIA_LIST = "mijia_list_devices";
export const MIJIA_STATUS = "mijia_get_device_status";
export const MIJIA_CAPABILITIES = "mijia_list_controls";
export const MIJIA_SCENES = "mijia_list_scenes";
export const MIJIA_SET_PROPERTY = "mijia_set_property";
export const MIJIA_RUN_ACTION = "mijia_run_action";
export const MIJIA_RUN_SCENE = "mijia_run_scene";
const MIJIA_WRITES = new Set([MIJIA_SET_PROPERTY, MIJIA_RUN_ACTION, MIJIA_RUN_SCENE]);
export const MIJIA_TOOLS: readonly string[] = Object.freeze([
  MIJIA_LIST,
  MIJIA_STATUS,
  MIJIA_CAPABILITIES,
  MIJIA_SCENES,
  ...MIJIA_WRITES,
]);
/** Meta tools agents never see: connections are the owner's, and code runs stay local. */
export const HIDDEN_META = new Set([
  "COMPOSIO_MANAGE_CONNECTIONS",
  "COMPOSIO_REMOTE_WORKBENCH",
  "COMPOSIO_REMOTE_BASH_TOOL",
  "COMPOSIO_PROXY_EXECUTE",
  "COMPOSIO_WAIT_FOR_CONNECTIONS",
]);

/** The slugs a call runs, or why it cannot be read. */
export function slugsOf(name: string, args: unknown): string[] | string {
  if (name !== MULTI_EXECUTE) return [name];
  const tools = (args as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return "tools must be a non-empty list";
  const slugs: string[] = [];
  for (const t of tools) {
    const slug = (t as { tool_slug?: unknown } | null)?.tool_slug;
    if (typeof slug !== "string" || slug === "") return "each tool needs a tool_slug";
    slugs.push(slug);
  }
  return slugs;
}

function argumentsOf(name: string, args: unknown, index: number): unknown {
  if (name !== MULTI_EXECUTE) return args;
  const tools = (args as { tools: { arguments?: unknown }[] }).tools;
  return tools[index]?.arguments;
}

export class McpGateway {
  private readonly tasks = new Map<string, string>();
  private readonly tokens = new Map<string, string>();
  private readonly ownerAttempts = new Map<string, AbortController>();

  /** TaskRunner calls this only around the actual first ACP prompt. */
  beginOwnerAttempt(taskId: string, controller: AbortController): () => void {
    const end = () => {
      if (this.ownerAttempts.get(taskId) === controller) this.ownerAttempts.delete(taskId);
      controller.abort();
    };
    if (!this.tokens.has(taskId) || controller.signal.aborted) return end;
    this.ownerAttempts.get(taskId)?.abort();
    this.ownerAttempts.set(taskId, controller);
    return end;
  }
  private readonly onReport: (taskId: string, report: HerdReport) => void;
  private readonly opts: GatewayOptions;

  constructor(onReport: (taskId: string, report: HerdReport) => void, opts: GatewayOptions = {}) {
    this.onReport = onReport;
    this.opts = opts;
  }

  /** A new token for the task; an older one stops working. */
  register(taskId: string): string {
    this.revoke(taskId);
    const token = randomBytes(32).toString("hex");
    this.tasks.set(token, taskId);
    this.tokens.set(taskId, token);
    return token;
  }

  revoke(taskId: string): void {
    const attempt = this.ownerAttempts.get(taskId);
    this.ownerAttempts.delete(taskId);
    attempt?.abort();
    const token = this.tokens.get(taskId);
    if (token === undefined) return;
    this.tokens.delete(taskId);
    this.tasks.delete(token);
  }

  taskOf(token: string): string | undefined {
    return this.tasks.get(token);
  }

  /**
   * The answer to one message, `undefined` for notifications and stray responses. Throws
   * UnknownTokenError at once for a token no task holds.
   */
  handle(token: string, msg: JsonRpcMessage): Promise<JsonRpcMessage | undefined> {
    const taskId = this.tasks.get(token);
    if (taskId === undefined) throw new UnknownTokenError();
    return this.answer(taskId, msg);
  }

  private async answer(taskId: string, msg: JsonRpcMessage): Promise<JsonRpcMessage | undefined> {
    const id = msg.id;
    if (msg.method === undefined || id === undefined || id === null) return undefined;
    const answer = (result: unknown): JsonRpcMessage => ({ jsonrpc: "2.0", id, result });
    const params = (msg.params ?? {}) as Record<string, unknown>;
    switch (msg.method) {
      case "initialize": {
        const asked = params.protocolVersion;
        return answer({
          protocolVersion:
            typeof asked === "string" && VERSIONS.includes(asked) ? asked : VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "agentherd", version: "1" },
        });
      }
      case "ping":
        return answer({});
      case "tools/list":
        return answer({
          tools: [
            HERD_REPORT_TOOL,
            ...(this.opts.ack === undefined ? [] : [HERD_ACK_TOOL]),
            ...(await this.appList()),
          ],
        });
      case "tools/call": {
        if (params.name === HERD_ACK_TOOL.name && this.opts.ack !== undefined) {
          const text = (params.arguments as { text?: unknown } | undefined)?.text;
          if (typeof text !== "string" || text.trim() === "") {
            return answer(toolText("text is required", true));
          }
          const why = this.opts.ack(taskId, text.trim().slice(0, ACK_MAX));
          return answer(why === undefined ? toolText("sent") : toolText(why, true));
        }
        if (params.name !== HERD_REPORT_TOOL.name) {
          return answer(await this.callApp(taskId, params.name, params.arguments));
        }
        const report = parseReport(params.arguments);
        if (typeof report === "string") return answer(toolText(report, true));
        this.onReport(taskId, report);
        return answer(toolText("reported"));
      }
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `method not found: ${msg.method}` },
        };
    }
  }

  private async appList(): Promise<McpTool[]> {
    const apps = this.opts.apps?.();
    if (apps === undefined) return [];
    try {
      const tools = await apps.list();
      return tools.filter(
        (t) =>
          t.name !== HERD_REPORT_TOOL.name &&
          t.name !== HERD_ACK_TOOL.name &&
          !HIDDEN_META.has(t.name),
      );
    } catch {
      return [];
    }
  }

  private async callMijiaWrite(
    taskId: string,
    apps: AppTools,
    name: string,
    args: unknown,
  ): Promise<unknown> {
    const controller = this.ownerAttempts.get(taskId);
    const { approveExact, checkPreflight } = this.opts;
    const notSent = () => toolText(JSON.stringify({ state: "not-sent", reason: "blocked" }), true);
    if (controller === undefined || controller.signal.aborted) {
      return toolText(
        "Mi Home writes require the first active task prompt from a live owner message.",
        true,
      );
    }
    if (approveExact === undefined || checkPreflight === undefined) return notSent();
    const call = {
      slug: name,
      title: "Mi Home control",
      toolkit: "builtin:mijia",
      arguments: undefined,
    };
    const check = () => {
      if (controller.signal.aborted || this.ownerAttempts.get(taskId) !== controller)
        throw new Error("Mi Home task prompt is no longer current");
      checkPreflight(taskId, call);
    };
    let exact: AppToolPreflight["exactApproval"];
    try {
      check();
      const prepared = await apps.preflight?.(name, args, {
        key: controller,
        signal: controller.signal,
      });
      exact = prepared?.exactApproval;
      if (prepared === undefined || exact === undefined) return notSent();
      check();
      if ((await apps.describe([name])).get(name)?.toolkit !== call.toolkit) return notSent();
      check();
      const signal =
        exact.signal === undefined
          ? controller.signal
          : AbortSignal.any([controller.signal, exact.signal]);
      if (signal.aborted) return notSent();
      const approval = await approveExact(taskId, call, exact.preview, exact.expiresAt, signal);
      if (approval === "refused")
        return toolText(
          this.opts.denied?.(call.title) ?? "The owner did not allow Mi Home control.",
          true,
        );
      if (approval !== "allow" || signal.aborted) return notSent();
      check();
      return await prepared.execute(() => {
        if (signal.aborted) throw new Error("Mi Home approval expired or was cancelled");
        check();
      });
    } catch {
      return notSent();
    } finally {
      exact?.cancel();
    }
  }

  private async callApp(taskId: string, name: unknown, args: unknown): Promise<unknown> {
    const apps = this.opts.apps?.();
    if (typeof name !== "string" || apps === undefined || HIDDEN_META.has(name)) {
      return toolText(`unknown tool ${String(name)}`, true);
    }
    if (MIJIA_WRITES.has(name)) return this.callMijiaWrite(taskId, apps, name, args);
    try {
      let prepared: AppToolPreflight | undefined;
      let beforeDispatch: (() => void) | undefined;
      if (!DIRECT_META.has(name)) {
        const slugs = slugsOf(name, args);
        if (typeof slugs === "string") return toolText(slugs, true);
        // Built-in office slugs have one separator, unlike plugin namespaces (`WECOM__`).
        const reserved = slugs.some((slug) => /^dingtalk_[a-z0-9]/i.test(slug))
          ? { label: "DingTalk", toolkit: "builtin:dingtalk" }
          : slugs.some((slug) => /^WECOM_[A-Z0-9]/.test(slug))
            ? { label: "WeCom", toolkit: "builtin:wecom" }
            : slugs.some((slug) => MIJIA_TOOLS.includes(slug))
              ? { label: "Mi Home", toolkit: "builtin:mijia" }
              : undefined;
        if (name === MULTI_EXECUTE && reserved !== undefined) {
          return toolText(`${reserved.label} tools must be called directly.`, true);
        }
        if (name !== MULTI_EXECUTE && apps.preflight !== undefined) {
          if (reserved !== undefined) {
            this.opts.checkPreflight?.(taskId, {
              slug: name,
              title: reserved.label,
              toolkit: reserved.toolkit,
              arguments: undefined,
            });
          }
          prepared = await apps.preflight(name, args);
          if (prepared?.exactApproval !== undefined) {
            prepared.exactApproval.cancel();
            return toolText("Exact approval is unavailable for this call.", true);
          }
        }
        if (prepared === undefined && reserved !== undefined) {
          return toolText(`${reserved.label} CLI tool is unavailable.`, true);
        }
        const known = await apps.describe(slugs);
        if (reserved !== undefined && known.get(name)?.toolkit !== reserved.toolkit) {
          return toolText(`${reserved.label} CLI tool is unavailable.`, true);
        }
        const calls: AppCall[] = slugs.map((slug, i) => {
          const info = known.get(slug);
          return {
            slug,
            title: info?.title ?? slug,
            toolkit: info?.toolkit ?? slug.split("_")[0]?.toLowerCase() ?? slug,
            ...(info?.hints === undefined ? {} : { hints: info.hints }),
            arguments:
              prepared === undefined ? argumentsOf(name, args, i) : prepared.approvalArguments,
          };
        });
        if (prepared === undefined) {
          for (const slug of slugs) {
            const toolkit = known.get(slug)?.toolkit;
            if (toolkit === "builtin:wecom")
              return toolText("WeCom CLI tool is unavailable.", true);
            if (toolkit === "builtin:dingtalk")
              return toolText("DingTalk CLI tool is unavailable.", true);
          }
        }
        const approve = this.opts.approve ?? (async () => false);
        if (!(await approve(taskId, calls))) {
          const title = calls.map((c) => c.title).join(", ");
          return toolText(this.opts.denied?.(title) ?? `The owner did not allow ${title}.`, true);
        }
        const call = calls[0];
        if (reserved?.toolkit === "builtin:dingtalk" && call !== undefined) {
          beforeDispatch = () => this.opts.checkPreflight?.(taskId, call);
        }
      }
      return prepared === undefined
        ? await apps.call(name, args)
        : await prepared.execute(beforeDispatch);
    } catch (error) {
      return toolText(`app call failed: ${(error as Error).message}`, true);
    }
  }
}
