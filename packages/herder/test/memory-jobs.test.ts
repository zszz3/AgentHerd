import { DatabaseSync } from "node:sqlite";
import {
  CASE_JOB,
  DREAM_JOB,
  type HerderTurn,
  JOB_RETRY_MS,
  LESSON_JOB,
  MEMORY_TABLES_SQL,
  type MemoryKind,
  MemoryStore,
  REVIEW_JOB,
  Store,
} from "@agentherd/core";
import { describe, expect, it, vi } from "vitest";
import {
  DREAM_IDLE_MS,
  DREAM_INTERVAL_MS,
  DREAM_KINDS,
  DREAM_MAX_ENTRIES,
  DREAM_MIN_ENTRIES,
  DREAM_OPS_MAX,
  DREAM_SYSTEM,
  EXPERIENCE_SYSTEM,
  LESSON_SYSTEM,
  MemoryWorker,
  type MemoryWorkerDeps,
  parseJson,
  REVIEW_SYSTEM,
  REVIEW_TURNS,
} from "../src/memory-jobs.ts";

/** A memory model that answers each system prompt with the next scripted reply. */
function model(replies: Record<string, string[]>) {
  const asked: { system: string; user: string }[] = [];
  const complete = async (system: string, user: string) => {
    asked.push({ system, user });
    const next = replies[system]?.shift();
    if (next === undefined) throw new Error("unexpected request");
    return next;
  };
  return { asked, complete };
}

function setup(replies: Record<string, string[]>, deps?: Pick<MemoryWorkerDeps, "embedder">) {
  const store = Store.open(":memory:");
  const m = model(replies);
  const worker = new MemoryWorker({
    memory: store.memory,
    transcript: (id) => store.transcript(id),
    herderTurnsAfter: (id, n) => store.herderTurnsAfter(id, n),
    complete: m.complete,
    ...deps,
  });
  return { store, worker, asked: m.asked };
}

const LESSON = JSON.stringify({
  skip: false,
  task_signature: "给 Electron 应用排查打包签名失败",
  lesson: "签名失败先看构建日志，别先重装依赖",
  evidence: "重装依赖白费了时间，日志里直接是证书过期",
});
const SIGNALS = ["the owner prompted it 1 more time(s) after the first"];

describe("parseJson", () => {
  it("reads JSON from a code fence", () => {
    expect(parseJson('好的\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(() => parseJson("no")).toThrow("no JSON");
  });
});

describe("MemoryWorker", () => {
  it.each([false, true])("finds related experience when hybrid search fails: %s", async (fails) => {
    const embedder = {
      model: "test",
      embed: async (texts: readonly string[]) => texts.map(() => new Float32Array([1, 0])),
    };
    const { store, worker, asked } = setup(
      { [LESSON_SYSTEM]: [LESSON], [EXPERIENCE_SYSTEM]: ['{"action":"none"}'] },
      { embedder },
    );
    const { ids } = store.memory.write(
      [
        {
          op: "add",
          kind: "experience",
          abstract: fails ? "打包签名失败" : "Inspect the certificate first",
        },
      ],
      { actor: "task", source: "task" },
    );
    store.memory.setVector(ids[0] as string, embedder.model, new Float32Array([1, 0]));
    if (fails)
      vi.spyOn(store.memory, "searchHybrid").mockRejectedValueOnce(new Error("unavailable"));
    store.addTranscript("task", "prompt", "打包失败");
    store.addTranscript("task", "agent", "签名已修复");
    store.memory.enqueueJob(LESSON_JOB, { taskId: "task", signals: SIGNALS });
    await worker.drain();
    expect(asked[1]?.user).toContain(ids[0]?.slice(0, 8));
  });

  it("a task picked for a lesson adds experience and no case (ADR 0054)", async () => {
    const { store, worker, asked } = setup({
      [LESSON_SYSTEM]: [LESSON],
      [EXPERIENCE_SYSTEM]: [
        JSON.stringify({
          action: "add",
          abstract: "签名失败先看构建日志",
          details: "比重装依赖快",
        }),
      ],
    });
    store.addTranscript("t1", "prompt", "打包失败了，看看");
    store.addTranscript("t1", "agent", "签名证书过期，已更新，打包成功");
    store.memory.enqueueJob(LESSON_JOB, {
      taskId: "t1",
      title: "pi-desktop：打包",
      cwd: "/u/pi-desktop",
      why: "done",
      signals: SIGNALS,
    });
    await worker.drain();
    expect(asked[0]?.user).toContain("签名证书过期");
    expect(asked[0]?.user).toContain("Picked because: the owner prompted it");
    expect(store.memory.list({ kinds: ["case"] })).toEqual([]);
    const lessons = store.memory.list({ kinds: ["experience"] });
    expect(lessons.map((r) => [r.abstract, r.scope, r.sourceRef])).toEqual([
      ["签名失败先看构建日志", "project:/u/pi-desktop", "t1"],
    ]);
    expect(store.memory.jobs()[0]?.state).toBe("done");

    // The same task again asks nothing.
    store.memory.enqueueJob(LESSON_JOB, { taskId: "t1", signals: SIGNALS });
    await worker.drain();
    expect(asked).toHaveLength(2);
  });

  it("an update in a second project makes the lesson global", async () => {
    const { store, worker } = setup({});
    const { ids } = store.memory.write(
      [
        {
          op: "add",
          kind: "experience",
          abstract: "打包签名失败先看构建日志",
          scope: "project:/u/a",
        },
      ],
      { actor: "task", source: "task" },
    );
    const id = (ids[0] as string).slice(0, 8);
    store.memory.enqueueJob(LESSON_JOB, { taskId: "t2", cwd: "/u/b", signals: SIGNALS });
    store.addTranscript("t2", "prompt", "打包签名失败");
    store.addTranscript("t2", "agent", "看了构建日志，修好了");
    (worker as unknown as { deps: { complete: unknown } }).deps.complete = model({
      [LESSON_SYSTEM]: [LESSON],
      [EXPERIENCE_SYSTEM]: [
        JSON.stringify({
          action: "update",
          id,
          abstract: "签名失败先看构建日志，两个项目都是这样",
          details: "",
        }),
      ],
    }).complete;
    await worker.drain();
    const lesson = store.memory.list({ kinds: ["experience"] });
    expect(lesson.map((r) => [r.abstract, r.scope])).toEqual([
      ["签名失败先看构建日志，两个项目都是这样", "global"],
    ]);
  });

  it("normalizes Windows drive letters in project scope keys without false global promotion", async () => {
    const { store, worker } = setup({});
    const { ids } = store.memory.write(
      [
        {
          op: "add",
          kind: "experience",
          abstract: "打包签名失败先看构建日志",
          scope: "project:G:\\code\\app",
        },
      ],
      { actor: "task", source: "task" },
    );
    const id = (ids[0] as string).slice(0, 8);
    store.memory.enqueueJob(LESSON_JOB, { taskId: "t3", cwd: "g:\\code\\app", signals: SIGNALS });
    store.addTranscript("t3", "prompt", "打包签名失败");
    store.addTranscript("t3", "agent", "看了构建日志，修好了");
    (worker as unknown as { deps: { complete: unknown } }).deps.complete = model({
      [LESSON_SYSTEM]: [LESSON],
      [EXPERIENCE_SYSTEM]: [
        JSON.stringify({
          action: "update",
          id,
          abstract: "签名失败先看构建日志",
          details: "",
        }),
      ],
    }).complete;
    await worker.drain();
    const lesson = store.memory.list({ kinds: ["experience"] });
    expect(lesson.map((r) => [r.abstract, r.scope])).toEqual([
      ["签名失败先看构建日志", "project:G:\\code\\app"],
    ]);
  });

  it("most picked tasks teach nothing; a bad reply retries later", async () => {
    const { store, worker } = setup({ [LESSON_SYSTEM]: ['{"skip": true}', "not json"] });
    for (const t of ["t1", "t2"]) {
      store.addTranscript(t, "prompt", "hi");
      store.addTranscript(t, "agent", "hello");
      store.memory.enqueueJob(LESSON_JOB, { taskId: t, signals: SIGNALS });
    }
    await worker.drain();
    expect(store.memory.list()).toEqual([]);
    expect(store.memory.jobs().map((j) => j.state)).toEqual(["pending", "done"]);
  });

  it("an old case job from before ADR 0054 asks no model", async () => {
    const { store, worker, asked } = setup({});
    store.addTranscript("t1", "prompt", "找 issue");
    store.addTranscript("t1", "agent", "9 个");
    store.memory.enqueueJob(CASE_JOB, { taskId: "t1", why: "done" });
    await worker.drain();
    expect(asked).toEqual([]);
    expect(store.memory.jobs()[0]?.state).toBe("done");
  });

  it("a review keeps only what passes the memory checks (ADR 0101)", async () => {
    const { store, worker, asked } = setup({
      [REVIEW_SYSTEM]: [
        JSON.stringify({
          operations: [
            {
              action: "add",
              kind: "owner",
              content: "主人希望报告三行以内",
              evidence: "报告三行以内",
            },
            // A decision lets steps run without asking: only the owner or the Herder keeps one.
            {
              action: "add",
              kind: "decision",
              content: "pi-desktop 不开 PR",
              evidence: "看下 pi-desktop",
            },
            { action: "add", kind: "person", content: "小王负责前端", evidence: "小王是我们前端" },
            { action: "add", kind: "project", content: "演示在 /tmp/demo", evidence: "/tmp/demo" },
            { action: "add", kind: "owner", content: "没有依据的猜测" },
          ],
        }),
      ],
    });
    store.addHerderTurn("owner", "报告三行以内。看下 pi-desktop");
    store.addHerderTurn("herder", "好的，小王是我们前端吗？");
    store.addHerderTurn("owner", "小王是我们前端");
    store.addHerderTurn("answer", "/tmp/demo");
    store.memory.enqueueJob(REVIEW_JOB, { afterId: 0 });
    await worker.drain();
    expect(asked[0]?.user).toContain("[owner tapped] /tmp/demo");
    expect(asked[0]?.user).toContain("[secretary] 好的，小王是我们前端吗？");
    expect(
      store.memory
        .list()
        .map((r) => r.abstract)
        .sort(),
    ).toEqual(["主人希望报告三行以内", "小王负责前端"]);
    expect(store.memory.list().every((r) => r.source === "review")).toBe(true);
    expect(store.memory.lastLog("review.done")?.ref).toBe("4");
    expect(store.memory.logs().filter((l) => l.kind === "review.dropped")).toHaveLength(3);
  });

  it("keeps the lesson of a correction, from the secretary's side (ADR 0101)", async () => {
    const lesson = "推荐 issue 前，开着的和被关掉的 PR 都要看";
    const { store, worker, asked } = setup({
      [REVIEW_SYSTEM]: [
        JSON.stringify({
          operations: [
            {
              action: "add",
              kind: "experience",
              content: lesson,
              evidence: "主人指出 #2391 其实有被拒的 PR，我只看了开着的",
            },
          ],
        }),
      ],
    });
    store.addHerderTurn("herder", "#2391 和 #2426 都还没人接，适合上手");
    store.addHerderTurn("owner", "这个忽略吧，这个 issue 里面其实有 pr，只不过被拒绝了");
    store.addHerderTurn("herder", "明白，下次我连被关掉的 PR 也看");
    store.memory.enqueueJob(REVIEW_JOB, { afterId: 0 });
    await worker.drain();
    expect(asked[0]?.system).toBe(REVIEW_SYSTEM);
    expect(store.memory.list({ kinds: ["experience"] }).map((r) => r.abstract)).toEqual([lesson]);
  });

  it("one topic, one entry: a changed fact replaces the kept one (ADR 0101)", async () => {
    const store0 = Store.open(":memory:");
    store0.memory.write([{ op: "add", kind: "owner", abstract: "主人希望报告用英文" }], {
      actor: "herder",
      source: "said",
    });
    const [kept] = store0.memory.list();
    if (kept === undefined) throw new Error("nothing kept");
    const m = model({
      [REVIEW_SYSTEM]: [
        JSON.stringify({
          operations: [
            {
              action: "replace",
              id: kept.id.slice(0, 8),
              content: "主人希望报告用中文",
              evidence: "报告还是用中文吧",
            },
            // The same words again are not a second entry.
            {
              action: "add",
              kind: "owner",
              content: "主人希望报告用中文",
              evidence: "报告还是用中文吧",
            },
          ],
        }),
      ],
    });
    const worker = new MemoryWorker({
      memory: store0.memory,
      transcript: (id) => store0.transcript(id),
      herderTurnsAfter: (id, n) => store0.herderTurnsAfter(id, n),
      complete: m.complete,
    });
    store0.addHerderTurn("owner", "报告还是用中文吧");
    store0.memory.enqueueJob(REVIEW_JOB, { afterId: 0 });
    await worker.drain();
    // The review was shown what is kept on the topic, with its id.
    expect(m.asked[0]?.user).toContain(kept.id.slice(0, 8));
    expect(store0.memory.list().map((r) => r.abstract)).toEqual(["主人希望报告用中文"]);
    expect(
      store0.memory.logs().some((l) => l.kind === "review.dropped" && /already kept/.test(l.text)),
    ).toBe(true);
  });
});

describe("reviews catch up (ADR 0090)", () => {
  const NONE = JSON.stringify({ operations: [] });

  it("reads the conversation in order from where the last review stopped, chunk by chunk", async () => {
    const { store, worker, asked } = setup({ [REVIEW_SYSTEM]: [NONE, NONE, NONE] });
    for (let i = 1; i <= REVIEW_TURNS * 2 + 5; i++) store.addHerderTurn("owner", `第 ${i} 句`);
    store.memory.enqueueJob(REVIEW_JOB, { afterId: 0 });
    await worker.drain();
    expect(asked).toHaveLength(3);
    expect(asked[0]?.user).toContain("[owner] 第 1 句");
    expect(asked[0]?.user).not.toContain(`第 ${REVIEW_TURNS + 1} 句`);
    expect(asked[1]?.user).toContain(`[owner] 第 ${REVIEW_TURNS + 1} 句`);
    expect(asked[2]?.user).toContain(`第 ${REVIEW_TURNS * 2 + 5} 句`);
    expect(store.memory.lastLog("review.done")?.ref).toBe(String(REVIEW_TURNS * 2 + 5));
  });

  it("an old job starts after the newest finished review, not before it", async () => {
    const { store, worker, asked } = setup({ [REVIEW_SYSTEM]: [NONE] });
    store.addHerderTurn("owner", "早就读过的");
    store.memory.log("review.done", "through turn 1", "1");
    store.addHerderTurn("owner", "还没读的");
    store.memory.enqueueJob(REVIEW_JOB, { afterId: 0 });
    await worker.drain();
    expect(asked[0]?.user).not.toContain("早就读过的");
    expect(asked[0]?.user).toContain("还没读的");
  });

  it("on start, queues a review when the owner said things no review read", () => {
    const { store, worker } = setup({});
    store.addHerderTurn("owner", "我一般半夜写代码");
    store.memory.enqueueJob(REVIEW_JOB, { afterId: 0 });
    const failed = store.memory.claimJob();
    if (failed === undefined) throw new Error("no job");
    for (let i = 0; i < 4; i++) store.memory.failJob(failed.id, "Request timed out.");
    worker.catchUp();
    const pending = store.memory.jobs().filter((j) => j.state === "pending");
    expect(pending.map((j) => j.kind)).toEqual([REVIEW_JOB]);
    worker.catchUp();
    expect(store.memory.jobs().filter((j) => j.state === "pending")).toHaveLength(1);
  });
});

describe("reviews keep the owner's profile card (ADR 0091)", () => {
  it("keeps facts said in passing on the card and replaces a field that changed", async () => {
    const add = (content: string, evidence: string) => ({
      action: "add",
      kind: "profile",
      content,
      evidence,
    });
    const { store, worker, asked } = setup({
      [REVIEW_SYSTEM]: [
        JSON.stringify({
          operations: [
            add("称呼：火哥", "叫我火哥"),
            add("作息：常写代码到半夜", "我一般半夜还在写代码"),
            { action: "add", kind: "decision", content: "不做 Windows 版", evidence: "叫我火哥" },
          ],
        }),
        JSON.stringify({ operations: [add("作息：最近早睡", "这周开始早睡了")] }),
      ],
    });
    store.addHerderTurn("owner", "叫我火哥，我一般半夜还在写代码");
    store.memory.enqueueJob(REVIEW_JOB, { afterId: 0 });
    await worker.drain();
    expect(asked[0]?.system).toContain("profile: the owner's profile card");
    const card = () =>
      store.memory
        .list({ kinds: ["profile"] })
        .map((r) => r.abstract)
        .sort();
    expect(card()).toEqual(["作息：常写代码到半夜", "称呼：火哥"]);
    expect(store.memory.list({ kinds: ["decision"] })).toHaveLength(0);

    store.addHerderTurn("owner", "这周开始早睡了");
    store.memory.enqueueJob(REVIEW_JOB, { afterId: 0 });
    await worker.drain();
    expect(asked[1]?.user).toContain("[profile] 称呼：火哥");
    expect(card()).toEqual(["作息：最近早睡", "称呼：火哥"]);
  });
});

function dreamSetup(initialEntries = 0) {
  let time = Date.parse("2026-11-01T10:00:00Z");
  const now = () => new Date(time);
  const db = new DatabaseSync(":memory:");
  db.exec(MEMORY_TABLES_SQL);
  const memory = new MemoryStore(db, undefined, now);
  const turns: HerderTurn[] = [];
  const deps: MemoryWorkerDeps = {
    memory,
    now,
    transcript: () => [],
    herderTurnsAfter: () => [],
    recentTurns: (limit) => turns.slice(-limit),
    isQuietTime: () => true,
    complete: async () => '{"operations":[]}',
  };
  const worker = new MemoryWorker(deps);
  const add = (kind: MemoryKind, abstract: string, scope = "global", until?: string, body = "") =>
    memory.write(
      [{ op: "add", kind, abstract, scope, body, ...(until === undefined ? {} : { until }) }],
      { actor: "owner", source: "owner_edit" },
    ).ids[0] as string;
  for (let index = 0; index < initialEntries; index++) add("person", `Contact ${index}`);
  const turn = (role: HerderTurn["role"], text: string) =>
    turns.push({ id: turns.length + 1, role, text, at: now().toISOString() });
  const run = async (operations: unknown[]) => {
    const ask = vi.fn(async () => JSON.stringify({ operations, summary: "checked" }));
    deps.dreamComplete = ask;
    memory.enqueueJob(DREAM_JOB, {});
    await worker.drain();
    return ask;
  };
  return {
    memory,
    deps,
    worker,
    add,
    turn,
    run,
    now,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("silent dream jobs", () => {
  it("requires eligible entries and real idle time, and never queues a second waiting dream", () => {
    const { worker, deps, memory, add, turn, advance } = dreamSetup();
    for (let index = 1; index < DREAM_MIN_ENTRIES; index++) add("note", `note ${index}`);
    add("decision", "no releases");
    add("profile", "称呼：Boss");
    deps.isQuietTime = () => true;
    worker.maybeScheduleDream();
    expect(memory.jobs()).toEqual([]);
    add("note", "last");
    delete deps.isQuietTime;
    worker.maybeScheduleDream();
    expect(memory.jobs()).toEqual([]);
    turn("owner", "test");
    advance(DREAM_IDLE_MS - 1);
    worker.maybeScheduleDream();
    expect(memory.jobs()).toEqual([]);
    advance(1);
    worker.maybeScheduleDream();
    for (let index = 0; index < 21; index++) memory.enqueueJob(REVIEW_JOB, {});
    worker.maybeScheduleDream();
    expect(memory.jobs(50, DREAM_JOB)).toHaveLength(1);
    memory.claimJob(DREAM_JOB);
    worker.maybeScheduleDream();
    expect(memory.jobs(50, DREAM_JOB)).toHaveLength(1);
  });

  it("prefers configured quiet hours, with an idle fallback only after 48 hours", () => {
    const { worker, deps, memory, add, turn, advance } = dreamSetup();
    for (let index = 0; index < DREAM_MIN_ENTRIES; index++) add("project", `project ${index}`);
    deps.isQuietTime = () => false;
    turn("herder", "done");
    advance(2 * DREAM_INTERVAL_MS);
    worker.maybeScheduleDream();
    expect(memory.jobs()).toEqual([]);
    advance(1);
    worker.maybeScheduleDream();
    expect(memory.jobs()).toHaveLength(1);
  });

  it("waits 24 hours and requires three non-dream changes or an old unused temporary entry", async () => {
    const { worker, deps, memory, add, advance } = dreamSetup();
    for (let index = 0; index < DREAM_MIN_ENTRIES; index++) add("project", `project ${index}`);
    deps.isQuietTime = () => true;
    worker.start();
    await worker.stop();
    expect(memory.lastLog("dream.done")?.ref).toBe("0");
    advance(1);
    add("note", "one");
    add("experience", "two");
    memory.write([{ op: "add", kind: "case", abstract: "ignored revision" }], {
      actor: "dream",
      source: "review",
    });
    advance(DREAM_INTERVAL_MS - 1);
    worker.maybeScheduleDream();
    expect(memory.jobs()).toHaveLength(1);
    add("person", "three");
    worker.maybeScheduleDream();
    expect(memory.jobs()).toHaveLength(2);
    await new MemoryWorker(deps).drain();
    add("project", "same timestamp does not count");
    advance(30 * DREAM_INTERVAL_MS + 1);
    worker.maybeScheduleDream();
    expect(memory.jobs()).toHaveLength(3);
  });

  it("checks task and owner facts, merges a case across projects and undoes all changes together", async () => {
    const { memory, deps, add, turn, run, now, advance } = dreamSetup(2);
    const cold = add("note", "temporary instruction");
    advance(31 * DREAM_INTERVAL_MS);
    const keep = add("experience", "Retry the build", "project:/repo/one");
    const drop = add("case", "Build under /work/two", "project:/repo/two");
    const project = add("project", "The build is broken");
    const untouched = add("decision", "do not deploy");
    turn("owner", "Use /work/fixed");
    deps.recentTasks = () => [
      {
        id: "test",
        title: "Build",
        project: "two",
        stage: "done",
        failed: false,
        endedWhy: "finished",
        lastReport: `fixed ${"x".repeat(194)}not-in-prompt`,
        updatedAt: now().toISOString(),
      },
    ];
    const before = memory.list();
    const ask = await run([
      {
        action: "merge",
        keep_id: keep.slice(0, 8),
        drop_ids: [drop],
        content: "Retry under /work/two",
        reason: "same lesson",
      },
      {
        action: "replace",
        id: project,
        content: "Build fixed under /work/fixed",
        reason: "recent task report",
      },
      { action: "remove", id: cold, reason: "unused" },
    ]);
    expect(ask).toHaveBeenCalledWith(
      DREAM_SYSTEM,
      expect.stringContaining("[owner] Use /work/fixed"),
      expect.any(AbortSignal),
    );
    expect(ask).toHaveBeenCalledWith(
      DREAM_SYSTEM,
      expect.stringContaining('"endedWhy":"finished"'),
      expect.any(AbortSignal),
    );
    expect(ask).not.toHaveBeenCalledWith(
      DREAM_SYSTEM,
      expect.stringContaining("not-in-prompt"),
      expect.anything(),
    );
    expect(ask).not.toHaveBeenCalledWith(
      DREAM_SYSTEM,
      expect.stringContaining(untouched),
      expect.anything(),
    );
    expect(memory.list({ kinds: ["experience"] })[0]).toMatchObject({
      scope: "global",
      abstract: "Retry under /work/two",
      source: "review",
    });
    expect(memory.get(drop)?.status).toBe("deleted");
    expect(memory.get(cold)?.status).toBe("deleted");
    expect(memory.list({ kinds: ["project"] })[0]?.abstract).toContain("/work/fixed");
    const batch = memory.lastLog("dream.written")?.ref;
    expect(batch).toBeTruthy();
    expect(
      memory
        .revisions()
        .find((rev) => rev.batchId === batch && rev.after?.abstract === "Retry under /work/two")
        ?.after?.scope,
    ).toBe("global");
    expect(
      new Set(
        memory
          .revisions()
          .filter((rev) => rev.actor === "dream")
          .map((rev) => rev.batchId),
      ),
    ).toEqual(new Set([batch]));
    expect(memory.lastLog("dream.done")).toMatchObject({ ref: "1", text: "checked" });
    memory.undo(batch as string);
    expect(memory.list()).toEqual(before);
  });

  it("drops unauthorized writes, conflicts, ungrounded paths, and operations over the limit", async () => {
    const { memory, add, turn, run } = dreamSetup(3);
    const owner = add("owner", "Use paper reports");
    const note = add("note", "keep the note");
    const decision = add("decision", "no deploys");
    const profile = add("profile", "称呼：Boss");
    const lesson = add("experience", "useful lesson");
    turn("answer", "Forget Use paper reports");
    turn("herder", "Try /untrusted/path");
    const fix = (id: string, content: string) => ({
      action: "replace",
      id,
      content,
      reason: "corrected",
    });
    await run([
      null,
      { action: "add", kind: "note", content: "invented" },
      fix(decision, "different"),
      fix(profile, "称呼：X"),
      { action: "remove", id: owner, reason: "Forget Use paper reports" },
      {
        action: "merge",
        keep_id: lesson,
        drop_ids: [note],
        content: "incompatible",
        reason: "duplicate",
      },
      {
        action: "merge",
        keep_id: note,
        drop_ids: [note.slice(0, 8)],
        content: "self",
        reason: "duplicate",
      },
      fix(note, "New /untrusted/path"),
      fix(lesson, "x".repeat(201)),
      { action: "remove", id: lesson, reason: "cold" },
      fix(note, "checked note"),
      fix(note, "conflicting"),
      fix(lesson, "over limit"),
    ]);
    expect(memory.list({ kinds: ["note"] }).map((row) => row.abstract)).toEqual(["checked note"]);
    expect(memory.list()).toHaveLength(8);
    expect(memory.get(owner)?.status).toBe("active");
    expect(memory.get(lesson)?.status).toBe("active");
    expect(memory.logs(20, "dream.dropped")).toHaveLength(DREAM_OPS_MAX);
  });

  it("includes old unused candidates in a bounded prompt and does not overwrite concurrent edits", async () => {
    const { memory, deps, worker, add, advance } = dreamSetup();
    const cold = add("case", "old case");
    advance(31 * DREAM_INTERVAL_MS);
    for (let index = 0; index < DREAM_MAX_ENTRIES + 5; index++)
      add("experience", `experience ${index}`);
    delete deps.complete;
    deps.dreamComplete = async (_system, user) => {
      expect(user).toContain(cold);
      expect(user.match(/"accessCount":/g)).toHaveLength(DREAM_MAX_ENTRIES);
      memory.setStatus(cold, "deleted");
      return JSON.stringify({ operations: [{ action: "remove", id: cold, reason: "cold" }] });
    };
    memory.enqueueJob(REVIEW_JOB, {});
    memory.enqueueJob(DREAM_JOB, {});
    await worker.drain();
    expect(memory.jobs().map((job) => job.state)).toEqual(["done", "pending"]);
    expect(memory.lastLog("dream.dropped")).toBeDefined();
    expect(memory.lastLog("dream.written")).toBeUndefined();
  });

  it("only drops owner rules as duplicates or on an explicit recent typed revocation", async () => {
    const { memory, add, turn, run, advance } = dreamSetup(3);
    const keep = add("owner", "Use short reports");
    const duplicate = add("owner", "Use short reports");
    const revoked = add("owner", "Use paper reports");
    advance(1);
    turn("owner", "Forget Use short reports?");
    turn("owner", "Please forget Use paper reports.");
    await run([
      { action: "remove", id: keep, reason: "Forget Use short reports?" },
      {
        action: "merge",
        keep_id: keep,
        drop_ids: [duplicate],
        content: "Use short reports",
        reason: "duplicate",
      },
      { action: "remove", id: revoked, reason: "Please forget Use paper reports." },
    ]);
    expect(memory.logs(20, "dream.dropped")).toHaveLength(1);
    expect(memory.list({ kinds: ["owner"] }).map((row) => row.abstract)).toEqual([
      "Use short reports",
    ]);
  });

  it("does not rewrite owner rules, reuse old revocations, or authorize paths from taps", async () => {
    const { memory, add, turn, run, advance } = dreamSetup(DREAM_MIN_ENTRIES);
    const old = add("owner", "Paper reports");
    turn("owner", "Forget Paper reports");
    advance(1);
    memory.setStatus(old, "deleted");
    const rebuilt = add("owner", "Paper reports");
    const sameTime = add("owner", "Daily reports");
    turn("owner", "Forget Daily reports");
    turn("owner", "Check my calendar today");
    turn("answer", "/picked/folder");
    const project = add("project", "folder unknown");
    const before = memory.list();
    await run([
      {
        action: "replace",
        id: rebuilt,
        content: "Check my calendar today",
        reason: "owner said so",
      },
      { action: "remove", id: rebuilt, reason: "Forget Paper reports" },
      { action: "remove", id: sameTime, reason: "Forget Daily reports" },
      { action: "replace", id: project, content: "Use /picked/folder", reason: "owner tapped" },
    ]);
    expect(memory.logs(10, "dream.dropped")).toHaveLength(4);
    expect(memory.list()).toEqual(before);
  });

  it("keeps scope, expiry and owner details when merging", async () => {
    const { memory, add, run } = dreamSetup();
    const early = "2026-12-01";
    const late = "2026-12-15";
    const owner = add("owner", "Concise", "global", late);
    const note = add("note", "notes", "project:/a", early);
    const lesson = add("experience", "lesson", "project:/a", early);
    const merge = (keep: string, drop: string, details?: string) => ({
      action: "merge",
      keep_id: keep,
      drop_ids: [drop],
      content: memory.get(keep)?.abstract,
      details,
      reason: "duplicate",
    });
    const rejected = [
      merge(owner, add("owner", "Concise", "project:/b", late)),
      merge(owner, add("owner", "Concise", "global", early)),
      merge(owner, add("owner", "Concise", "global", late, "Weekly only")),
      merge(owner, add("owner", "Concise", "global", late), "Only today"),
      merge(note, add("note", "notes", "project:/b", early)),
      merge(note, add("note", "notes", "project:/a")),
      merge(lesson, add("case", "old lesson", "project:/b", late)),
    ];
    const valid = add("project", "repo", "project:G:\\Work", late);
    const duplicate = add("project", "repo", "project:g:/work", early);
    await run([...rejected, merge(valid, duplicate)]);
    expect(memory.logs(10, "dream.dropped")).toHaveLength(rejected.length);
    for (const proposal of rejected) {
      expect(memory.get(proposal.keep_id)?.status).toBe("active");
      expect(memory.get(proposal.drop_ids[0] as string)?.status).toBe("active");
    }
    expect(memory.get(duplicate)?.status).toBe("deleted");
    expect(memory.list({ kinds: ["project"] })[0]).toMatchObject({
      scope: "project:G:\\Work",
      until: late,
    });
  });

  it("requires a verbatim quote naming the non-cold target by word, project or id", async () => {
    const { memory, add, turn, run, deps, now } = dreamSetup();
    const unrelated = add("note", "The atlas");
    const short = add("case", "archive");
    const missing = add("experience", "registry");
    const english = add("note", "Registry");
    const chinese = add("case", "攻略", "global", undefined, "证书轮换");
    const project = add("experience", "Check settings", "project:/repos/Quartz");
    const idOnly = add("note", "old reminder");
    const report = "Quartz was discontinued";
    deps.recentTasks = () => [
      {
        id: "task",
        title: "Retirement",
        project: "Quartz",
        stage: "done",
        failed: false,
        lastReport: report,
        updatedAt: now().toISOString(),
      },
    ];
    const proposals = [
      [unrelated, "Good morning"],
      [short, "archive"],
      [missing, "registry was replaced"],
      [english, "the registry is retired"],
      [chinese, "我们今天已经不再使用旧证书了"],
      [project, report],
      [idOnly, `Forget note ${idOnly.slice(0, 8)}`],
    ] as const;
    for (const [id, reason] of proposals)
      if (id !== missing && id !== project) turn("owner", reason);
    await run(proposals.map(([id, reason]) => ({ action: "remove", id, reason })));
    expect(memory.logs(10, "dream.dropped")).toHaveLength(3);
    expect(
      memory
        .list()
        .map((row) => row.id)
        .sort(),
    ).toEqual([unrelated, short, missing].sort());
  });

  it.each(["count", "idle", "quiet"])(
    "skips without calling a model when queued %s eligibility changes",
    async (condition) => {
      const { memory, deps, worker, turn } = dreamSetup(DREAM_MIN_ENTRIES);
      const complete = vi.fn(async () => '{"operations":[]}');
      deps.dreamComplete = complete;
      worker.maybeScheduleDream();
      expect(memory.jobs()[0]?.state).toBe("pending");
      if (condition === "count")
        memory.setStatus(memory.list({ kinds: DREAM_KINDS })[0]?.id as string, "deleted");
      else if (condition === "idle") {
        delete deps.isQuietTime;
        turn("owner", "back");
      } else deps.isQuietTime = () => false;
      await worker.drain();
      expect(complete).not.toHaveBeenCalled();
      expect(memory.jobs()[0]?.state).toBe("done");
      expect(memory.lastLog("dream.skipped")).toBeDefined();
      expect(memory.lastLog("dream.tried")).toBeUndefined();
      expect(memory.lastLog("dream.done")).toBeUndefined();
    },
  );

  it("retries the queued dream but waits 24 hours after its final model attempt for a new one", async () => {
    const { memory, deps, worker, advance, turn } = dreamSetup(DREAM_MIN_ENTRIES);
    deps.dreamComplete = vi.fn(async () => '{"summary":"invalid"}');
    turn("owner", "still here");
    worker.maybeScheduleDream();
    await worker.drain();
    for (const wait of JOB_RETRY_MS) {
      advance(wait);
      worker.maybeScheduleDream();
      await worker.drain();
    }
    expect(deps.dreamComplete).toHaveBeenCalledTimes(JOB_RETRY_MS.length + 1);
    expect(memory.jobs()).toMatchObject([{ state: "failed" }]);
    expect(memory.lastLog("dream.tried")?.ref).toBe("1");
    expect(memory.lastLog("dream.done")).toBeUndefined();
    advance(DREAM_INTERVAL_MS - 1);
    worker.maybeScheduleDream();
    expect(memory.jobs()).toHaveLength(1);
    advance(1);
    worker.maybeScheduleDream();
    expect(memory.jobs()).toMatchObject([{ state: "pending" }, { state: "failed" }]);
  });

  it("redacts a scheduling error and still drains the pending review", async () => {
    const { deps, worker, memory } = dreamSetup(DREAM_MIN_ENTRIES);
    const log = vi.fn();
    deps.log = log;
    const marker = "private-marker";
    deps.isQuietTime = () => {
      throw new Error(`config unavailable: Bearer ${marker}`);
    };
    memory.enqueueJob(REVIEW_JOB, {});
    worker.kick();
    await worker.stop();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("config unavailable"));
    expect(JSON.stringify(log.mock.calls)).not.toContain(marker);
    expect(memory.jobs()).toMatchObject([{ kind: REVIEW_JOB, state: "done" }]);
  });

  it("logs a full kind and rolls back the whole dream, including removals", async () => {
    const { memory, add, run, advance } = dreamSetup();
    const cold = add("case", "obsolete case");
    advance(31 * DREAM_INTERVAL_MS);
    for (let index = 0; index < 10; index++) add("note", `${index}${"n".repeat(199)}`);
    add("note", "filler");
    const edited = add("note", "before");
    const before = memory.list();
    await run([
      { action: "remove", id: cold, reason: "cold" },
      { action: "replace", id: edited, content: "x".repeat(200), reason: "corrected" },
    ]);
    expect(memory.lastLog("dream.dropped")?.text).toContain("of 2200");
    expect(memory.lastLog("dream.written")).toBeUndefined();
    expect(memory.lastLog("dream.done")).toBeDefined();
    expect(memory.list()).toEqual(before);
  });
});
