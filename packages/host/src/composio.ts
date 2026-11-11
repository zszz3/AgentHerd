// A small Composio client without the SDK (docs/spec/09-agent-tools.md §3): the REST calls the
// app settings need, and a streamable-HTTP MCP client for a tool-router session's mcp.url.

import type { McpTool } from "@agentherd/core";
import type { AppHints } from "@agentherd/protocol";

export const COMPOSIO_API = "https://backend.composio.dev/api/v3.1";
const MCP_VERSION = "2025-06-18";
const MAX_PAGES = 4;

export class ComposioError extends Error {
  readonly status: number;
  readonly slug: string | undefined;
  constructor(message: string, status: number, slug?: string) {
    super(message);
    this.name = "ComposioError";
    this.status = status;
    this.slug = slug;
  }
}

export interface ComposioToolkit {
  slug: string;
  name: string;
  logo?: string;
  description?: string;
  noAuth: boolean;
  /** The owner's connected account for this toolkit, if any (status ACTIVE when usable). */
  account?: { id: string; status: string };
}

export interface ComposioTool {
  slug: string;
  name: string;
  toolkit: string;
  toolkitName: string;
  tags: string[];
}

export interface ComposioClient {
  /** Throws ComposioError for a bad key. */
  checkKey(): Promise<void>;
  createSession(
    userId: string,
    toolkits: readonly string[],
  ): Promise<{ id: string; mcpUrl: string }>;
  toolkits(
    sessionId: string,
    opts?: { search?: string; connected?: boolean },
  ): Promise<ComposioToolkit[]>;
  link(sessionId: string, toolkit: string): Promise<{ url: string; accountId: string }>;
  account(id: string): Promise<{ status: string; toolkit: string }>;
  disconnect(accountId: string): Promise<void>;
  tool(slug: string): Promise<ComposioTool>;
}

type Fetch = typeof fetch;

async function request(
  fetchFn: Fetch,
  key: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(`${COMPOSIO_API}${path}`, {
      method,
      headers: {
        "x-api-key": key,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    throw new ComposioError(`Composio is not reachable: ${(error as Error).message}`, 0);
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text === "" ? {} : JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const err = (json as { error?: { message?: unknown; slug?: unknown } } | undefined)?.error;
    const message = typeof err?.message === "string" ? err.message : `HTTP ${res.status}`;
    throw new ComposioError(
      message,
      res.status,
      typeof err?.slug === "string" ? err.slug : undefined,
    );
  }
  if (json === undefined)
    throw new ComposioError("Composio sent something that is not JSON", res.status);
  return json;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

function toolkitOf(raw: unknown): ComposioToolkit | undefined {
  const t = raw as Record<string, unknown>;
  const slug = str(t.slug);
  if (slug === undefined) return undefined;
  const meta = (t.meta ?? {}) as Record<string, unknown>;
  const acc = t.connected_account as Record<string, unknown> | null | undefined;
  const logo = str(meta.logo);
  const description = str(meta.description);
  const id = str(acc?.id);
  return {
    slug,
    name: str(t.name) ?? slug,
    ...(logo === undefined ? {} : { logo }),
    ...(description === undefined ? {} : { description }),
    noAuth: t.is_no_auth === true,
    ...(id === undefined ? {} : { account: { id, status: str(acc?.status) ?? "UNKNOWN" } }),
  };
}

export function composioClient(key: string, fetchFn: Fetch = fetch): ComposioClient {
  const call = (method: string, path: string, body?: unknown) =>
    request(fetchFn, key, method, path, body);
  return {
    async checkKey() {
      // Not /auth/session/info: it refuses project keys ("Project API key is not allowed for this
      // endpoint"), which are the keys owners copy from the dashboard.
      await call("GET", "/toolkits?limit=1");
    },
    async createSession(userId, toolkits) {
      const body = {
        user_id: userId,
        ...(toolkits.length === 0 ? {} : { toolkits: { enable: [...toolkits] } }),
        manage_connections: { enable: false },
        workbench: { enable: false },
      };
      const res = (await call("POST", "/tool_router/session", body)) as {
        session_id?: unknown;
        mcp?: { url?: unknown };
      };
      const id = str(res.session_id);
      const mcpUrl = str(res.mcp?.url);
      if (id === undefined || mcpUrl === undefined) {
        throw new ComposioError("Composio did not return a session", 200);
      }
      return { id, mcpUrl };
    },
    async toolkits(sessionId, opts = {}) {
      const out: ComposioToolkit[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const q = new URLSearchParams({ limit: "50" });
        if (opts.search !== undefined && opts.search !== "") q.set("search", opts.search);
        if (opts.connected !== undefined) q.set("is_connected", String(opts.connected));
        if (cursor !== undefined) q.set("cursor", cursor);
        const path = `/tool_router/session/${encodeURIComponent(sessionId)}/toolkits?${q}`;
        const res = (await call("GET", path)) as { items?: unknown[]; next_cursor?: unknown };
        for (const raw of res.items ?? []) {
          const t = toolkitOf(raw);
          if (t !== undefined) out.push(t);
        }
        cursor = str(res.next_cursor);
        if (cursor === undefined) break;
      }
      return out;
    },
    async link(sessionId, toolkit) {
      const path = `/tool_router/session/${encodeURIComponent(sessionId)}/link`;
      const res = (await call("POST", path, { toolkit })) as {
        redirect_url?: unknown;
        connected_account_id?: unknown;
      };
      const url = str(res.redirect_url);
      const accountId = str(res.connected_account_id);
      if (url === undefined || accountId === undefined) {
        throw new ComposioError("Composio did not return a sign-in link", 200);
      }
      return { url, accountId };
    },
    async account(id) {
      const res = (await call("GET", `/connected_accounts/${encodeURIComponent(id)}`)) as {
        status?: unknown;
        toolkit?: { slug?: unknown };
      };
      return { status: str(res.status) ?? "UNKNOWN", toolkit: str(res.toolkit?.slug) ?? "" };
    },
    async disconnect(accountId) {
      await call("DELETE", `/connected_accounts/${encodeURIComponent(accountId)}`);
    },
    async tool(slug) {
      const res = (await call("GET", `/tools/${encodeURIComponent(slug)}`)) as {
        slug?: unknown;
        name?: unknown;
        toolkit?: { slug?: unknown; name?: unknown };
        tags?: unknown;
      };
      const toolkit = str(res.toolkit?.slug) ?? slug.split("_")[0]?.toLowerCase() ?? "";
      return {
        slug: str(res.slug) ?? slug,
        name: str(res.name) ?? slug,
        toolkit,
        toolkitName: str(res.toolkit?.name) ?? toolkit,
        tags: Array.isArray(res.tags)
          ? res.tags.filter((t): t is string => typeof t === "string")
          : [],
      };
    },
  };
}

/** Hints from a tool's tags; undefined when the tool has none of them. */
export function hintsOf(tags: readonly string[]): AppHints | undefined {
  const has = (t: string) => tags.includes(t);
  const hints: AppHints = {
    readOnly: has("readOnlyHint"),
    create: has("createHint"),
    update: has("updateHint"),
    destructive: has("destructiveHint"),
  };
  return hints.readOnly || hints.create || hints.update || hints.destructive ? hints : undefined;
}

export interface McpHttpClient {
  listTools(): Promise<McpTool[]>;
  /** The MCP tools/call result. */
  callTool(name: string, args: unknown): Promise<unknown>;
}

interface RpcReply {
  id?: unknown;
  result?: unknown;
  error?: { message?: string };
}

/** The reply with the given id from a JSON body or a text/event-stream body. */
function replyOf(contentType: string, text: string, id: number): RpcReply | undefined {
  const pick = (v: unknown): RpcReply | undefined => {
    const list = Array.isArray(v) ? v : [v];
    return list.find((m) => (m as RpcReply | null)?.id === id) as RpcReply | undefined;
  };
  if (!contentType.includes("text/event-stream")) {
    try {
      return pick(JSON.parse(text));
    } catch {
      return undefined;
    }
  }
  // SSE: events separated by blank lines; data lines of one event join with "\n".
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data === "") continue;
    try {
      const found = pick(JSON.parse(data));
      if (found !== undefined) return found;
    } catch {
      // not JSON; skip
    }
  }
  return undefined;
}

/**
 * A streamable-HTTP MCP client. Composio takes its key as `x-api-key`; the 小红书 server
 * AgentHerd runs takes a bearer token (`bearer: true`).
 */
export function mcpHttpClient(
  url: string,
  key: string,
  fetchFn: Fetch = fetch,
  bearer = false,
): McpHttpClient {
  let session: string | undefined;
  let ready: Promise<void> | undefined;
  let next = 1;

  const post = async (body: unknown): Promise<Response> => {
    try {
      return await fetchFn(url, {
        method: "POST",
        headers: {
          ...(bearer ? { authorization: `Bearer ${key}` } : { "x-api-key": key }),
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MCP_VERSION,
          ...(session === undefined ? {} : { "mcp-session-id": session }),
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new ComposioError(`Composio is not reachable: ${(error as Error).message}`, 0);
    }
  };

  const rpc = async (method: string, params: unknown): Promise<unknown> => {
    const id = next++;
    const res = await post({ jsonrpc: "2.0", id, method, params });
    const sid = res.headers.get("mcp-session-id");
    if (sid !== null && sid !== "") session = sid;
    const text = await res.text();
    if (!res.ok) {
      const err = new ComposioError(`Composio MCP answered HTTP ${res.status}`, res.status);
      throw err;
    }
    const reply = replyOf(res.headers.get("content-type") ?? "", text, id);
    if (reply === undefined) throw new ComposioError("Composio MCP sent no answer", res.status);
    if (reply.error !== undefined) {
      throw new ComposioError(reply.error.message ?? "Composio MCP error", res.status);
    }
    return reply.result;
  };

  const init = async () => {
    session = undefined;
    await rpc("initialize", {
      protocolVersion: MCP_VERSION,
      capabilities: {},
      clientInfo: { name: "agentherd", version: "1" },
    });
    // A notification gets 202 and no body.
    await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  };

  const withSession = async <T>(work: () => Promise<T>): Promise<T> => {
    ready ??= init().catch((error) => {
      ready = undefined;
      throw error;
    });
    await ready;
    try {
      return await work();
    } catch (error) {
      // An expired MCP session answers 404: start a new one, once.
      if (error instanceof ComposioError && error.status === 404 && session !== undefined) {
        ready = init();
        await ready;
        return await work();
      }
      throw error;
    }
  };

  return {
    listTools: () =>
      withSession(async () => {
        const res = (await rpc("tools/list", {})) as { tools?: McpTool[] };
        return res.tools ?? [];
      }),
    callTool: (name, args) => withSession(() => rpc("tools/call", { name, arguments: args ?? {} })),
  };
}
