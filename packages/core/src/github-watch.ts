// Pull requests that tasks open are followed on GitHub (docs/spec/04-herder.md "Pull requests", ADR 0047).
// Comments and reviews by people wake the task and tell the owner; failed checks go to the task
// to fix; a merge or close is told once and ends the watch. Bots never wake a task.

import { spawn } from "node:child_process";
import type { Clock, Timer } from "./clock.ts";
import { type HerdContext, say } from "./herd-context.ts";
import type { NoticeLevel } from "./notices.ts";
import type { PrWatch } from "./store.ts";
import { notice } from "./task-report.ts";

/** Runs `gh` with these arguments; resolves its stdout, rejects with its stderr. */
export type GhRun = (args: string[]) => Promise<string>;

export interface GitHubOptions {
  run: GhRun;
  /** Minutes between two looks at the followed pull requests. */
  pollMinutes?: number;
}

export const GITHUB_POLL_MINUTES = 2;
/** A pull request with no activity for this long is no longer followed. */
export const GITHUB_WATCH_DAYS = 14;
/** At most this many wakes per pull request; later activity is only told to the owner. */
export const GITHUB_MAX_WAKES = 20;
const GH_TIMEOUT_MS = 60_000;
const BODY_MAX = 1_500;
const SNIPPET_MAX = 80;
const PROMPT_ITEMS_MAX = 20;

export const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;

export function runGh(env: NodeJS.ProcessEnv = process.env): GhRun {
  return (args) =>
    new Promise((resolve, reject) => {
      const child = spawn("gh", args, { env, windowsHide: true });
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill(), GH_TIMEOUT_MS);
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        err += d.toString("utf8");
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(err.trim() || `gh exited with ${code}`));
      });
    });
}

/** Pull request links in a text, without repeats. */
export function prLinks(text: string): { repo: string; number: number; url: string }[] {
  const seen = new Set<string>();
  const links: { repo: string; number: number; url: string }[] = [];
  for (const m of text.matchAll(PR_URL)) {
    const repo = (m[1] ?? "").replace(/\.git$/, "");
    const number = Number(m[2]);
    const key = `${repo.toLowerCase()}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ repo, number, url: `https://github.com/${repo}/pull/${number}` });
  }
  return links;
}

/** A comment or review, as far as AgentHerd needs it. */
export interface PrActivity {
  id: string;
  login: string;
  bot: boolean;
  kind: "comment" | "review" | "inline";
  /** Review state, e.g. APPROVED or CHANGES_REQUESTED. */
  state?: string;
  body: string;
  where?: string;
}

export interface PrView {
  state: "OPEN" | "MERGED" | "CLOSED";
  author: string;
  createdAt: string;
  headSha: string;
  /** Checks still running. */
  pending: boolean;
  failed: string[];
  activity: PrActivity[];
}

interface GhUser {
  login?: string;
  type?: string;
}

function isBot(user: GhUser | undefined): boolean {
  const login = user?.login ?? "";
  return user?.type === "Bot" || login.endsWith("[bot]");
}

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"]);

/** Reads a pull request with `gh`: its state, checks, comments and reviews. */
export async function readPr(gh: GhRun, repo: string, number: number): Promise<PrView> {
  const json = async <T>(args: string[]): Promise<T> => JSON.parse(await gh(args)) as T;
  const [view, comments, reviews, inline] = await Promise.all([
    json<{
      state: PrView["state"];
      author?: { login?: string };
      createdAt: string;
      headRefOid: string;
      statusCheckRollup?: {
        name?: string;
        context?: string;
        status?: string;
        conclusion?: string;
        state?: string;
      }[];
    }>([
      "pr",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "state,author,createdAt,headRefOid,statusCheckRollup",
    ]),
    json<{ id: number; user?: GhUser; body?: string }[]>([
      "api",
      `repos/${repo}/issues/${number}/comments?per_page=100`,
    ]),
    json<{ id: number; user?: GhUser; body?: string; state?: string }[]>([
      "api",
      `repos/${repo}/pulls/${number}/reviews?per_page=100`,
    ]),
    json<{ id: number; user?: GhUser; body?: string; path?: string; line?: number | null }[]>([
      "api",
      `repos/${repo}/pulls/${number}/comments?per_page=100`,
    ]),
  ]);
  const checks = view.statusCheckRollup ?? [];
  const activity: PrActivity[] = [
    ...comments.map((c) => ({
      id: `c${c.id}`,
      login: c.user?.login ?? "?",
      bot: isBot(c.user),
      kind: "comment" as const,
      body: c.body ?? "",
    })),
    ...reviews
      // A review whose words are all in its line comments has an empty body; those come below.
      .filter((r) => r.state !== "PENDING" && !(r.state === "COMMENTED" && (r.body ?? "") === ""))
      .map((r) => ({
        id: `r${r.id}`,
        login: r.user?.login ?? "?",
        bot: isBot(r.user),
        kind: "review" as const,
        body: r.body ?? "",
        ...(r.state === undefined ? {} : { state: r.state }),
      })),
    ...inline.map((c) => ({
      id: `i${c.id}`,
      login: c.user?.login ?? "?",
      bot: isBot(c.user),
      kind: "inline" as const,
      body: c.body ?? "",
      ...(c.path === undefined ? {} : { where: c.line ? `${c.path}:${c.line}` : c.path }),
    })),
  ];
  return {
    state: view.state,
    author: view.author?.login ?? "",
    createdAt: view.createdAt,
    headSha: view.headRefOid,
    pending: checks.some((c) =>
      c.status !== undefined
        ? c.status !== "COMPLETED"
        : c.state === "PENDING" || c.state === "EXPECTED",
    ),
    failed: checks
      .filter((c) => FAILED.has(c.conclusion ?? "") || FAILED.has(c.state ?? ""))
      .map((c) => c.name ?? c.context ?? "?"),
    activity,
  };
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** The task this text came from, as far as a pull request watch needs it. */
export interface WatchTask {
  /** Wakes the task with a prompt (an ended task is started again). */
  prompt(taskId: string, text: string): Promise<unknown>;
}

export class GitHubWatch {
  private readonly ctx: HerdContext;
  private readonly gh: GhRun;
  private readonly clock: Clock;
  private readonly pollMs: number;
  private readonly tasks: WatchTask;
  private timer: Timer | undefined;
  private running = false;
  private chain: Promise<void> = Promise.resolve();
  /** Tasks whose ended turn is not yet looked at; their pull requests wait for it. */
  private readonly turnsPending = new Set<string>();
  private self: string | undefined;

  constructor(ctx: HerdContext, options: GitHubOptions, tasks: WatchTask) {
    this.ctx = ctx;
    this.gh = options.run;
    this.clock = ctx.clock;
    this.pollMs = (options.pollMinutes ?? GITHUB_POLL_MINUTES) * 60_000;
    this.tasks = tasks;
  }

  start(): void {
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    this.timer?.cancel();
    this.timer = undefined;
  }

  /** Waits for the looks already asked for (tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  /**
   * A task's turn ended with this reply: starts following pull requests it opened, and counts
   * what the agent wrote on its pull requests during the turn as its own.
   */
  turnEnded(taskId: string, text: string): void {
    this.turnsPending.add(taskId);
    this.enqueue(async () => {
      try {
        await this.lookAfterTurn(taskId, text);
      } finally {
        this.turnsPending.delete(taskId);
      }
    });
  }

  /**
   * The owner sent this text to a task: pull requests linked in it are followed for that task,
   * whoever opened them and whatever their state (ADR 0051).
   */
  handed(taskId: string, text: string): void {
    const links = prLinks(text);
    if (links.length === 0) return;
    this.enqueue(async () => {
      const { store } = this.ctx;
      for (const link of links) {
        const known = store.prWatches().find((w) => sameWatch(w, link));
        if (known !== undefined) {
          if (known.taskId !== taskId || known.handed !== true) {
            store.savePrWatch({ ...known, taskId, handed: true });
            store.audit("github.following", { taskId, url: link.url, handed: true });
          }
          continue;
        }
        const pr = await this.read(link.repo, link.number);
        const now = this.clock.now().toISOString();
        const closed = closedState(pr);
        store.savePrWatch({
          repo: link.repo,
          number: link.number,
          url: link.url,
          taskId,
          seen: pr.activity.map((a) => a.id),
          ...(pr.failed.length > 0 && !pr.pending ? { ciFailedSha: pr.headSha } : {}),
          wakes: 0,
          createdAt: now,
          activeAt: now,
          handed: true,
          ...(closed === undefined ? {} : { closed }),
        });
        store.audit("github.following", { taskId, url: link.url, handed: true });
      }
    });
  }

  /** Looks at every followed pull request now. */
  poll(): Promise<void> {
    this.enqueue(() => this.pollAll());
    return this.chain;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = this.clock.after(this.pollMs, () => {
      void this.poll().finally(() => this.schedule());
    });
  }

  private enqueue(job: () => Promise<void>): void {
    this.chain = this.chain.then(job).catch((error: Error) => this.failed(error));
  }

  private failed(error: Error): void {
    // gh missing, logged out or offline: in the audit once per error; the owner hears when it
    // lasts (ADR 0050).
    this.ctx.sources.failed("github", error);
  }

  /** Reads a pull request; a read that worked means GitHub answers. */
  private async read(repo: string, number: number): Promise<PrView> {
    const pr = await readPr(this.gh, repo, number);
    this.ctx.sources.ok("github");
    return pr;
  }

  private async login(): Promise<string> {
    if (this.self === undefined) {
      this.self = (await this.gh(["api", "user", "--jq", ".login"])).trim();
    }
    return this.self;
  }

  private async lookAfterTurn(taskId: string, text: string): Promise<void> {
    const { store } = this.ctx;
    const f = this.ctx.following.get(taskId);
    const watches = store.prWatches();
    const known = new Set(watches.map((w) => `${w.repo.toLowerCase()}#${w.number}`));
    const links = prLinks(text).filter((l) => !known.has(`${l.repo.toLowerCase()}#${l.number}`));
    const mine = watches.filter((w) => w.taskId === taskId);
    if (links.length === 0 && mine.length === 0) return;
    const self = await this.login();
    for (const link of links) {
      const pr = await this.read(link.repo, link.number);
      // Only a pull request this task opened: not one it just mentioned.
      const startedAt = f?.task.startedAt ?? this.clock.now().toISOString();
      if (pr.author !== self || pr.createdAt < startedAt || pr.state !== "OPEN") {
        store.audit("github.not-followed", { taskId, url: link.url });
        continue;
      }
      const now = this.clock.now().toISOString();
      store.savePrWatch({
        repo: link.repo,
        number: link.number,
        url: link.url,
        taskId,
        seen: pr.activity.map((a) => a.id),
        ...(pr.failed.length > 0 && !pr.pending ? { ciFailedSha: pr.headSha } : {}),
        wakes: 0,
        createdAt: now,
        activeAt: now,
      });
      store.audit("github.following", { taskId, url: link.url });
    }
    for (const watch of mine) {
      // What the agent's account wrote while the task ran is the agent's own.
      const pr = await this.read(watch.repo, watch.number);
      const own = pr.activity.filter((a) => a.login === self && !watch.seen.includes(a.id));
      if (own.length > 0) {
        store.savePrWatch({ ...watch, seen: [...watch.seen, ...own.map((a) => a.id)] });
      }
      await this.check(store.prWatches().find((w) => sameWatch(w, watch)) ?? watch, pr);
    }
  }

  private async pollAll(): Promise<void> {
    const { store } = this.ctx;
    const now = this.clock.now().getTime();
    for (const watch of store.prWatches()) {
      if (now - Date.parse(watch.activeAt) > GITHUB_WATCH_DAYS * 24 * 60 * 60 * 1000) {
        store.deletePrWatch(watch);
        store.audit("github.expired", { taskId: watch.taskId, url: watch.url });
        continue;
      }
      if (watch.paused === true) continue;
      // While the task works, what its account writes is the agent's; look after the turn.
      const f = this.ctx.following.get(watch.taskId);
      if (this.turnsPending.has(watch.taskId) || f?.busy === true || f?.reopening !== undefined) {
        continue;
      }
      try {
        await this.check(watch, await this.read(watch.repo, watch.number));
      } catch (error) {
        this.failed(error as Error);
      }
    }
  }

  /** Acts on what is new on a pull request since the watch last looked. */
  private async check(seenWatch: PrWatch, pr: PrView): Promise<void> {
    let watch = seenWatch;
    const { ctx } = this;
    const { store, texts } = ctx;
    const f = ctx.following.get(watch.taskId);
    const label = f?.task.title;
    const tell = (text: string, tone?: "alarm"): Promise<void> =>
      say(ctx, text, label, tone, f === undefined ? undefined : watch.taskId);
    const event = (text: string, level: NoticeLevel): void => {
      if (f === undefined) return;
      ctx.herder()?.event({
        kind: "github",
        taskId: f.task.id,
        title: f.task.title,
        text,
        ...(level === "push" ? {} : { shown: level === "board" ? "board" : "none" }),
      });
    };

    // Merged or closed: noted once (on the board unless the owner asked otherwise, ADR 0061), and
    // the watch stays for 14 quiet days, so later comments still reach the task (ADR 0051).
    const closed = closedState(pr);
    if (closed !== undefined && watch.closed === undefined) {
      const text =
        closed === "merged" ? texts.prMerged(watch.number) : texts.prClosed(watch.number);
      watch = { ...watch, closed, activeAt: this.clock.now().toISOString() };
      store.savePrWatch(watch);
      store.audit("github.closed", { taskId: watch.taskId, url: watch.url, state: pr.state });
      const level = await notice(ctx, closed === "merged" ? "pr-merged" : "pr-closed", f, text);
      event(`${text} ${watch.url}`, level);
    } else if (closed === undefined && watch.closed !== undefined) {
      const { closed: _was, ...open } = watch;
      watch = { ...open, activeAt: this.clock.now().toISOString() };
      store.savePrWatch(watch);
      store.audit("github.reopened", { taskId: watch.taskId, url: watch.url });
      await notice(ctx, "pr-reopened", f, texts.prReopened(watch.number));
    }

    const fresh = pr.activity.filter((a) => !watch.seen.includes(a.id));
    const people = fresh.filter((a) => !a.bot);
    const failedNow =
      closed === undefined &&
      pr.failed.length > 0 &&
      !pr.pending &&
      pr.headSha !== watch.ciFailedSha
        ? pr.failed
        : [];
    if (fresh.length === 0 && failedNow.length === 0) return;

    const next: PrWatch = {
      ...watch,
      seen: [...watch.seen, ...fresh.map((a) => a.id)],
      ...(failedNow.length > 0 ? { ciFailedSha: pr.headSha } : {}),
    };
    // A bare approval is news for the owner, not work for the task.
    const work = people.filter((a) => a.body.trim() !== "" || a.state === "CHANGES_REQUESTED");
    const approvals = people.filter((a) => a.state === "APPROVED" && a.body.trim() === "");
    if (people.length === 0 && failedNow.length === 0) {
      store.savePrWatch(next);
      return;
    }
    next.activeAt = this.clock.now().toISOString();
    const wake =
      (work.length > 0 || failedNow.length > 0) &&
      watch.wakes < GITHUB_MAX_WAKES &&
      f !== undefined;
    if (wake) next.wakes = watch.wakes + 1;
    store.savePrWatch(next);
    store.audit("github.activity", {
      taskId: watch.taskId,
      url: watch.url,
      comments: work.length,
      approvals: approvals.length,
      failed: failedNow,
      woke: wake,
    });

    const activity = (): string => {
      const who = [...new Set(work.map((a) => a.login))].join(", ");
      const first = work[work.length - 1];
      return texts.prActivity(
        watch.number,
        who,
        clip((first?.body ?? "").split("\n")[0] ?? "", SNIPPET_MAX),
        false,
      );
    };
    const checksFailed = (): Promise<void> =>
      tell(texts.prChecksFailed(watch.number, failedNow.join(", "), false), "alarm");
    if (wake) {
      const parts = [
        ...work
          .slice(-PROMPT_ITEMS_MAX)
          .map((a) =>
            texts.prItem(
              a.state === undefined || a.state === "COMMENTED"
                ? a.login
                : `${a.login} (${a.state})`,
              a.kind,
              clip(a.body, BODY_MAX),
              a.where,
            ),
          ),
        ...(failedNow.length > 0 ? [texts.prChecksPart(failedNow.join(", "), watch.url)] : []),
      ];
      void this.tasks
        .prompt(
          watch.taskId,
          texts.prPrompt(watch.url, parts.join("\n"), watch.handed === true, watch.closed),
        )
        .catch(async (error: Error) => {
          store.audit("github.wake-error", { taskId: watch.taskId, message: error.message });
          // The task never read it (it ended first): the owner hears it instead (ADR 0061).
          if (work.length > 0) await tell(activity());
          if (failedNow.length > 0) await checksFailed();
        });
    }
    // Work handed to the task is the task's to tell (ADR 0049); comments no task can take and
    // failed checks no task fixes are pushed; a bare approval goes on the board (ADR 0061).
    let pushed = false;
    let boarded = false;
    if (work.length > 0 && !wake) {
      await tell(activity());
      pushed = true;
    }
    for (const a of approvals) {
      const level = await notice(ctx, "pr-approved", f, texts.prApproved(watch.number, a.login));
      if (level === "push") pushed = true;
      if (level === "board") boarded = true;
    }
    if (failedNow.length > 0 && !wake) {
      await checksFailed();
      pushed = true;
    }
    event(
      [
        ...work.map((a) => `${a.login}: ${clip(a.body, SNIPPET_MAX * 2)}`),
        ...approvals.map((a) => `${a.login} approved`),
        ...(failedNow.length > 0 ? [`checks failed: ${failedNow.join(", ")}`] : []),
      ].join("\n"),
      pushed ? "push" : boarded ? "board" : "off",
    );
  }
}

function closedState(pr: PrView): "merged" | "closed" | undefined {
  return pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : undefined;
}

function sameWatch(
  a: { repo: string; number: number },
  b: { repo: string; number: number },
): boolean {
  return a.repo.toLowerCase() === b.repo.toLowerCase() && a.number === b.number;
}
