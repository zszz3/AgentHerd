import type { AppHints, Item, Rule, ToolCallInfo } from "@agentherd/protocol";
import { describe, expect, it } from "vitest";
import { BODY_MAX_LINES, itemBody, itemView } from "../src/inbox.ts";
import { APP_READ, APP_WRITE, AUTO_APPROVED, decide, LEAVES_MAC } from "../src/pipeline.ts";

const HOME = "/Users/me";

function item(toolCall?: Partial<ToolCallInfo>, over: Partial<Item> = {}): Item {
  const base: Item = {
    id: "i1",
    sessionId: "s1",
    profileId: "mock",
    cwd: "/work/proj",
    kind: "permission",
    state: "open",
    createdAt: "2026-11-04T00:00:00Z",
    title: "Run command",
    body: "",
    risk: "medium",
    ...over,
  };
  if (toolCall !== undefined)
    base.toolCall = { kind: "execute", title: "x", paths: [], ...toolCall };
  return base;
}

const allowAll: Rule = {
  id: "r-all",
  action: "allow",
  match: {},
  createdAt: "2026-11-04T00:00:00Z",
  createdBy: "owner",
};
const allowTest: Rule = { ...allowAll, id: "r-test", match: { command: "pnpm test*" } };
const denyPush: Rule = {
  ...allowAll,
  id: "r-push",
  action: "deny",
  match: { command: "git push*" },
};

describe("decide", () => {
  it.each(["assist", "auto"] as const)("no rule → approved in %s (ADR 0029)", (mode) => {
    const r = decide(item({ command: "pnpm test" }), { mode, rules: [], home: HOME });
    expect(r.apply).toBe(true);
    expect(r.decision).toMatchObject({ action: "allow", source: "rule", reason: AUTO_APPROVED });
    expect(r.ruleId).toBeUndefined();
  });

  it("no rule → the owner in observe", () => {
    const r = decide(item({ command: "pnpm test" }), { mode: "observe", rules: [], home: HOME });
    expect(r.apply).toBe(false);
    expect(r.decision).toMatchObject({ action: "escalate", reason: "no rule matched" });
  });

  it.each(["git commit -am wip", "sudo ls", "cat ~/.ssh/id_rsa", "rm -rf node_modules"])(
    "%s is approved: it stays on the Mac",
    (command) => {
      const r = decide(item({ command }), { mode: "assist", rules: [], home: HOME });
      expect(r.apply).toBe(true);
    },
  );

  it.each(["assist", "auto", "observe"] as const)(
    "git push asks in %s, even with an allow-all rule (ADR 0056)",
    (mode) => {
      const r = decide(item({ command: "cd app && git push origin main" }), {
        mode,
        rules: [allowAll],
        home: HOME,
      });
      expect(r).toMatchObject({ apply: false, decision: { action: "escalate", risk: "high" } });
      expect(r.decision.reason).toBe(`${LEAVES_MAC}push: pushes to a remote`);
    },
  );

  it("a step the owner allowed for the task runs; another one still asks", () => {
    const ctx = { mode: "assist" as const, rules: [], home: HOME, allowedSteps: ["push" as const] };
    expect(decide(item({ command: "git push -u origin fix" }), ctx).apply).toBe(true);
    const merge = decide(item({ command: "gh pr merge 12 --squash" }), ctx);
    expect(merge).toMatchObject({
      apply: false,
      decision: { reason: `${LEAVES_MAC}merge: merges a pull request` },
    });
  });

  describe("a turn a pull request woke (ADR 0064)", () => {
    const branches: Record<string, string> = { "/work/proj": "fix-login", "/work/other": "main" };
    const ctx = {
      mode: "auto" as const,
      rules: [allowAll],
      home: HOME,
      allowedSteps: ["push", "pull-request", "comment", "merge"] as const,
      pullRequestTurn: {
        branches: ["fix-login"],
        currentBranch: (dir: string) => branches[dir],
      },
    };

    it.each([
      "git push",
      "git push origin",
      "git push origin fix-login",
      "git push -u origin HEAD",
      "git push --force-with-lease origin fix-login",
      "git push origin +fix-login",
      "git push origin HEAD:refs/heads/fix-login",
      "cd /work/proj && git push",
    ])("%s pushes to the pull request's branch and runs", (command) => {
      expect(decide(item({ command }), ctx).apply).toBe(true);
    });

    it.each([
      ["git push origin main", "push"],
      ["git push origin fix-login main", "push"],
      ["git push --all origin", "push"],
      ["git push --tags", "push"],
      ["git push origin :fix-login", "push"],
      ["cd /work/other && git push", "push"],
      ["git -C /work/other push", "push"],
      ["gh pr comment 12 --body done", "comment"],
      ["gh pr merge 12 --squash", "merge"],
      ["gh pr create --fill", "pull-request"],
    ])("%s asks again", (command, step) => {
      const r = decide(item({ command }), ctx);
      expect(r).toMatchObject({ apply: false, decision: { action: "escalate", risk: "high" } });
      expect(r.decision.reason).toMatch(
        new RegExp(`^${LEAVES_MAC}${step}: .* \\[pull request turn\\]$`),
      );
    });

    it("a push from a folder on no branch asks", () => {
      const r = decide(item({ command: "git push" }, { cwd: "/work/detached" }), ctx);
      expect(r.apply).toBe(false);
    });

    it("an app call that sends asks, even when the task allowed sending", () => {
      const r = decide(
        item({
          kind: "app",
          title: "Gmail: Send email",
          command: "GMAIL_SEND_EMAIL",
          appHints: { readOnly: false, create: true, update: false, destructive: false },
        }),
        { ...ctx, allowedSteps: ["send"] },
      );
      expect(r.apply).toBe(false);
    });

    it("work that stays on the Mac runs as before", () => {
      expect(decide(item({ command: "pnpm test" }), ctx).apply).toBe(true);
      expect(decide(item({ command: "git commit -am fix" }), ctx).apply).toBe(true);
    });
  });

  it("an app tool that sends for the owner asks", () => {
    const r = decide(
      item({
        kind: "app",
        title: "Gmail: Send email",
        command: "GMAIL_SEND_EMAIL",
        appHints: { readOnly: false, create: true, update: false, destructive: false },
      }),
      { mode: "auto", rules: [], home: HOME },
    );
    expect(r).toMatchObject({
      apply: false,
      decision: { reason: `${LEAVES_MAC}send: speaks for the owner` },
    });
  });

  it("assist applies an allow rule", () => {
    const r = decide(item({ command: "pnpm test" }), {
      mode: "assist",
      rules: [allowTest],
      home: HOME,
    });
    expect(r).toMatchObject({
      apply: true,
      ruleId: "r-test",
      decision: { action: "allow", source: "rule" },
    });
  });

  it("assist applies a deny rule", () => {
    const r = decide(item({ command: "git push" }), {
      mode: "assist",
      rules: [allowAll, denyPush],
      home: HOME,
    });
    expect(r).toMatchObject({ apply: true, decision: { action: "deny" } });
  });

  it("observe never applies; it records a suggestion", () => {
    const r = decide(item({ command: "pnpm test" }), {
      mode: "observe",
      rules: [allowTest],
      home: HOME,
    });
    expect(r.apply).toBe(false);
    expect(r.decision.action).toBe("escalate");
    expect(r.suggestion).toMatchObject({ action: "allow", reason: "rule r-test" });
  });

  it.each(["assist", "auto", "observe"] as const)(
    "a mass delete beats an allow-all rule in %s",
    (mode) => {
      const r = decide(item({ command: "sudo rm -rf /" }), { mode, rules: [allowAll], home: HOME });
      expect(r.apply).toBe(false);
      expect(r.decision).toMatchObject({ action: "escalate", risk: "high" });
      expect(r.decision.reason).toMatch(/^mass delete:/);
    },
  );

  it("a non-permission item escalates", () => {
    const r = decide(item(undefined, { kind: "notification" }), {
      mode: "auto",
      rules: [allowAll],
      home: HOME,
    });
    expect(r).toMatchObject({ apply: false, decision: { action: "escalate" } });
  });

  it("an exception escalates with high risk, never allows", () => {
    const rules = new Proxy([allowAll], {
      get(target, key, receiver) {
        if (key === Symbol.iterator) throw new Error("boom");
        return Reflect.get(target, key, receiver);
      },
    });
    const r = decide(item({ command: "pnpm test" }), { mode: "auto", rules, home: HOME });
    expect(r.apply).toBe(false);
    expect(r.decision).toMatchObject({ action: "escalate", risk: "high" });
    expect(r.decision.reason).toContain("boom");
  });
});

describe("item card", () => {
  it("shows the command and paths, redacted", () => {
    const view = itemView(
      item({
        command: "curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwx' https://x",
        paths: ["/work/proj/a"],
      }),
      "no rule matched",
    );
    expect(view.kind).toBe("item");
    expect(view.body).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(view.body).toContain("/work/proj/a");
    expect(view.options.map((o) => o.action)).toEqual(["allow", "deny", "skip"]);
  });

  it("redacts given secret values", () => {
    const body = itemBody(item({ command: "echo hunter2-secret" }), {
      API_TOKEN: "hunter2-secret",
    });
    expect(body).not.toContain("hunter2-secret");
  });

  it(`caps the body at ${BODY_MAX_LINES} lines`, () => {
    const command = Array.from({ length: 50 }, (_, i) => `echo ${i}`).join("\n");
    const lines = itemBody(item({ command })).split("\n");
    expect(lines).toHaveLength(BODY_MAX_LINES);
    expect(lines.at(-1)).toBe("… 31 more lines");
  });

  it("adds the agent's justification as the reason", () => {
    const body = itemBody(
      item({
        command: "echo hello > out.txt",
        rawInput: { command: "echo hello > out.txt", justification: " Needs a write. " },
      }),
    );
    expect(body.split("\n")).toEqual(["echo hello > out.txt", "Reason: Needs a write."]);
    expect(itemBody(item({ command: "ls", rawInput: { justification: 3 } }))).toBe("ls");
  });
});

describe("app calls (docs/spec/09-agent-tools.md §3)", () => {
  const app = (hints?: AppHints, command = "GMAIL_SEND_EMAIL") =>
    item({
      kind: "app",
      title: "Gmail: Send email",
      command,
      ...(hints ? { appHints: hints } : {}),
    });
  const none: AppHints = { readOnly: false, create: false, update: false, destructive: false };

  it.each(["observe", "assist", "auto"] as const)("a read-only tool runs in %s", (mode) => {
    const r = decide(app({ ...none, readOnly: true }, "GMAIL_FETCH_EMAILS"), {
      mode,
      rules: [],
      home: HOME,
    });
    expect(r.apply).toBe(true);
    expect(r.decision).toMatchObject({ action: "allow", reason: APP_READ });
  });

  it("a write that deletes nothing runs in assist, asks in observe", () => {
    const write = app({ ...none, create: true }, "NOTION_CREATE_PAGE");
    expect(decide(write, { mode: "assist", rules: [], home: HOME })).toMatchObject({
      apply: true,
      decision: { action: "allow", reason: APP_WRITE },
    });
    expect(decide(write, { mode: "observe", rules: [], home: HOME })).toMatchObject({
      apply: false,
      decision: { action: "escalate" },
    });
  });

  it("a destructive tool or one without hints asks the owner", () => {
    const destructive = decide(app({ ...none, update: true, destructive: true }), {
      mode: "assist",
      rules: [],
      home: HOME,
    });
    expect(destructive).toMatchObject({
      apply: false,
      decision: { action: "escalate", risk: "high" },
    });
    expect(decide(app(), { mode: "auto", rules: [], home: HOME })).toMatchObject({
      apply: false,
      decision: { action: "escalate" },
    });
    expect(decide(app(none), { mode: "auto", rules: [], home: HOME }).apply).toBe(false);
  });

  it("the owner's rules come first", () => {
    const denyGmail: Rule = {
      ...allowAll,
      id: "r-g",
      action: "deny",
      match: { toolKind: "app", command: "GMAIL_*" },
    };
    const r = decide(app({ ...none, readOnly: true }, "GMAIL_FETCH_EMAILS"), {
      mode: "assist",
      rules: [denyGmail],
      home: HOME,
    });
    expect(r).toMatchObject({ apply: true, decision: { action: "deny" }, ruleId: "r-g" });
    const allowDelete: Rule = {
      ...allowAll,
      id: "r-d",
      match: { toolKind: "app", command: "GMAIL_DELETE_*" },
    };
    const d = decide(app({ ...none, destructive: true }, "GMAIL_DELETE_MESSAGE"), {
      mode: "assist",
      rules: [allowDelete],
      home: HOME,
    });
    expect(d).toMatchObject({ apply: true, decision: { action: "allow" }, ruleId: "r-d" });
  });
});
