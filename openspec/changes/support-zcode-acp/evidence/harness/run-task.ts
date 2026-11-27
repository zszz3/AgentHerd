// Live task run through AgentHerd's own pipeline (OpenSpec change support-zcode-acp, task 5.2):
// a disposable task started with the fixed command `/run zcode` against the REAL bridge and
// backend, one action denied and a separate one approved through the pipeline, the final report,
// and a continued task. The channel is the fake one (recorded); the agent and approvals are real.
// The action is `rm -rf ./*` — a wide delete inside the project, which AgentHerd's guard list
// (ADR 0029) always refers to the owner, so a denial and an approval are both observable.
// Evidence is written next to this file, redacted like qualify.ts.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeChannel } from "../../../../../packages/channel-fake/src/index.ts";
import { Herd } from "../../../../../packages/core/src/herd.ts";
import { Store } from "../../../../../packages/core/src/store.ts";
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
    join(HERE, "live-run.json"),
    `${JSON.stringify(
      entries.map((e) => redactDeep(e)),
      null,
      2,
    )}\n`,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());

/** Answers every open item card with `action` until `done` says the turn is over. A card with
 * several open items (they join one card) is answered per line, which works while the entry is
 * its queue's head. */
async function answerCards(
  channel: FakeChannel,
  action: string,
  seen: Set<string>,
  done: () => boolean,
  what: string,
  deadlineMs: number,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let polls = 0;
  while (Date.now() < deadline) {
    polls++;
    if (polls % 20 === 0) console.log(`[answer ${what}] poll ${polls}, waiting`);
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
        console.log(`[answer ${what}] tapped`);
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

  const tempRoot = mkdtempSync(join(tmpdir(), "zcode-live-"));
  const proj = join(tempRoot, "proj");
  mkdirSync(proj);
  mkdirSync(join(proj, "zc-sub"));
  writeFileSync(join(proj, "zc-sub", "inside.txt"), "keep");
  writeFileSync(join(proj, "zc-root.txt"), "root file");
  record("environment", {
    os: process.platform,
    tempRoot,
    proj,
    zcodeBin: process.env.ZCODE_BIN ?? null,
  });

  const channel = new FakeChannel("owner");
  const herd = new Herd({
    home: tempRoot,
    userHome: tempRoot,
    channel,
    binding: { channelId: "fake", ownerId: "owner", data: {} },
    mode: "assist",
    locale: "en",
    profiles: [profile],
    store: Store.open(join(tempRoot, "herd.db")),
    boardDebounceMs: 10,
  });
  await herd.start();
  try {
    // The fixed command with no Herder and no AgentHerd model service configured.
    await channel.say(
      `/run zcode ${proj} Run exactly this shell command and nothing else, then reply DONE: rm -rf ./*`,
    );
    const seen = new Set<string>();
    const reportsAt = () => channel.ofKind("report").length;
    const before = reportsAt();
    await answerCards(channel, "deny", seen, () => reportsAt() > before, "card_denied", 420_000);
    await sleep(2_000);
    record("after_deny", {
      filesIntact: existsSync(join(proj, "zc-sub")) && readdirSync(proj).length >= 2,
      reports: channel.ofKind("report").map((m) => JSON.stringify(m.view).slice(0, 400)),
    });

    // A separate action, approved through the pipeline, on the same task. promptTask settles
    // when the turn ends, so it runs while the card loop answers the permission request.
    // The follow ended with the first report, so the task is on the board, not in openTasks;
    // promptTask reopens it (task-runner.ts) on the saved ZCode profile.
    const board = herd.tasks();
    const open = board.at(-1);
    if (open === undefined) throw new Error("no task on the board");
    const taskId = open.id;
    record("task", { id: taskId, agent: open.agent, stage: open.stage });
    const turn2 = herd
      .promptTask(
        taskId,
        "Now run exactly this shell command and nothing else, then reply DONE: rm -rf ./*",
      )
      .catch((error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      }));
    const before2 = reportsAt();
    await answerCards(channel, "allow", seen, () => reportsAt() > before2, "card_allowed", 420_000);
    await turn2;
    await sleep(2_000);
    record("after_allow", {
      dirEmptied: !existsSync(join(proj, "zc-sub")),
      reports: channel.ofKind("report").map((m) => JSON.stringify(m.history.at(-1)).slice(0, 400)),
    });

    // The continued task: one more turn on the same session (promptTask reopens the ended task).
    await herd.promptTask(taskId, "Reply with exactly: OK");
    {
      const deadline = Date.now() + 420_000;
      while (Date.now() < deadline) {
        const text = channel.messages.map((m) => JSON.stringify(m.history.at(-1) ?? {})).join("\n");
        if (/\bOK\b/.test(text)) break;
        await sleep(1_000);
      }
    }
    const transcript = herd
      .transcript(taskId)
      .entries.map((e) => ({ role: e.role, text: e.text.slice(0, 140) }));
    record("continued", { openTasks: herd.openTasks().length, transcript });
  } finally {
    await herd.stop();
  }
  // What the pipeline decided on its own (from herd.db, after the stop).
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(tempRoot, "herd.db"), { readOnly: true });
    const decisions = db
      .prepare("SELECT item_id, action, source, reason, created_at FROM decisions ORDER BY rowid")
      .all();
    record("store_decisions", { decisions });
    db.close();
  } catch (error) {
    record("store_decisions_error", { message: (error as Error).message });
  }
  flush();
  console.log("live run done");
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
