import { Store } from "@agentherd/core";
import {
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  streamSimple,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { Herder, REVIEW_TOKENS } from "../src/herder.ts";
import {
  dateNote,
  decisionsText,
  lessonsText,
  memoryTools,
  opProblem,
  ownerPrefsText,
  TOP_RULES_MAX_CHARS,
  turnMemory,
} from "../src/memory.ts";
import { eventsPrompt, LATE_NIGHT_HINT, nowLine, systemPrompt } from "../src/prompt.ts";
import type { TurnContext } from "../src/tools.ts";
import { fakeHost } from "./helpers.ts";

function turn(typedText: string, kind: TurnContext["kind"] = "owner"): TurnContext {
  return {
    kind,
    ownerText: typedText,
    typedText,
    images: [],
    asked: false,
    notified: false,
    pickedDirs: [],
  };
}

function setupTools(text: string) {
  const store = Store.open(":memory:");
  const ctx = turn(text);
  const byName = new Map(memoryTools(store.memory, () => ctx).map((t) => [t.name, t]));
  const call = async (name: string, args: unknown) => {
    const result = await byName.get(name)?.execute("id", args as never);
    return result?.content.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";
  };
  return { store, ctx, call };
}

describe("memory checks", () => {
  const said = turn("以后报告都用中文，三行以内。帮我看下 pi-desktop 的 issue");

  it("keeps a lasting preference in the owner's words", () => {
    expect(
      opProblem(
        {
          action: "add",
          kind: "owner",
          content: "主人希望报告用中文、三行以内",
          evidence: "以后报告都用中文，三行以内",
        },
        said,
      ),
    ).toBeUndefined();
  });

  it("refuses evidence the owner did not type", () => {
    expect(
      opProblem(
        { action: "add", kind: "owner", content: "喜欢英文", evidence: "以后都用英文" },
        said,
      ),
    ).toContain("copied exactly");
  });

  it("a preference needs no 「以后」, only the owner's words (ADR 0101)", () => {
    const t = turn("报告别超过三行");
    expect(
      opProblem(
        { action: "add", kind: "owner", content: "报告三行以内", evidence: "报告别超过三行" },
        t,
      ),
    ).toBeUndefined();
  });

  it("a lesson needs none of the owner's words, and stays out of their mouth", () => {
    const t = turn("这个忽略吧，这个 issue 里面其实有 PR，只不过被拒绝了");
    expect(
      opProblem(
        {
          action: "add",
          kind: "experience",
          content: "推荐 issue 前，开着的和被关掉的 PR 都要看",
          evidence: "我只看了开着的 PR，漏了被拒绝的",
        },
        t,
      ),
    ).toBeUndefined();
  });

  it("refuses questions and ifs", () => {
    const t = turn("以后是不是都用 kimi 比较好？");
    expect(
      opProblem(
        {
          action: "add",
          kind: "owner",
          content: "用 kimi",
          evidence: "以后是不是都用 kimi 比较好？",
        },
        t,
      ),
    ).toContain("question");
  });

  it("never keeps temporary folders, and other paths only in the owner's words", () => {
    const t = turn("记住 pi-desktop 在 ~/learn-agent/pi-desktop");
    expect(
      opProblem({ action: "add", kind: "project", content: "演示项目在 /tmp/demo" }, t),
    ).toContain("temporary");
    expect(
      opProblem(
        {
          action: "add",
          kind: "project",
          content: "演示在 C:\\Users\\me\\AppData\\Local\\Temp\\x",
        },
        t,
      ),
    ).toContain("temporary");
    expect(
      opProblem({ action: "add", kind: "project", content: "演示在 C:\\Windows\\Temp\\x" }, t),
    ).toContain("temporary");
    expect(opProblem({ action: "add", kind: "project", content: "演示在 %TEMP%\\x" }, t)).toContain(
      "temporary",
    );
    expect(
      opProblem({ action: "add", kind: "project", content: "AgentHerd 在 ~/code/AgentHerd" }, t),
    ).toContain("not in the owner's words");
    expect(
      opProblem({ action: "add", kind: "project", content: "AgentHerd 在 C:\\code\\AgentHerd" }, t),
    ).toContain("not in the owner's words");
    expect(
      opProblem(
        { action: "add", kind: "project", content: "AgentHerd 在 \\\\server\\share\\AgentHerd" },
        t,
      ),
    ).toContain("not in the owner's words");
    expect(
      opProblem(
        {
          action: "add",
          kind: "project",
          content: "pi-desktop 在 ~/learn-agent/pi-desktop",
          evidence: "pi-desktop 在 ~/learn-agent/pi-desktop",
        },
        t,
      ),
    ).toBeUndefined();
  });

  it("needs evidence for people, not for the Herder's own notes", () => {
    const t = turn("小王负责前端");
    expect(opProblem({ action: "add", kind: "person", content: "小王负责前端" }, t)).toContain(
      "need evidence",
    );
    expect(
      opProblem({ action: "add", kind: "note", content: "deepseek 在晚上常超时，可换 kimi" }, t),
    ).toBeUndefined();
  });

  it("writes nothing on an event turn and leaves cases to AgentHerd", () => {
    expect(opProblem({ action: "add", kind: "note", content: "x" }, turn("", "event"))).toContain(
      "only while answering",
    );
    expect(opProblem({ action: "add", kind: "case", content: "x" }, said)).toContain(
      "kind must be",
    );
  });
});

describe("memory tools", () => {
  it("saves, replaces and removes; a failed check saves nothing", async () => {
    const { store, ctx, call } = setupTools("以后报告都用中文");
    await call("memory", {
      operations: [
        { action: "add", kind: "owner", content: "报告用中文", evidence: "以后报告都用中文" },
      ],
    });
    const [row] = store.memory.list();
    expect(row).toMatchObject({
      abstract: "报告用中文",
      source: "said",
      evidence: "以后报告都用中文",
    });

    ctx.typedText = "不对，以后报告用英文";
    ctx.ownerText = ctx.typedText;
    await expect(
      call("memory", {
        operations: [
          {
            action: "replace",
            id: row?.id.slice(0, 8),
            content: "报告用英文",
            evidence: "以后报告用英文",
          },
          { action: "add", kind: "owner", content: "随便", evidence: "瞎编的" },
        ],
      }),
    ).rejects.toThrow("not saved");
    expect(store.memory.list().map((r) => r.abstract)).toEqual(["报告用中文"]);

    await call("memory", {
      operations: [
        {
          action: "replace",
          id: row?.id.slice(0, 8),
          content: "报告用英文",
          evidence: "以后报告用英文",
        },
      ],
    });
    expect(store.memory.list().map((r) => r.abstract)).toEqual(["报告用英文"]);
  });

  it("when full, fails with what is there so the Herder can make room in one batch", async () => {
    const { store, call } = setupTools("以后都记住这个");
    for (let i = 0; i < 6; i++) {
      store.memory.write([{ op: "add", kind: "owner", abstract: `${i}${"偏".repeat(199)}` }], {
        actor: "herder",
        source: "said",
      });
    }
    await expect(
      call("memory", {
        operations: [
          { action: "add", kind: "owner", content: "很".repeat(199), evidence: "以后都记住这个" },
        ],
      }),
    ).rejects.toThrow(/would hold \d+ of 1375[\s\S]*Retry as ONE/);
  });

  it("searches people, projects, cases and experience", async () => {
    const { store, call } = setupTools("");
    store.memory.write([{ op: "add", kind: "case", abstract: "修复 pi-desktop 打包签名失败" }], {
      actor: "task",
      source: "task",
    });
    expect(await call("memory_search", { query: "打包签名" })).toContain(
      "修复 pi-desktop 打包签名失败",
    );
    expect(await call("memory_search", { query: "完全无关的东西" })).toBe("(nothing found)");
  });
});

describe("dates (ADR 0038)", () => {
  it("every entry the Herder or an agent sees says when it was written", () => {
    const store = Store.open(":memory:");
    store.memory.write(
      [{ op: "add", kind: "owner", abstract: "报告用中文", until: "2026-12-31" }],
      {
        actor: "herder",
        source: "said",
      },
    );
    const [row] = store.memory.list({ kinds: ["owner"] });
    if (row === undefined) throw new Error("no row");
    expect(dateNote(row)).toMatch(/^记于 \d{4}-\d{2}-\d{2}，到 2026-12-31$/);
    expect(ownerPrefsText(store.memory)).toMatch(/报告用中文 \(记于 /);
    expect(lessonsText([{ ...row, kind: "case" }])).toMatch(/\[案例\] 报告用中文 \(记于 /);
  });

  it("the time line names the local day, hour and weekday", () => {
    const ms = new Date(2026, 10, 6, 18, 5).getTime();
    expect(nowLine(ms)).toBe("[Now: 2026-11-06 18:05, Friday]");
  });

  it("the time line says when it is late at night (ADR 0088)", () => {
    expect(nowLine(new Date(2026, 10, 20, 1, 55).getTime())).toBe(
      `[Now: 2026-11-20 01:55, Friday, late at night: ${LATE_NIGHT_HINT}]`,
    );
    expect(nowLine(new Date(2026, 10, 20, 5, 0).getTime())).not.toContain("late at night");
    expect(nowLine(new Date(2026, 10, 19, 23, 50).getTime())).not.toContain("late at night");
  });
});

describe("memory for one turn (ADR 0101)", () => {
  it("pins the profile and top rules, but counts only distinct search hits", async () => {
    const store = Store.open(":memory:");
    expect(await turnMemory(store.memory, "让小王看看 pi-desktop")).toBe("");
    store.memory.write(
      [
        { op: "add", kind: "profile", abstract: "称呼：火哥" },
        { op: "add", kind: "person", abstract: "小王负责 pi-desktop 前端" },
        { op: "add", kind: "experience", abstract: "推荐 pi-desktop 的 issue 前先看被拒的 PR" },
        { op: "add", kind: "owner", abstract: "报告用中文" },
        { op: "add", kind: "decision", abstract: "不做 Windows 版", evidence: "不做 Windows 版" },
      ],
      { actor: "herder", source: "said" },
    );
    const block = await turnMemory(store.memory, "让小王看看 pi-desktop");
    expect(block).toMatch(/^\[记忆召回 · 只在这一轮带着；/);
    expect(block).toMatch(/主人画像：\n- \[\w+\] 称呼：火哥 \(记于 \d{4}-\d{2}-\d{2}\)/);
    expect(block).toMatch(/跟这一轮有关的：\n[\s\S]*小王负责 pi-desktop 前端/);
    expect(block).toMatch(/推荐 pi-desktop 的 issue 前先看被拒的 PR \(记于 [\d-]+\) · 经验/);
    expect(block).toContain("长期要求与定了的事：");
    const quiet = await turnMemory(store.memory, "天气");
    expect(quiet).toContain("称呼：火哥");
    expect(quiet).toContain("报告用中文");
    expect(quiet).toContain("不做 Windows 版");
    expect(quiet).not.toContain("跟这一轮有关的");
    const related = await turnMemory(store.memory, "报告用中文 Windows pi-desktop");
    const [pinned, hits] = related.split("跟这一轮有关的：");
    expect(pinned).toContain("报告用中文");
    expect(hits).not.toContain("报告用中文");
    expect(hits).not.toContain("Windows");
    expect(
      store.memory.list({ kinds: ["profile", "owner", "decision"] }).map((row) => row.accessCount),
    ).toEqual([0, 0, 0]);
    expect(
      store.memory.list({ kinds: ["person", "experience"] }).map((row) => row.accessCount),
    ).toEqual([2, 2]);
  });

  it("fits the hottest rules first and skips long lines without cutting their evidence", async () => {
    const { memory } = Store.open(":memory:");
    const add = (abstract: string, evidence: string) =>
      memory.write([{ op: "add", kind: "decision", abstract, evidence }], {
        actor: "herder",
        source: "said",
      }).ids;
    const hot = add("hot", "H".repeat(700));
    add("small", "fits");
    add("overflow", "X".repeat(400));
    memory.touch(hot);
    const rules = (await turnMemory(memory, "")).split("长期要求与定了的事：\n")[1] ?? "";
    expect(rules.indexOf("hot")).toBeLessThan(rules.indexOf("small"));
    expect(rules).toContain("H".repeat(700));
    expect(rules).toContain("small");
    expect(rules).not.toContain("overflow");
    expect(rules.length).toBeLessThanOrEqual(TOP_RULES_MAX_CHARS);
  });
});

let faux: FauxProviderRegistration[] = [];
afterEach(() => {
  for (const f of faux) f.unregister();
  faux = [];
});

describe("Herder with memory (ADR 0101)", () => {
  it("keeps memory out of the system prompt and brings it with each turn only", async () => {
    const store = Store.open(":memory:");
    store.memory.write([{ op: "add", kind: "owner", abstract: "主人周末不看工作消息" }], {
      actor: "herder",
      source: "said",
    });
    store.memory.write([{ op: "add", kind: "person", abstract: "小王负责前端" }], {
      actor: "herder",
      source: "said",
    });
    const registration = registerFauxProvider();
    faux.push(registration);
    const { host } = fakeHost({ memory: store.memory });
    host.herderLog = () => store.herderLog();
    host.writeHerderLog = (from, messages) => store.writeHerderLog(from, messages);
    const herder = new Herder({
      host,
      model: registration.getModel(),
      streamFn: streamSimple,
      sleep: async () => {},
      now: () => 1_000_000,
    });
    const seen: { system: string; messages: string[] }[] = [];
    const see = (context: { systemPrompt?: string; messages: unknown[] }) => {
      seen.push({
        system: JSON.stringify(context.systemPrompt ?? context.messages[0]),
        messages: context.messages.map((m) => JSON.stringify(m)),
      });
    };
    registration.setResponses([
      (context) => {
        see(context as never);
        return fauxAssistantMessage(
          [
            fauxToolCall("memory", {
              operations: [
                {
                  action: "add",
                  kind: "owner",
                  content: "主人默认用 kimi",
                  evidence: "以后默认用 kimi",
                },
              ],
            }),
          ],
          { stopReason: "toolUse" },
        );
      },
      () => fauxAssistantMessage("好。"),
      (context) => {
        see(context as never);
        return fauxAssistantMessage("好。");
      },
    ]);
    herder.ownerMessage("以后默认用 kimi，小王那边的前端呢");
    await herder.idle();
    const first = seen[0];
    if (first === undefined) throw new Error("no request");
    expect(first.system).not.toContain("主人周末不看工作消息");
    expect(first.system).not.toContain("小王负责前端");
    const asked = first.messages.at(-1) ?? "";
    expect(asked).toContain("[记忆召回 · 只在这一轮带着");
    expect(asked).toContain("小王负责前端");
    expect(asked).toContain(nowLine(1_000_000).slice(0, 12)); // every message carries the time
    // Taken out once the turn is over: never saved.
    expect(JSON.stringify(store.herderLog())).not.toContain("记忆召回 · 只在这一轮");
    expect(JSON.stringify(store.herderLog())).toContain("以后默认用 kimi，小王那边的前端呢");

    herder.ownerMessage("天气如何？");
    await herder.idle();
    const second = seen[1];
    if (second === undefined) throw new Error("no second request");
    expect(second.system).toBe(first.system); // the cached prefix stays the same
    const earlier = second.messages.find((m) => m.includes("小王那边的前端呢")) ?? "";
    expect(earlier).not.toContain("记忆召回 · 只在这一轮");
    expect(second.messages.at(-1)).toContain("天气如何？");
    expect(second.messages.at(-1)).toContain("长期要求与定了的事：");
    expect(second.messages.at(-1)).toContain("主人默认用 kimi");
    expect(second.messages.at(-1)).toContain("主人周末不看工作消息");
    const saved = JSON.stringify(store.herderLog());
    expect(saved).toContain("天气如何？");
    expect(saved).not.toContain("记忆召回 · 只在这一轮");
    expect(saved).not.toContain("主人周末不看工作消息");
  });

  it("a timer's turn brings memory about its job too", async () => {
    const store = Store.open(":memory:");
    store.memory.write(
      [
        {
          op: "add",
          kind: "experience",
          abstract: "推荐 PI-Desktop 的 issue 前，被拒的 PR 也要看",
        },
      ],
      { actor: "herder", source: "noticed" },
    );
    const registration = registerFauxProvider();
    faux.push(registration);
    const { host } = fakeHost({ memory: store.memory });
    const herder = new Herder({
      host,
      model: registration.getModel(),
      streamFn: streamSimple,
      sleep: async () => {},
    });
    let asked = "";
    registration.setResponses([
      (context) => {
        asked = JSON.stringify(context.messages.at(-1));
        return fauxAssistantMessage("[quiet]");
      },
    ]);
    herder.scheduled({
      id: "t1",
      about: "PI-Desktop 新 issue 早查",
      prompt: "看看 PI-Desktop 有没有好上手的新 issue",
      when: { kind: "daily", at: "09:30" },
      paused: false,
      createdAt: new Date(0).toISOString(),
    });
    await herder.idle();
    expect(asked).toContain("被拒的 PR 也要看");
  });
});

describe("Herder review trigger (ADR 0101)", () => {
  it("queues one review once enough of the conversation came in", async () => {
    const store = Store.open(":memory:");
    const registration = registerFauxProvider();
    faux.push(registration);
    const { host } = fakeHost({ memory: store.memory });
    const herder = new Herder({
      host,
      model: registration.getModel(),
      streamFn: streamSimple,
      sleep: async () => {},
    });
    registration.setResponses(Array.from({ length: 3 }, () => () => fauxAssistantMessage("好。")));
    herder.ownerMessage("短的一句");
    await herder.idle();
    expect(store.memory.jobs()).toEqual([]); // waits for more, or for a quiet spell
    herder.ownerMessage("长".repeat(REVIEW_TOKENS));
    await herder.idle();
    herder.ownerMessage("长".repeat(REVIEW_TOKENS));
    await herder.idle();
    // The first review is still waiting, so the second adds none.
    expect(store.memory.jobs().map((j) => j.kind)).toEqual(["review"]);
    await herder.stop();
  });
});

describe("decisions (ADR 0057)", () => {
  const said = turn("AgentHerd 以后直接推 main，不用开 PR。另外 Windows 版不做了");

  it("keeps what the owner settled, in their words", () => {
    for (const evidence of ["AgentHerd 以后直接推 main，不用开 PR", "Windows 版不做了"]) {
      expect(
        opProblem({ action: "add", kind: "decision", content: "x 定了", evidence }, said),
      ).toBeUndefined();
    }
  });

  it("refuses a decision without the owner's words or about one task", () => {
    expect(opProblem({ action: "add", kind: "decision", content: "直接推 main" }, said)).toContain(
      "need evidence",
    );
    const once = turn("这次先推到 dev 分支吧");
    expect(
      opProblem(
        { action: "add", kind: "decision", content: "推 dev", evidence: "这次先推到 dev 分支吧" },
        once,
      ),
    ).toContain("not settle");
    const asked = turn("要不要以后都不做 Windows？");
    expect(
      opProblem(
        {
          action: "add",
          kind: "decision",
          content: "不做 Windows",
          evidence: "要不要以后都不做 Windows？",
        },
        asked,
      ),
    ).toContain("question");
  });

  it("decisions come with the turns about them and go to every new task with the quote and the day", async () => {
    const { store, call } = setupTools("AgentHerd 以后直接推 main，不用开 PR");
    const reply = await call("memory", {
      operations: [
        {
          action: "add",
          kind: "decision",
          content: "AgentHerd 仓库的改动直接推 main，不开 PR",
          evidence: "AgentHerd 以后直接推 main，不用开 PR",
        },
      ],
    });
    expect(reply).toContain("saved");
    const block = await turnMemory(store.memory, "AgentHerd 的改动推 main 吗");
    expect(block).toContain("原话：「AgentHerd 以后直接推 main，不用开 PR」 (记于");
    expect(block).toContain("· 定了的事");
    expect(decisionsText(store.memory)).toMatch(
      /^负责人定了的事.*\n- AgentHerd 仓库的改动直接推 main，不开 PR 原话：「AgentHerd 以后直接推 main，不用开 PR」 \(记于 \d{4}-\d{2}-\d{2}\)$/,
    );
    expect(decisionsText(undefined)).toBe("");
  });

  it("the Herder sees how approval cards were answered", () => {
    const text = eventsPrompt([
      {
        kind: "approval",
        taskId: "abcdef1234",
        title: "修登录",
        text: "Run git push",
        outcome: "skipped",
      },
    ]);
    expect(text).toContain('approval card skipped by the owner: task abcdef12 "修登录"');
    expect(text).toContain("git push");
  });

  it("the Herder sees apart what reached the owner and what did not (ADR 0061)", () => {
    const text = eventsPrompt([
      { kind: "watchdog", taskId: "abcdef1234", title: "修登录", text: "same call 3 times" },
      {
        kind: "github",
        taskId: "abcdef1234",
        title: "修登录",
        text: "bob approved",
        shown: "board",
      },
      {
        kind: "unread",
        taskId: "abcdef1234",
        title: "修登录",
        text: "顺便把 lint 修了",
        why: "任务被结束了",
        shown: "none",
      },
    ]);
    const [sent, unsent] = text.split("\n\n");
    expect(sent).toMatch(/^\[Already sent to the owner, not from the owner\]\n- watchdog alarm:/);
    expect(sent).not.toContain("bob approved");
    expect(unsent).toMatch(/^\[Not pushed to the owner, not from the owner/);
    expect(unsent).toContain(
      'activity on the task\'s pull request (on the task board): task abcdef12 "修登录"',
    );
    expect(unsent).toContain(
      `the owner's message for task abcdef12 "修登录" was never read: the task ended first (任务被结束了)`,
    );
    expect(unsent).toContain('The message: "顺便把 lint 修了"');
    // Only what was not sent: no empty group.
    expect(eventsPrompt([{ kind: "github", title: "x", text: "y", shown: "none" }])).toMatch(
      /^\[Not pushed to the owner/,
    );
  });
});

describe("the owner's profile card (ADR 0091)", () => {
  it("keeps what the owner shows about themselves without 「以后」, one entry per field", async () => {
    const { store, call } = setupTools("我叫我借此火，叫我火哥就行，最近在做 AgentHerd");
    expect(
      await call("memory", {
        operations: [
          { action: "add", kind: "profile", content: "称呼：火哥", evidence: "叫我火哥就行" },
          {
            action: "add",
            kind: "profile",
            content: "在做：AgentHerd",
            evidence: "最近在做 AgentHerd",
          },
        ],
      }),
    ).toContain("saved");
    const rows = store.memory.list({ kinds: ["profile"] });
    expect(rows.map((r) => r.abstract).sort()).toEqual(["在做：AgentHerd", "称呼：火哥"]);
  });

  it("a profile entry names one of its fields and rests on the owner's words", () => {
    const t = turn("叫我火哥就行");
    expect(
      opProblem({ action: "add", kind: "profile", content: "火哥", evidence: "叫我火哥就行" }, t),
    ).toMatch(/starts with one of its fields/);
    expect(opProblem({ action: "add", kind: "profile", content: "称呼：火哥" }, t)).toMatch(
      /need evidence/,
    );
    expect(
      opProblem(
        { action: "add", kind: "profile", content: "称呼：火哥", evidence: "叫我火哥就行" },
        t,
      ),
    ).toBeUndefined();
  });

  it("every turn brings the card first (ADR 0101)", async () => {
    const store = Store.open(":memory:");
    const meta = { actor: "owner", source: "owner_edit" } as const;
    store.memory.write([{ op: "add", kind: "owner", abstract: "报告用中文" }], meta);
    store.memory.write([{ op: "add", kind: "profile", abstract: "称呼：火哥" }], meta);
    const block = await turnMemory(store.memory, "报告用什么语言");
    expect(block.indexOf("称呼：火哥")).toBeGreaterThan(0);
    expect(block.indexOf("称呼：火哥")).toBeLessThan(block.indexOf("报告用中文"));
  });

  it("the prompt tells the Herder to call the owner by the card's 称呼 and when to save", () => {
    const system = systemPrompt("zh-CN");
    expect(system).toContain("主人画像 is the owner's profile card");
    expect(system).toContain("Each turn ends with [记忆召回]");
    expect(system).toContain("keep that lesson as experience in the same turn");
  });
});
