// Live Herder dispatch through AgentHerd's own pipeline (OpenSpec change support-zcode-acp,
// task 5.2): the owner asks in natural language, an explicitly configured Herder starts the
// task on the ZCode profile through the REAL task runner, bridge and backend; the permission
// card is answered through the pipeline; then the Herder continues the ended task
// (session_prompt reopens it, ADR 0039). The channel is the fake one (recorded) and the
// Herder's model is a scripted faux provider — this machine has no Herder model service, so
// the natural-language choice itself stays covered by the Herder tool tests (recorded there).
// What is real here: the Herder loop and its tools, the profile selection, the bridge, the
// backend, the approval pipeline, the report and the reopen. Evidence next to this file,
// redacted like qualify.ts.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeChannel } from "../../../../../packages/channel-fake/src/index.ts";
import { Herd } from "../../../../../packages/core/src/herd.ts";
import { Store } from "../../../../../packages/core/src/store.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  streamSimple,
} from "../../../../../packages/herder/node_modules/@earendil-works/pi-ai/dist/compat.js";
import { Herder } from "../../../../../packages/herder/src/herder.ts";
import { agentDef, agentProfile } from "../../../../../packages/host/src/catalog.ts";
import { agentEnv, findAgent } from "../../../../../packages/host/src/profiles.ts";
import { redactDeep } from "./lib.ts";

const HERE = import.meta.dirname ?? ".";

const entries: { t: number; kind: string; data: unknown }[] = [];
const started = Date.now();
function record(kind: string, data: unknown): void {
  entries.push({ t: Date.now() - started, kind, data });
  flush();
}
function flush(): void {
  writeFileSync(
    join(HERE, "herder-run.json"),
    `${JSON.stringify(
      entries.map((e) => redactDeep(e)),
      null,
      2,
    )}\n`,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());

/** Answers every open item card with `action` until `done` says the turn is over. */
async function answerCards(
  channel: FakeChannel,
  action: string,
  seen: Set<string>,
  done: () => boolean,
  what: string,
  deadlineMs: number,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    for (const m of channel.ofKind("item")) {
      const view = m.view as {
        itemId?: string;
        title?: string;
        body?: string;
        lines?: { itemId: string; options?: { action: string }[] }[];
      };
      const targets: string[] = [];
      if (view.lines !== undefined && view.lines.length > 0) {
        for (const line of view.lines) {
          if ((line.options?.length ?? 0) > 0 && !seen.has(line.itemId)) {
            targets.push(line.itemId);
          }
        }
      } else if (view.itemId !== undefined && !seen.has(view.itemId)) {
        targets.push(view.itemId);
      }
      for (const id of targets) {
        seen.add(id);
        console.log(`[answer ${what}] tapping ${id} with ${action}`);
        record(what, { title: view.title, body: view.body, target: id });
        await channel.tap(id, action);
      }
    }
    if (done()) return;
    await sleep(500);
  }
  record("answer_timeout", { what });
}

async function main(): Promise<void> {
  const def = agentDef("zcode");
  const bin = findAgent("zcode");
  if (def === undefined || bin === undefined) throw new Error("zcode bridge not found");
  const profile = agentProfile(def, bin, agentEnv("zcode"));
  record("profile", {
    command: profile.command,
    mode: profile.mode,
    ownModels: profile.ownModels === true,
    envKeys: Object.keys(profile.env),
    zcodeBinSet: (profile.env.ZCODE_BIN ?? "") !== "",
  });

  const tempRoot = mkdtempSync(join(tmpdir(), "zcode-herder-"));
  const proj = join(tempRoot, "proj");
  mkdirSync(proj);
  record("environment", {
    os: process.platform,
    tempRoot,
    proj,
    zcodeBin: process.env.ZCODE_BIN ?? null,
    // The Herder configuration for this run: an explicit Herder (below) whose model is a
    // scripted faux provider, and an empty AgentHerd model-service list.
    herderModel: "scripted faux provider (registerFauxProvider), not a live model service",
    modelServiceList: "empty",
  });

  const faux = registerFauxProvider();
  const channel = new FakeChannel("owner");
  let herder: Herder | undefined;
  const herd = new Herd({
    home: tempRoot,
    userHome: tempRoot,
    channel,
    binding: { channelId: "fake", ownerId: "owner", data: {} },
    mode: "assist",
    locale: "en",
    profiles: [profile],
    agentModels: {
      list: () => [],
      launchFor: () => ({ env: {} }),
      check: async () => ({ ok: true }),
    },
    store: Store.open(join(tempRoot, "herd.db")),
    boardDebounceMs: 10,
    herder: (host) => {
      herder = new Herder({ host, model: faux.getModel(), streamFn: streamSimple });
      return herder;
    },
  });
  await herd.start();
  try {
    if (herder === undefined) throw new Error("no herder");
    const reportsAt = () => channel.ofKind("report").length;

    // The owner asks in natural language; the Herder must start it on the ZCode profile.
    const ask1 = `Please use ZCode for this task: in ${proj} run exactly this shell command and nothing else, then reply DONE: echo herd-zcode-herder`;
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("session_start", {
            name: "ZCode echo",
            project: proj,
            profile: "zcode",
            ownerText: ask1,
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Handed to ZCode."),
      fauxAssistantMessage("ZCode finished."), // the Herder tells the result (ADR 0053)
    ]);
    const seen = new Set<string>();
    const before = reportsAt();
    await channel.say(ask1);
    const board1 = () => herd.tasks();
    const taskAppeared = new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (board1().length > 0) {
          clearInterval(timer);
          resolve();
        }
      }, 500);
      setTimeout(() => {
        clearInterval(timer);
        resolve();
      }, 120_000).unref();
    });
    await taskAppeared;
    const boardTask = board1().at(-1);
    if (boardTask === undefined) throw new Error("no task started");
    record("task_started", {
      id: boardTask.id,
      agent: boardTask.agent,
      title: boardTask.title,
    });
    await answerCards(channel, "allow", seen, () => reportsAt() > before, "card_allowed", 420_000);
    const idleWait = () => herder?.idle() ?? Promise.resolve();
    const reportWait = (count: number) =>
      new Promise<void>((resolve) => {
        const deadline = Date.now() + 420_000;
        const timer = setInterval(() => {
          if (reportsAt() > count || Date.now() > deadline) {
            clearInterval(timer);
            resolve();
          }
        }, 500);
      });
    await reportWait(before);
    await idleWait();
    record("after_task", {
      reports: channel.ofKind("report").map((m) => JSON.stringify(m.view).slice(0, 400)),
    });

    // The continued task: the Herder messages the ended task; session_prompt reopens it on the
    // saved ZCode profile (the recovery path through the Herder).
    const ask2 = "Ask ZCode to reply with exactly: OK";
    const current = herd.tasks().at(-1);
    if (current === undefined) throw new Error("task disappeared");
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("session_prompt", {
            task: current.id,
            text: "Reply with exactly: OK",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Asked ZCode."),
      fauxAssistantMessage("ZCode replied OK."),
    ]);
    const before2 = reportsAt();
    await channel.say(ask2);
    await reportWait(before2);
    await idleWait();
    await sleep(2_000);
    const transcript = herd
      .transcript(current.id)
      .entries.map((e) => ({ role: e.role, text: e.text.slice(0, 140) }));
    record("continued", {
      reports: channel.ofKind("report").map((m) => JSON.stringify(m.history.at(-1)).slice(0, 400)),
      transcript,
    });
  } finally {
    await herd.stop();
    faux.unregister();
  }
  // What the pipeline and the Herder decided on their own (from herd.db, after the stop).
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(tempRoot, "herd.db"), { readOnly: true });
    const decisions = db
      .prepare("SELECT item_id, action, source, reason, created_at FROM decisions ORDER BY rowid")
      .all();
    record("store_decisions", { decisions });
    const herderAudits = db
      .prepare("SELECT kind, data_json FROM audit WHERE kind LIKE 'herder%' ORDER BY rowid")
      .all();
    record("herder_audits", { herderAudits });
    db.close();
  } catch (error) {
    record("store_read_error", { message: (error as Error).message });
  }
  flush();
  console.log("herder live run done");
  process.exit(0);
}

// A silent death must still leave evidence: log every crash path and flush.
for (const event of ["unhandledRejection", "uncaughtException"] as const) {
  process.on(event, (error: unknown) => {
    console.error(event, error);
    record("fatal", {
      event,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? (error.stack ?? "").slice(0, 2000) : undefined,
    });
    flush();
    process.exit(1);
  });
}
// Hard stop: never spin past 25 minutes; the evidence so far is flushed by then.
setTimeout(() => {
  record("watchdog_exit", { entries: entries.length });
  flush();
  console.error("watchdog exit");
  process.exit(1);
}, 25 * 60_000).unref();

main().catch((error) => {
  record("fatal", { message: error instanceof Error ? error.message : String(error) });
  flush();
  console.error(error);
  process.exitCode = 1;
});
