// E2E for ADR 0108: a profile with a required permission mode (ZCode) prepares every session
// before work — `session/set_mode`, confirmed by the running session itself — before the first
// prompt, before a replay, and again on the replacement session. The owner's account choice
// survives recovery: ZCode is never an automatic substitute, and a ZCode task never falls back.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FakeChannel, type SentMessage } from "@agentherd/channel-fake";
import type { AgentProfile, ItemView, Mode, ReportView } from "@agentherd/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/clock.ts";
import { Herd } from "../../src/herd.ts";
import { Store } from "../../src/store.ts";

const MOCK_INDEX = fileURLToPath(new URL("../../../mock-agent/src/index.ts", import.meta.url));
const MOCK_SDK = fileURLToPath(
  new URL(
    "../../../mock-agent/node_modules/@agentclientprotocol/sdk/dist/v1/stable/acp.js",
    import.meta.url,
  ),
);
let herds: { herd: Herd; store: Store }[] = [];

afterEach(async () => {
  for (const o of herds) {
    await o.herd.stop();
    o.store.close();
  }
  herds = [];
});

/**
 * A mock agent whose diagnostics land in `log`: the wrapper mirrors mock-agent's CLI so the
 * tests can read the order of `mode`, `load` and `prompt` lines.
 */
function zcodeProfile(
  home: string,
  script: string,
  log: string,
  opts: { id?: string; plain?: boolean } = {},
): AgentProfile {
  const id = opts.id ?? "zcode";
  const scriptFile = join(home, `${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(scriptFile, script);
  const wrap = join(home, `${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    wrap,
    `import { appendFileSync, readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from ${JSON.stringify(pathToFileURL(MOCK_SDK).href)};
import { createMockAgent, parseScript } from ${JSON.stringify(pathToFileURL(MOCK_INDEX).href)};
const script = parseScript(readFileSync(${JSON.stringify(scriptFile)}, "utf8"));
const log = (line) => {
  appendFileSync(${JSON.stringify(log)}, line + "\\n");
  process.stderr.write("[mock-agent] " + line + "\\n");
};
const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);
const connection = createMockAgent(script, { log }).connect(stream);
await connection.closed;
`,
  );
  const profile: AgentProfile = {
    id,
    name: id === "zcode" ? "ZCode" : "Mock",
    command: [process.execPath, wrap],
    env: {},
    exporter: null,
  };
  if (opts.plain !== true) {
    profile.ownModels = true;
    profile.mode = "build";
  }
  return profile;
}

function logLines(log: string): string[] {
  try {
    return readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l !== "");
  } catch {
    return [];
  }
}

/** A Herd on `<home>/herd.db`, as after an AgentHerd start; a second boot sees the first's tasks. */
async function boot(
  home: string,
  profiles: AgentProfile[],
  opts: { mode?: Mode; clock?: FakeClock; modeConfirmTimeoutMs?: number } = {},
): Promise<{ herd: Herd; store: Store; channel: FakeChannel }> {
  const store = Store.open(join(home, "herd.db"));
  const channel = new FakeChannel("owner");
  const herd = new Herd({
    home,
    userHome: "/Users/me",
    channel,
    binding: { channelId: "fake", ownerId: "owner", data: {} },
    mode: opts.mode ?? "assist",
    locale: "en",
    profiles,
    store,
    boardDebounceMs: 10,
    ...(opts.clock === undefined ? {} : { clock: opts.clock }),
    ...(opts.modeConfirmTimeoutMs === undefined
      ? {}
      : { modeConfirmTimeoutMs: opts.modeConfirmTimeoutMs }),
  });
  const o = { herd, store, channel };
  herds.push(o);
  await herd.start();
  return o;
}

async function shutDown(o: { herd: Herd; store: Store }): Promise<void> {
  await o.herd.stop();
  o.store.close();
  herds = herds.filter((x) => x !== o);
}

const ONE_TURN = `
turns:
  - - message: "done"
    - end_turn: end_turn
`;

describe("session preparation before work (ADR 0108)", () => {
  it("confirms the profile's mode before the first prompt", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentherd-prepare-"));
    const log = join(home, "confirm.log");
    const { herd, channel } = await boot(home, [
      zcodeProfile(home, `set_mode: confirm\n${ONE_TURN}`, log),
    ]);
    const { taskId, turn } = await herd.startTask("zcode", home, "Fix it");
    expect((await turn).stopReason).toBe("end_turn");
    const order = logLines(log);
    expect(order).toContain("mode build");
    expect(order.findIndex((l) => l.startsWith("mode "))).toBeLessThan(
      order.findIndex((l) => l.startsWith("prompt ")),
    );
    const report = channel.ofKind("report").map((m) => m.view as ReportView)[0];
    expect(report?.subtitle).toContain("ZCode");
    expect(herd.tasks().find((t) => t.id === taskId)?.stage).toBe("done");
  });

  it("does not dispatch work when the session refuses the mode", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentherd-prepare-"));
    const log = join(home, "refuse.log");
    const { herd, channel } = await boot(home, [
      zcodeProfile(home, "set_mode: error\nturns: []\n", log),
    ]);
    await expect(herd.startTask("zcode", home, "Fix it")).rejects.toThrow(/set_mode refused/);
    expect(logLines(log).some((l) => l.startsWith("prompt "))).toBe(false);
    const reports = channel.ofKind("report").map((m) => JSON.stringify(m.view));
    expect(reports.some((r) => r.includes("set_mode refused"))).toBe(true);
    expect(herd.openTasks()).toEqual([]);
  });

  it("does not dispatch work when the session reports another mode", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentherd-prepare-"));
    const log = join(home, "wrong.log");
    const { herd } = await boot(home, [zcodeProfile(home, "set_mode: wrong\nturns: []\n", log)]);
    await expect(herd.startTask("zcode", home, "Fix it")).rejects.toThrow(
      /reported mode "yolo" instead of "build"/,
    );
    expect(logLines(log).some((l) => l.startsWith("prompt "))).toBe(false);
  });

  it("re-verifies the mode when it opens the saved session", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentherd-prepare-"));
    const log = join(home, "load.log");
    const { herd } = await boot(home, [
      zcodeProfile(home, `load_session: true\nset_mode: confirm\n${ONE_TURN}`, log),
    ]);
    const { taskId, turn } = await herd.startTask("zcode", home, "Fix it");
    await turn;
    await herd.endTask(taskId, "done");
    await herd.promptTask(taskId, "go on");
    const order = logLines(log);
    const modes = order.flatMap((l, i) => (l.startsWith("mode ") ? [i] : []));
    const loads = order.flatMap((l, i) => (l.startsWith("load ") ? [i] : []));
    const prompts = order.flatMap((l, i) => (l.startsWith("prompt ") ? [i] : []));
    expect(modes).toHaveLength(2);
    expect(loads).toHaveLength(1);
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    // The saved session is loaded, then the mode is confirmed again, then the prompt goes.
    expect(loads[0] ?? -1).toBeLessThan(modes[1] ?? Number.MAX_SAFE_INTEGER);
    expect(modes[1] ?? -1).toBeLessThan(prompts[1] ?? Number.MAX_SAFE_INTEGER);
    expect(herd.store.auditRows("task.reopened").at(-1)?.data).toMatchObject({
      loaded: true,
      profileId: "zcode",
    });
  });

  it("prepares the replacement session when the saved one is gone", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentherd-prepare-"));
    const log = join(home, "replace.log");
    const { herd } = await boot(home, [
      zcodeProfile(
        home,
        `load_session: true\nfail_load: true\nset_mode: confirm\n${ONE_TURN}`,
        log,
      ),
    ]);
    const { taskId, turn } = await herd.startTask("zcode", home, "Fix it");
    await turn;
    await herd.endTask(taskId, "done");
    await herd.promptTask(taskId, "go on");
    const order = logLines(log);
    expect(order.filter((l) => l.startsWith("mode "))).toHaveLength(2);
    expect(order.some((l) => l.startsWith("load refused:"))).toBe(true);
    const firstMode = order.findIndex((l) => l.startsWith("mode "));
    const lastPrompt = order.reduce((at, l, i) => (l.startsWith("prompt ") ? i : at), -1);
    expect(lastPrompt).toBeGreaterThan(firstMode);
    expect(herd.store.auditRows("task.reopened").at(-1)?.data).toMatchObject({ loaded: false });
  });

  it("fails the start with the agent's own reason when a named model is rejected", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentherd-prepare-"));
    const log = join(home, "model.log");
    const { herd } = await boot(home, [
      zcodeProfile(home, "reject_model: true\nset_mode: confirm\nturns: []\n", log),
    ]);
    await expect(
      herd.startTask("zcode", home, "Fix it", "Fix it", "no-such-model"),
    ).rejects.toThrow(/config refused: no model no-such-model/);
    expect(logLines(log).some((l) => l.startsWith("prompt "))).toBe(false);
  });

  it("does not dispatch work when session/set_mode RPC hangs past timeout", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentherd-prepare-"));
    const log = join(home, "hang.log");
    const { herd, channel } = await boot(
      home,
      [zcodeProfile(home, "set_mode: hang\nturns: []\n", log)],
      { modeConfirmTimeoutMs: 250 },
    );
    await expect(herd.startTask("zcode", home, "Fix it")).rejects.toThrow(
      /did not confirm mode "build"/,
    );
    expect(logLines(log).some((l) => l.startsWith("prompt "))).toBe(false);
    expect(
      channel.ofKind("report").some((m) => JSON.stringify(m.view).includes("did not confirm")),
    ).toBe(true);
    expect(herd.openTasks()).toEqual([]);
  });

  it("does not dispatch work when set_mode response contradicts current_mode_update", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentherd-prepare-"));
    const log = join(home, "mismatch.log");
    const { herd } = await boot(home, [
      zcodeProfile(home, "set_mode: mismatch_response\nturns: []\n", log),
    ]);
    await expect(herd.startTask("zcode", home, "Fix it")).rejects.toThrow(
      /reported mode "yolo" instead of "build"/,
    );
    expect(logLines(log).some((l) => l.startsWith("prompt "))).toBe(false);
  });

  it("does not replay or replace when prepareSession times out on a loaded session", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentherd-prepare-"));
    const log = join(home, "load-timeout.log");
    const profile = zcodeProfile(home, `load_session: true\nset_mode: confirm\n${ONE_TURN}`, log);
    const scriptPath = join(home, "reopen-script.yaml");
    writeFileSync(scriptPath, `load_session: true\nset_mode: confirm\n${ONE_TURN}`);
    // Reuse the wrapper by rewriting its referenced script between initial start and reopen.
    const wrapperPath = profile.command[1] as string;
    writeFileSync(
      wrapperPath,
      readFileSync(wrapperPath, "utf8").replace(
        /parseScript\(readFileSync\([^)]+\)\)/,
        `parseScript(readFileSync(${JSON.stringify(scriptPath)}, "utf8"))`,
      ),
    );
    const { herd, channel } = await boot(home, [profile], { modeConfirmTimeoutMs: 250 });
    const { taskId, turn } = await herd.startTask("zcode", home, "Fix it");
    await turn;
    await herd.endTask(taskId, "done");
    // Second connection loads the saved session, then hangs during set_mode.
    writeFileSync(scriptPath, `load_session: true\nset_mode: hang\n${ONE_TURN}`);
    await expect(herd.promptTask(taskId, "go on")).rejects.toThrow(/did not confirm mode "build"/);
    const order = logLines(log);
    expect(order.filter((l) => l.startsWith("load "))).toHaveLength(1);
    expect(order.filter((l) => l.startsWith("prompt "))).toHaveLength(1);
    expect(herd.store.auditRows("task.load-failed")).toHaveLength(1);
    expect(herd.openTasks()).toEqual([]);
    expect(JSON.stringify(channel.ofKind("report").at(-1)?.view)).toContain("did not confirm mode");
  });

  it("does not replay when prepareSession fails on a replacement session", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentherd-prepare-"));
    const log = join(home, "replace-fail.log");
    const profile = zcodeProfile(
      home,
      `load_session: true\nfail_load: true\nset_mode: confirm\n${ONE_TURN}`,
      log,
    );
    const scriptPath = join(home, "replace-script.yaml");
    writeFileSync(
      scriptPath,
      `load_session: true\nfail_load: true\nset_mode: confirm\n${ONE_TURN}`,
    );
    const wrapperPath = profile.command[1] as string;
    writeFileSync(
      wrapperPath,
      readFileSync(wrapperPath, "utf8").replace(
        /parseScript\(readFileSync\([^)]+\)\)/,
        `parseScript(readFileSync(${JSON.stringify(scriptPath)}, "utf8"))`,
      ),
    );
    const { herd } = await boot(home, [profile], { modeConfirmTimeoutMs: 250 });
    const { taskId, turn } = await herd.startTask("zcode", home, "Fix it");
    await turn;
    await herd.endTask(taskId, "done");
    writeFileSync(scriptPath, `load_session: true\nfail_load: true\nset_mode: silent\n${ONE_TURN}`);
    await expect(herd.promptTask(taskId, "go on")).rejects.toThrow(/did not confirm mode "build"/);
    const order = logLines(log);
    expect(order.some((l) => l.startsWith("load refused:"))).toBe(true);
    expect(order.filter((l) => l.startsWith("mode "))).toHaveLength(2);
    expect(order.filter((l) => l.startsWith("prompt "))).toHaveLength(1);
  });
});

const isOpenItem = (m: SentMessage) =>
  m.view.kind === "item" && (m.view as ItemView).final === undefined;

describe("guard, external tool, denial, timeout and report on ZCode-shaped profile (mock, side-effect-free)", () => {
  it("denies a guarded Windows delete stand-in without side effects and delivers the report", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentherd-zcode-guard-"));
    const log = join(home, "deny.log");
    const script = `
set_mode: confirm
turns:
  - - tool_call:
        id: c1
        title: "execute_command: cmd /c del /f /s /q outside"
        kind: delete
        command: "cmd /c del /f /s /q C:\\\\outside\\\\target"
        paths: ["C:\\\\outside\\\\target"]
        status: pending
    - request_permission:
        toolCall:
          id: c1
          title: "execute_command: cmd /c del /f /s /q outside"
          kind: delete
          command: "cmd /c del /f /s /q C:\\\\outside\\\\target"
          paths: ["C:\\\\outside\\\\target"]
        expect: deny
        on_reject: end_turn
    - message: "EXECUTED"
    - end_turn: end_turn
`;
    const { herd, channel } = await boot(home, [zcodeProfile(home, script, log)]);
    const { taskId, turn } = await herd.startTask("zcode", home, "Clean outside");
    const card = await channel.waitFor(isOpenItem);
    const view = card.view as ItemView;
    expect(view.body).toContain("cmd /c del /f /s /q");
    await channel.tap(view.itemId, "deny");
    const result = await turn;
    expect(result.stopReason).toBe("end_turn");
    expect((card.view as ItemView).final).toBe("Denied by you");
    expect(herd.transcript(taskId).entries.some((e) => e.text.includes("EXECUTED"))).toBe(false);
    const report = channel.ofKind("report").at(-1)?.view as ReportView | undefined;
    expect(report?.subtitle).toContain("ZCode");
  });

  it("denies an external-action stand-in in observe mode without side effects and delivers the report", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentherd-zcode-ext-"));
    const log = join(home, "ext.log");
    const script = `
set_mode: confirm
turns:
  - - tool_call:
        id: f1
        title: "WebFetch: https://example.com"
        kind: fetch
        status: pending
    - request_permission:
        toolCall:
          id: f1
          title: "WebFetch: https://example.com"
          kind: fetch
        expect: deny
        on_reject: end_turn
    - message: "FETCHED"
    - end_turn: end_turn
`;
    const { herd, channel } = await boot(home, [zcodeProfile(home, script, log)], {
      mode: "observe",
    });
    const { taskId, turn } = await herd.startTask("zcode", home, "Fetch example");
    const card = await channel.waitFor(isOpenItem);
    const view = card.view as ItemView;
    expect(view.title).toContain("WebFetch");
    await channel.tap(view.itemId, "deny");
    await turn;
    expect((card.view as ItemView).final).toBe("Denied by you");
    expect(herd.transcript(taskId).entries.some((e) => e.text.includes("FETCHED"))).toBe(false);
    expect(channel.ofKind("report").at(-1)?.view).toMatchObject({
      subtitle: expect.stringContaining("ZCode"),
    });
  });

  it("approval timeout denies a guarded action, leaves no side effect, and sends the report", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentherd-zcode-timeout-"));
    const log = join(home, "timeout.log");
    const clock = new FakeClock();
    const script = `
set_mode: confirm
turns:
  - - tool_call:
        id: t1
        title: "Bash: rm -rf ./*"
        kind: execute
        command: "rm -rf ./*"
        status: pending
    - request_permission:
        toolCall:
          id: t1
          title: "Bash: rm -rf ./*"
          kind: execute
          command: "rm -rf ./*"
        expect: deny
        on_reject: end_turn
    - message: "EXECUTED"
    - end_turn: end_turn
`;
    const { herd, store, channel } = await boot(home, [zcodeProfile(home, script, log)], {
      clock,
    });
    const { taskId, turn } = await herd.startTask("zcode", home, "Wipe");
    const card = await channel.waitFor(isOpenItem);
    const itemId = (card.view as ItemView).itemId;
    await clock.advance(31 * 60_000);
    await new Promise((r) => setImmediate(r));
    expect(channel.ofKind("text").some((m) => m.view.text.includes("Still waiting for you"))).toBe(
      true,
    );
    await clock.advance(30 * 60_000);
    const result = await turn;
    expect(result.stopReason).toBe("end_turn");
    expect(store.decisionsFor(itemId)[0]).toMatchObject({
      action: "deny",
      reason: "no answer in time",
    });
    expect((card.view as ItemView).final).toBe("No answer in 1 hour; the step was not done");
    expect(herd.transcript(taskId).entries.some((e) => e.text.includes("EXECUTED"))).toBe(false);
    expect(channel.ofKind("report").at(-1)?.view).toMatchObject({
      subtitle: expect.stringContaining("ZCode"),
    });
  });

  it("a separately allowed outbound stand-in uses allow_once and delivers the report", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentherd-zcode-allow-"));
    const log = join(home, "allow.log");
    const script = `
set_mode: confirm
turns:
  - - tool_call:
        id: p1
        title: "Bash: git push origin main"
        kind: execute
        command: "git push origin main"
        status: pending
    - request_permission:
        toolCall:
          id: p1
          title: "Bash: git push origin main"
          kind: execute
          command: "git push origin main"
        expect: allow
        on_reject: end_turn
    - message: "PUSH_SIMULATED"
    - end_turn: end_turn
`;
    const { herd, channel } = await boot(home, [zcodeProfile(home, script, log)]);
    const { turn } = await herd.startTask("zcode", home, "Push");
    const card = await channel.waitFor(isOpenItem);
    await channel.tap((card.view as ItemView).itemId, "allow");
    await turn;
    expect((card.view as ItemView).final).toBe("Allowed by you");
    const report = channel.ofKind("report").at(-1)?.view as ReportView | undefined;
    expect(report?.subtitle).toContain("ZCode");
    expect(report?.body).toContain("PUSH_SIMULATED");
    expect(logLines(log).some((l) => l.includes('"optionId":"allow"'))).toBe(true);
    expect(logLines(log).some((l) => l.includes('"optionId":"always"'))).toBe(false);
  });

  it("stops the task immediately when a running session drifts to an unguarded mode", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentherd-zcode-drift-"));
    const log = join(home, "drift.log");
    const script = `
set_mode: confirm
turns:
  - - mode_update: yolo
    - sleep: 5000
    - message: "AFTER_DRIFT"
`;
    const { herd, channel } = await boot(home, [zcodeProfile(home, script, log)]);
    const { taskId, turn } = await herd.startTask("zcode", home, "Run");
    await expect(turn).rejects.toThrow();
    expect(herd.store.auditRows("session.mode-drift")).toHaveLength(1);
    expect(herd.store.auditRows("session.mode-drift")[0]?.data).toMatchObject({
      expected: "build",
      actual: "yolo",
    });
    expect(herd.transcript(taskId).entries.some((e) => e.text.includes("AFTER_DRIFT"))).toBe(false);
    expect(JSON.stringify(channel.ofKind("report").at(-1)?.view)).toContain(
      "session mode changed to yolo",
    );
  });

  it("keeps the task running when the session drifts to plan, which runs no mutation", async () => {
    // Live evidence (plan-probe-run.json, 2026-11-27): in `plan`, write and delete attempts
    // executed nothing and issued no permission request — the agent mutates nothing. A drift to
    // the read-only mode therefore keeps the approval property, and the task continues.
    const home = mkdtempSync(join(tmpdir(), "agentherd-zcode-plan-drift-"));
    const log = join(home, "plan-drift.log");
    const script = `
set_mode: confirm
turns:
  - - mode_update: plan
    - message: "AFTER_DRIFT"
    - end_turn: end_turn
`;
    const { herd, channel } = await boot(home, [zcodeProfile(home, script, log)]);
    const { taskId, turn } = await herd.startTask("zcode", home, "Run");
    await turn;
    expect(herd.store.auditRows("session.mode-drift")).toHaveLength(0);
    expect(herd.transcript(taskId).entries.some((e) => e.text.includes("AFTER_DRIFT"))).toBe(true);
  });

  it("still gates a guarded action through the pipeline after a drift to plan", async () => {
    // The carve-out only keeps the task running; the approval pipeline must keep gating
    // actions in the drifted-to mode exactly as it does in `build`.
    const home = mkdtempSync(join(tmpdir(), "agentherd-zcode-plan-gate-"));
    const log = join(home, "plan-gate.log");
    const script = `
set_mode: confirm
turns:
  - - mode_update: plan
    - tool_call:
        id: g1
        title: "Bash: rm -rf ./*"
        kind: execute
        command: "rm -rf ./*"
        status: pending
    - request_permission:
        toolCall:
          id: g1
          title: "Bash: rm -rf ./*"
          kind: execute
          command: "rm -rf ./*"
        expect: deny
        on_reject: end_turn
    - message: "EXECUTED"
    - end_turn: end_turn
`;
    const { herd, channel } = await boot(home, [zcodeProfile(home, script, log)]);
    const { taskId, turn } = await herd.startTask("zcode", home, "Wipe");
    const card = await channel.waitFor(isOpenItem);
    const view = card.view as ItemView;
    expect(view.body).toContain("rm -rf ./*");
    await channel.tap(view.itemId, "deny");
    await turn;
    expect((card.view as ItemView).final).toBe("Denied by you");
    expect(herd.store.auditRows("session.mode-drift")).toHaveLength(0);
    expect(herd.transcript(taskId).entries.some((e) => e.text.includes("EXECUTED"))).toBe(false);
    expect(channel.ofKind("report").at(-1)?.view).toMatchObject({
      subtitle: expect.stringContaining("ZCode"),
    });
  });
});

describe("the owner's account choice survives recovery (ADR 0108)", () => {
  it("an ordinary task never falls back to ZCode, not even when reopening", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentherd-prepare-"));
    const zlog = join(home, "ordinary-zcode.log");
    const mlog = join(home, "ordinary-mock.log");
    const { herd } = await boot(home, [
      zcodeProfile(home, `set_mode: confirm\n${ONE_TURN}`, zlog),
      zcodeProfile(home, ONE_TURN, mlog, { id: "mock", plain: true }),
    ]);
    const { taskId, turn } = await herd.startTask("mock", home, "Fix it");
    await turn;
    await herd.endTask(taskId, "done");
    await herd.promptTask(taskId, "go on");
    expect(logLines(mlog).filter((l) => l.startsWith("prompt "))).toHaveLength(2);
    // ZCode was never started: no mode was set, no prompt was sent.
    expect(logLines(zlog)).toEqual([]);
  });

  it("a ZCode task that cannot reopen never starts another agent", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentherd-prepare-"));
    const zlog = join(home, "restart-zcode.log");
    const first = await boot(home, [zcodeProfile(home, `set_mode: confirm\n${ONE_TURN}`, zlog)]);
    const { taskId, turn } = await first.herd.startTask("zcode", home, "Fix it");
    await turn;
    await first.herd.endTask(taskId, "done");
    const before = logLines(zlog).length;
    await shutDown(first);

    // After the restart ZCode is gone; only another agent is installed. The saved task stays
    // recognizable as a ZCode task, so recovery asks the owner instead of switching accounts.
    const second = await boot(home, [
      { id: "mock", name: "Mock", command: [join(home, "no-such-mock")], env: {}, exporter: null },
    ]);
    expect(second.herd.tasks().find((t) => t.id === taskId)).toBeDefined();
    await expect(second.herd.promptTask(taskId, "go on")).rejects.toThrow(
      /^ZCode: ZCode is not installed$/,
    );
    expect(second.herd.openTasks()).toEqual([]);
    // The restart added nothing to ZCode: no prompt went to it.
    expect(logLines(zlog)).toHaveLength(before);
  });
});
