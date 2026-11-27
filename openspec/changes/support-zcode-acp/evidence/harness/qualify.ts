// Qualification harness for OpenSpec change support-zcode-acp (tasks 1.1-1.3).
// Starts the owner-installed zcode-acp bridge with AgentHerd's client capabilities in a
// disposable project, exercises mode setting and approval, and writes redacted JSON evidence
// next to this file. Run from the repo root: pnpm exec tsx <this file>.
// It writes no secrets: paths under the user home and the temp root, e-mail addresses and
// token-like strings are redacted before anything is saved.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, release as osRelease, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
// The SDK comes through acp-client's own dependency link, so this file needs no install of its
// own (the package's exports do not resolve from outside a workspace package).
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type SessionNotification,
} from "../../../../../packages/acp-client/node_modules/@agentclientprotocol/sdk/dist/v1/stable/acp.js";
import { commandLine, killTree } from "../../../../../packages/acp-client/src/command.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

// ---------- redaction ----------

const HOME = homedir();
const TEMP = tmpdir();

function redact(text: string): string {
  return text
    .split(HOME)
    .join("~")
    .split(TEMP)
    .join("%TEMP%")
    .replaceAll(/(?:sk|key|token|secret)[_-][A-Za-z0-9_-]{12,}/gi, "<token>")
    .replaceAll(/[\w.+-]+@[\w.-]+\.\w+/g, "<email>");
}

function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out;
  }
  return value;
}

// ---------- evidence ----------

interface Entry {
  case: string;
  t: number;
  kind: string;
  data: unknown;
}

const entries: Entry[] = [];
let currentCase = "";
let caseStart = 0;

function record(kind: string, data: unknown): void {
  entries.push({ case: currentCase, t: Date.now() - caseStart, kind, data });
  flush();
}

function flush(): void {
  writeFileSync(
    join(HERE, `run-${RUN_STAMP}.json`),
    `${JSON.stringify(
      entries.map((e) => redactDeep(e)),
      null,
      2,
    )}\n`,
  );
}

// ---------- bridge discovery ----------

/** Finds a command on PATH with Windows PATHEXT, like the host's commandCandidates: on Windows
 * only a name with an extension runs (npm's extensionless sh shim must not be picked). */
function findOnPath(name: string): string | undefined {
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";");
  for (const dir of (process.env.PATH ?? "").split(";")) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext.toLowerCase()}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const BRIDGE = findOnPath("zcode-acp");
if (BRIDGE === undefined) throw new Error("zcode-acp not found on PATH");

/** The bridge package version, read from its npm shim target. */
function bridgeVersion(): string {
  const line = commandLine(BRIDGE, []);
  const script = line.args[0];
  if (script === undefined) return "unknown";
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(script), "..", "package.json"), "utf8"));
    return String(pkg.version ?? "unknown");
  } catch {
    return "unknown";
  }
}

const BRIDGE_VERSION = bridgeVersion();

// ---------- the minimal AgentHerd-shaped ACP client ----------

type Decision = "allow" | "deny";

interface StepOutcome {
  stopReason?: string;
  timeout?: boolean;
  [key: string]: unknown;
}

/** Every session/update of the current connection (cleared per case). */
const updates: SessionNotification[] = [];

async function withConnection(
  envSet: Record<string, string | null>,
  proj: string,
  body: (agent: {
    request: (method: string, params: unknown, ms?: number) => Promise<unknown>;
    notify: (method: string, params: unknown) => void;
  }) => Promise<void>,
): Promise<{ agentVersion: string | undefined; stderr: string[]; error: string | undefined }> {
  updates.length = 0;
  const env = { ...process.env };
  for (const [k, v] of Object.entries(envSet)) {
    if (v === null) delete env[k];
    else env[k] = v;
  }
  const line = commandLine(BRIDGE, ["server"]);
  const child = spawn(line.command, line.args, {
    cwd: proj,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...(line.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  const stderrLines: string[] = [];
  child.stdin?.on("error", () => {});
  child.on("error", (error) => {
    stderrLines.push(`spawn error: ${error.message}`);
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    for (const l of chunk.split("\n")) {
      if (l.trim() !== "") stderrLines.push(l.replace(/\r$/, ""));
    }
    if (stderrLines.length > 400) stderrLines.splice(0, stderrLines.length - 400);
  });

  let unexpected = 0;

  const app = client({ name: "agentherd" })
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params);
      record("update", summarizeUpdate(params));
    })
    .onRequest(
      methods.client.session.requestPermission,
      ({ params }: { params: RequestPermissionRequest }) => {
        const decision = pendingTurnDecision;
        pendingTurnDecision = "none";
        if (decision === "none") {
          unexpected++;
          record("permission_unexpected", summarizePermission(params));
        } else {
          record("permission", { decision, ...summarizePermission(params) });
        }
        return Promise.resolve({
          outcome: pickOutcome(decision === "allow" ? "allow" : "deny", params.options ?? []),
        });
      },
    );

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin as Writable) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout as Readable) as ReadableStream<Uint8Array>,
  );
  const connection = app.connect(stream);
  const agent = connection.agent;

  let agentVersion: string | undefined;
  let error: string | undefined;
  try {
    const init = (await timed(
      "initialize",
      agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "agentherd", version: "0.0.0" },
      }),
      30_000,
    )) as {
      agentInfo?: { version?: string };
      authMethods?: { id: string; name: string }[];
      agentCapabilities?: Record<string, unknown>;
    };
    agentVersion = init.agentInfo?.version;
    record("initialize", {
      agentVersion,
      authMethods: init.authMethods ?? [],
      capabilityKeys: Object.keys(init.agentCapabilities ?? {}),
    });
    await body({
      request: (method: string, params: unknown, ms = 30_000) =>
        timed(method, agent.request(method, params as never), ms),
      notify: (method: string, params: unknown) => agent.notify(method as never, params as never),
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    record("error", { message: error });
  } finally {
    if (unexpected > 0) record("unexpected_permission_count", { count: unexpected });
    connection.close();
    if (child.exitCode === null && child.signalCode === null) killTree(child, "SIGKILL");
    record("stderr_tail", { lines: stderrLines.slice(-40) });
  }
  return { agentVersion, stderr: stderrLines.slice(-40), error };
}

/** Race a request against a timeout so a stuck bridge cannot hang the run. */
function timed<T>(label: string, p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}: timeout after ${ms}ms`)), ms).unref(),
    ),
  ]);
}

/** AgentHerd's mapping: allow takes only allow_once, deny takes reject_once then reject_always. */
function pickOutcome(
  decision: Decision,
  options: { optionId: string; kind: string }[],
): { outcome: "selected"; optionId: string } | { outcome: "cancelled" } {
  const kinds = decision === "allow" ? ["allow_once"] : ["reject_once", "reject_always"];
  for (const kind of kinds) {
    const option = options.find((o) => o.kind === kind);
    if (option !== undefined) return { outcome: "selected", optionId: option.optionId };
  }
  return { outcome: "cancelled" };
}

function summarizePermission(params: RequestPermissionRequest): unknown {
  return {
    sessionId: params.sessionId,
    toolCallId: params.toolCall?.toolCallId,
    toolCallTitle: params.toolCall?.title,
    toolCallKind: params.toolCall?.kind,
    rawInput: params.toolCall?.rawInput,
    content: params.toolCall?.content,
    locations: params.toolCall?.locations,
    options: (params.options ?? []).map((o) => ({
      optionId: o.optionId,
      kind: o.kind,
      name: o.name,
    })),
  };
}

function summarizeUpdate(n: SessionNotification): unknown {
  const u = n.update as Record<string, unknown> | undefined;
  if (u === undefined) return { sessionId: n.sessionId };
  switch (u.sessionUpdate) {
    case "agent_message_chunk": {
      const c = u.content as { text?: string } | undefined;
      return { sessionId: n.sessionId, sessionUpdate: u.sessionUpdate, text: c?.text ?? "" };
    }
    case "tool_call":
    case "tool_call_update":
      return {
        sessionId: n.sessionId,
        sessionUpdate: u.sessionUpdate,
        toolCallId: u.toolCallId,
        title: u.title,
        kind: u.kind,
        status: u.status,
        rawInput: u.rawInput,
      };
    case "current_mode_update":
      return {
        sessionId: n.sessionId,
        sessionUpdate: u.sessionUpdate,
        currentModeId: u.currentModeId,
      };
    case "config_option_update": {
      const options =
        (u.configOptions as { id?: string; currentValue?: unknown }[] | undefined) ?? [];
      return {
        sessionId: n.sessionId,
        sessionUpdate: u.sessionUpdate,
        options: options.map((o) => ({ id: o.id, currentValue: o.currentValue })),
      };
    }
    default:
      return { sessionId: n.sessionId, sessionUpdate: u.sessionUpdate };
  }
}

/** Resolves with the first current_mode_update for the session after `from`, or null after ms. */
async function waitModeUpdate(sessionId: string, ms: number): Promise<string | null> {
  const from = updates.length;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    for (const n of updates.slice(from)) {
      const u = n.update as { sessionUpdate?: string; currentModeId?: string } | undefined;
      if (u?.sessionUpdate === "current_mode_update" && n.sessionId === sessionId) {
        return String(u.currentModeId ?? "");
      }
    }
    await new Promise((r) => setTimeout(r, 50).unref());
  }
  return null;
}

/** Decision for the permission request of the current turn; consumed once. Shared with the
 * active connection's request handler because turns are sequential. */
let pendingTurnDecision: Decision | "none" = "none";

/** Sends a prompt and resolves when the turn ends; notifies session/cancel on timeout. */
async function promptTurn(
  agent: {
    request: (m: string, p: unknown, ms?: number) => Promise<unknown>;
    notify: (m: string, p: unknown) => void;
  },
  sessionId: string,
  decision: Decision | "none",
  text: string,
  ms: number,
): Promise<StepOutcome> {
  pendingTurnDecision = decision;
  const timer = setTimeout(() => {
    agent.notify(methods.agent.session.cancel, { sessionId });
  }, ms);
  timer.unref();
  try {
    const res = (await agent.request(
      methods.agent.session.prompt,
      { sessionId, prompt: [{ type: "text", text }] },
      ms + 5_000,
    )) as {
      stopReason?: string;
    };
    return { stopReason: res.stopReason };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
    pendingTurnDecision = "none";
  }
}

interface NewSessionResult {
  sessionId: string;
  modes?: unknown;
  configOptions?: { id?: string; currentValue?: unknown }[];
  _meta?: unknown;
}

async function openAndGuard(
  agent: { request: (m: string, p: unknown, ms?: number) => Promise<unknown> },
  proj: string,
): Promise<NewSessionResult> {
  const created = (await agent.request(methods.agent.session.new, {
    cwd: proj,
    mcpServers: [],
  })) as NewSessionResult;
  const modeOption = (created.configOptions ?? []).find((o) => o.id === "mode");
  record("session_new", {
    sessionId: created.sessionId,
    modes: created.modes,
    reportedMode: modeOption?.currentValue,
    configOptionIds: (created.configOptions ?? []).map((o) => o.id),
    meta: created._meta,
  });
  // set_mode before the first prompt. The reported mode in session/new is the bridge's
  // default and is NOT treated as confirmation; only a current_mode_update after the
  // set_mode request that equals the requested mode counts.
  const wait = waitModeUpdate(created.sessionId, 20_000);
  const set = await agent.request(methods.agent.session.setMode, {
    sessionId: created.sessionId,
    modeId: "guarded",
  });
  record("set_mode_response", set);
  const confirmed = await wait;
  record("mode_confirmation", { requested: "guarded", confirmed });
  if (confirmed !== "guarded") {
    throw new Error(
      `mode not confirmed: requested guarded, confirmed ${JSON.stringify(confirmed)}`,
    );
  }
  return created;
}

// ---------- main ----------

async function main(): Promise<void> {
  const tempRoot = mkdtempSync(join(tmpdir(), "zcode-qual-"));
  const proj = join(tempRoot, "proj");
  mkdirSync(proj);
  mkdirSync(join(proj, "zc-sub"));
  writeFileSync(join(proj, "zc-sub", "zc-inside.txt"), "keep me");
  mkdirSync(join(proj, "zc-sub2"));
  writeFileSync(join(proj, "zc-sub2", "zc-inside2.txt"), "keep me too");
  record("environment", {
    os: `${process.platform} ${osRelease()}`,
    node: process.version,
    bridgeCommand: BRIDGE,
    bridgeVersion: BRIDGE_VERSION,
    zcodeBinInUserEnv: process.env.ZCODE_BIN ?? null,
    zcodeNodeInUserEnv: process.env.ZCODE_NODE ?? null,
    zcodeAcpModeInUserEnv: process.env.ZCODE_ACP_MODE ?? null,
    tempRoot,
    proj,
  });

  // --- Case A: automatic discovery, no ZCODE_BIN and no ZCODE_NODE ---
  currentCase = "A-auto";
  caseStart = Date.now();
  await withConnection({ ZCODE_BIN: null, ZCODE_NODE: null }, proj, async (agent) => {
    const created = await openAndGuard(agent, proj);
    // First real backend operation: a harmless file inside the workspace.
    const turn = await promptTurn(
      agent,
      created.sessionId,
      "none",
      "Create a file named zc-a.txt in the current directory containing exactly: hello. Then reply DONE.",
      180_000,
    );
    record("turn_file_in_workspace", {
      ...turn,
      fileExists: existsSync(join(proj, "zc-a.txt")),
      content: existsSync(join(proj, "zc-a.txt"))
        ? readFileSync(join(proj, "zc-a.txt"), "utf8")
        : null,
    });
  });
  console.log("case A done");
  flush();

  // --- Case B: explicit override (production-like on this machine) ---
  currentCase = "B-override";
  caseStart = Date.now();
  await withConnection(
    {
      ZCODE_BIN: process.env.ZCODE_BIN ?? "",
      ZCODE_NODE: process.env.ZCODE_NODE ?? "",
    },
    proj,
    async (agent) => {
      const created = await openAndGuard(agent, proj);
      // Approval: a write outside the workspace. First denied, a separate one allowed.
      await promptTurn(
        agent,
        created.sessionId,
        "deny",
        `Write a text file at ${join(tempRoot, "zc-outside1.txt")} containing exactly: outside. That path is outside the current workspace on purpose. Then reply DONE.`,
        240_000,
      );
      record("after_outside_deny", { fileExists: existsSync(join(tempRoot, "zc-outside1.txt")) });
      await promptTurn(
        agent,
        created.sessionId,
        "allow",
        `Write a text file at ${join(tempRoot, "zc-outside2.txt")} containing exactly: outside. That path is outside the current workspace on purpose. Then reply DONE.`,
        240_000,
      );
      record("after_outside_allow", {
        fileExists: existsSync(join(tempRoot, "zc-outside2.txt")),
        content: existsSync(join(tempRoot, "zc-outside2.txt"))
          ? readFileSync(join(tempRoot, "zc-outside2.txt"), "utf8")
          : null,
      });
      // A dangerous-looking mass delete on a disposable directory: denied first.
      await promptTurn(
        agent,
        created.sessionId,
        "deny",
        "Run exactly this shell command and nothing else, then reply DONE: cmd /c del /f /s /q zc-sub",
        240_000,
      );
      record("after_command_deny", { dirStillExists: existsSync(join(proj, "zc-sub")) });
      // A second dangerous command on another disposable directory: allowed.
      await promptTurn(
        agent,
        created.sessionId,
        "allow",
        "Run exactly this shell command and nothing else, then reply DONE: cmd /c del /f /s /q zc-sub2",
        240_000,
      );
      record("after_command_allow", { dirDeleted: !existsSync(join(proj, "zc-sub2")) });
      // External-action tool coverage: a harmless network read.
      const web = await promptTurn(
        agent,
        created.sessionId,
        "none",
        "If you have a web or fetch tool, fetch https://example.com and reply with only the page title. If you have no such tool, reply NO-WEB-TOOL.",
        240_000,
      );
      record("turn_external_tool", { ...web });
    },
  );
  console.log("case B done");
  flush();

  // --- Case C: load and replacement on the same profile ---
  currentCase = "C-load";
  caseStart = Date.now();
  await withConnection(
    {
      ZCODE_BIN: process.env.ZCODE_BIN ?? "",
      ZCODE_NODE: process.env.ZCODE_NODE ?? "",
    },
    proj,
    async (agent) => {
      const created = await openAndGuard(agent, proj);
      await promptTurn(agent, created.sessionId, "none", "Reply with exactly: OK", 120_000);
      record("saved_session_id", { sessionId: created.sessionId });
    },
  );
  const savedId = (() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.case === "C-load" && e.kind === "saved_session_id") {
        return (e.data as { sessionId: string }).sessionId;
      }
    }
    return undefined;
  })();
  if (savedId !== undefined) {
    // Reconnect and load the saved session, then re-establish the mode before any prompt.
    await withConnection(
      {
        ZCODE_BIN: process.env.ZCODE_BIN ?? "",
        ZCODE_NODE: process.env.ZCODE_NODE ?? "",
      },
      proj,
      async (agent) => {
        const wait = waitModeUpdate(savedId, 20_000);
        try {
          const loaded = await agent.request(methods.agent.session.load, {
            sessionId: savedId,
            cwd: proj,
            mcpServers: [],
          });
          record("load_response", loaded);
        } catch (e) {
          record("load_error", { message: e instanceof Error ? e.message : String(e) });
          throw e;
        }
        const loadedMode = await wait;
        record("load_reported_mode", { mode: loadedMode });
        const waitAfterLoad = waitModeUpdate(savedId, 20_000);
        const set = await agent.request(methods.agent.session.setMode, {
          sessionId: savedId,
          modeId: "guarded",
        });
        record("set_mode_response_after_load", set);
        const confirmed = await waitAfterLoad;
        record("mode_confirmation_after_load", { requested: "guarded", confirmed });
        if (confirmed !== "guarded") {
          throw new Error(
            `mode after load not confirmed: requested guarded, confirmed ${JSON.stringify(confirmed)}`,
          );
        }
        const turn = await promptTurn(agent, savedId, "none", "Reply with exactly: OK", 120_000);
        record("turn_after_load", { ...turn });
      },
    );
    // Failed load: an unknown session id must fail without a usable session.
    await withConnection(
      {
        ZCODE_BIN: process.env.ZCODE_BIN ?? "",
        ZCODE_NODE: process.env.ZCODE_NODE ?? "",
      },
      proj,
      async (agent) => {
        try {
          await agent.request(methods.agent.session.load, {
            sessionId: "zc-qual-missing-session",
            cwd: proj,
            mcpServers: [],
          });
          record("load_missing_unexpected_success", {});
        } catch (e) {
          record("load_missing_failed", { message: e instanceof Error ? e.message : String(e) });
        }
        // Replacement: a fresh session on the same profile, prepared the same way.
        const created = await openAndGuard(agent, proj);
        record("replacement_session", { sessionId: created.sessionId });
      },
    );
  }
  console.log("case C done");
  flush();

  // --- Case D: a backend override that does not exist ---
  currentCase = "D-missing-backend";
  caseStart = Date.now();
  await withConnection(
    {
      ZCODE_BIN: join(tempRoot, "no-such-zcode.cjs"),
    },
    proj,
    async (agent) => {
      const created = (await agent.request(methods.agent.session.new, {
        cwd: proj,
        mcpServers: [],
      })) as NewSessionResult;
      record("session_new_lazy", { sessionId: created.sessionId });
      try {
        const set = await agent.request(
          methods.agent.session.setMode,
          {
            sessionId: created.sessionId,
            modeId: "guarded",
          },
          45_000,
        );
        record("set_mode_unexpected_success", set);
      } catch (e) {
        record("set_mode_failed_no_backend", {
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
  );
  console.log("case D done");
  flush();

  record("run_end", { cases: [...new Set(entries.map((e) => e.case))] });
  flush();
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // The disposable project stays in %TEMP% when Windows still holds a handle.
  }
  console.log(`done; ${entries.length} entries -> run-${RUN_STAMP}.json`);
}

main().catch((error) => {
  record("fatal", { message: error instanceof Error ? error.message : String(error) });
  flush();
  console.error(error);
  process.exitCode = 1;
});
