// The Herder's tools (docs/spec/04-herder.md §1). None of them answers an item, runs a command
// or writes a file.

import { statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  describeWhen,
  type FeedSource,
  type HerderHost,
  type OwnerImage,
  type Schedule,
  type ScheduleWhen,
  type Task,
} from "@agentherd/core";
import type { AgentTool, AgentToolResult } from "@agentherd/herder-loop";
import { OUTBOUND_STEPS, type OutboundStep } from "@agentherd/rules";
import { arr, bool, int, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { agentForModel } from "./agent-models.ts";
import { decisionsText, lessonsText, ownerPrefsText, pastLessons } from "./memory.ts";
import { placeModels, TIERS, type TierPlacement, tiersText } from "./model-guide.ts";
import { findProjects, foundText, nameKey } from "./project-find.ts";
import { composeTaskPrompt, HERDER_LABEL } from "./prompt.ts";

/** What the current Herder turn is about. */
export interface TurnContext {
  /** `intake`: new work the owner tapped 「开任务」 on, or their automatic watch found (ADR 0052). */
  /** `scheduled`: a schedule the owner made is due (ADR 0055); its saved words are the owner's. */
  kind: "owner" | "answer" | "event" | "intake" | "scheduled";
  /** The owner's words this turn may pass on: the message, or the one the answer belongs to. */
  ownerText: string;
  /**
   * What the owner typed: the message, or for an answer the message it belongs to (a tapped
   * button is not their words). Memory evidence must come from it (ADR 0038).
   */
  typedText: string;
  /** The owner's images this turn; tasks started or messaged for the owner get them. */
  images: OwnerImage[];
  asked: boolean;
  notified: boolean;
  /**
   * Folders the owner typed or picked with a button this turn, and the one project project_find
   * matched by a name in the owner's words (ADR 0043). session_start runs only in one of them
   * (ADR 0035): a folder from earlier turns or the Herder's own guess is never used.
   */
  pickedDirs: string[];
}

/** The answer that lets the owner type their own (ADR 0035). */
/** Whether the owner's words name the project (case, `-`, `_` and spaces ignored). */
export function namedBy(typed: string, name: string): boolean {
  const key = nameKey(name.trim().replace(/^.*[\\/]/, ""));
  return key !== "" && nameKey(typed).includes(key);
}

export function otherOption(locale: string): string {
  return locale === "en" ? "Other" : "其他";
}

// `~`, `/` or a Windows drive (`C:\`) starts a path; it ends at whitespace or punctuation.
const PATH_RE = /(?:^|[\s"'`(（「：])((?:~|\/|[A-Za-z]:[\\/])[^\s"'`)）」，。；;,!?！？]*)/g;

function homePath(raw: string): boolean {
  return raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\");
}

/** Absolute and `~/` paths in the owner's words, resolved. */
export function pathsIn(text: string, home: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PATH_RE)) {
    const raw = (m[1] ?? "").replace(/[.:：]+$/, "");
    if (raw === "" || raw === "/" || !(homePath(raw) || isAbsolute(raw))) continue;
    const dir = homePath(raw) ? resolve(join(home, raw.slice(1))) : resolve(raw);
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

/**
 * The folders an answer to `ask` picks: the whole answer when it is one path (a button can
 * hold a path with spaces, like `项目 2`), and the paths in it.
 */
export function pathsInAnswer(answer: string, home: string): string[] {
  const whole = answer.trim();
  const out = homePath(whole)
    ? [resolve(join(home, whole.slice(1)))]
    : isAbsolute(whole)
      ? [resolve(whole)]
      : [];
  for (const p of pathsIn(answer, home)) if (!out.includes(p)) out.push(p);
  return out;
}

/** Same folder; Windows and macOS paths ignore case. */
export function samePath(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "linux" ? a === b : a.toLowerCase() === b.toLowerCase();
}

function ok(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** True when `part` appears in `whole`, ignoring whitespace differences. */
export function isVerbatim(part: string, whole: string): boolean {
  const p = normalize(part);
  return p !== "" && normalize(whole).includes(p);
}

/** Open tasks whose id starts with the query, or whose title has every word of it. */
export function findTasks(tasks: Task[], query: string): Task[] {
  const q = query.trim().toLowerCase();
  const byId = tasks.filter((t) => t.id.startsWith(q));
  if (byId.length > 0) return byId;
  const words = q.split(/\s+/).filter((w) => w !== "");
  return tasks.filter((t) => words.every((w) => t.title.toLowerCase().includes(w)));
}

/** A directory from an absolute path or `~/path`. Names go through project_find and the owner. */
export function resolveProject(host: HerderHost, project: string): string {
  const p = project.trim();
  if (homePath(p)) return resolve(join(host.userHome, p.slice(1)));
  if (isAbsolute(p)) return resolve(p);
  throw new Error(
    `"${p}" is not a path; call project_find with the name and ask the owner to pick the folder`,
  );
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function oneTask(host: HerderHost, query: string): Task {
  const matches = findTasks(host.openTasks(), query);
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  if (matches.length === 0) throw new Error(`no open task matches "${query}"`);
  throw new Error(
    `several open tasks match "${query}": ${matches.map((t) => t.id.slice(0, 8)).join(", ")}`,
  );
}

/** The owner's connected apps, when there are any. */
function appLines(host: HerderHost): string[] {
  const apps = host.apps?.() ?? [];
  if (apps.length === 0) return [];
  return [
    `Connected apps (agents other than Pi use them through their agentherd tools): ${apps.join(", ")}`,
  ];
}

/** The owner's mail watches, when mail can be watched (ADR 0048). */
function mailLines(host: HerderHost): string[] {
  if (host.mailWatches === undefined) return [];
  const watches = host.mailWatches();
  return [
    "Mail watches (AgentHerd tells the owner about new matching mail every few minutes):",
    ...(watches.length === 0
      ? ["(none)"]
      : watches.map(
          (w) => `- ${w.id.slice(0, 8)} "${w.about}" query=${w.query} since=${w.createdAt}`,
        )),
  ];
}

/** The owner's 小红书 / 知乎 accounts that are turned on, and what each tells (ADR 0058). */
function socialLines(host: HerderHost): string[] {
  const socials = host.socialWatches?.() ?? [];
  if (socials.length === 0) return [];
  return [
    "Platforms (the owner's accounts; agents use them through their agentherd tools, writes ask the owner; AgentHerd looks for new notices about every 20 minutes):",
    ...socials.map(
      (s) =>
        `- ${s.platform} (${s.name}) ${s.ready ? "signed in" : "not signed in (the owner scans a code in the app)"}; tells: ${
          (["mentions", "likes", "follows"] as const).filter((k) => s.watch[k]).join(", ") ||
          "nothing"
        }`,
    ),
  ];
}

/** New-work watches (ADR 0052). */
function intakeLines(host: HerderHost): string[] {
  if (host.intakeWatches === undefined) return [];
  const watches = host.intakeWatches();
  return [
    "New-work watches (AgentHerd offers new GitHub items with 「开任务 / 忽略」, or starts them when auto):",
    ...(watches.length === 0
      ? ["(none)"]
      : watches.map(
          (w) =>
            `- ${w.id.slice(0, 8)} "${w.about}" kind=${w.kind}${w.repo === undefined ? "" : ` repo=${w.repo}`}${w.label === undefined ? "" : ` label=${w.label}`} auto=${w.auto}`,
        )),
  ];
}

/** What the Herder does at set times (ADR 0055). */
function scheduleLines(host: HerderHost): string[] {
  if (host.schedules === undefined) return [];
  const list = host.schedules();
  return [
    "Schedules (what you do at set times; the owner asked for each):",
    ...(list.length === 0 ? ["(none)"] : list.map(scheduleLine)),
  ];
}

export function scheduleLine(s: Schedule): string {
  const next = s.paused ? "paused" : `next ${localTime(s.nextAt)}`;
  return `- ${s.id.slice(0, 8)} "${s.about}" ${describeWhen(s.when)}, ${next}: ${s.prompt.replace(/\s+/g, " ").slice(0, 200)}`;
}

/** An ISO time as the owner's local "YYYY-MM-DD HH:MM". */
function localTime(iso: string | undefined): string {
  if (iso === undefined) return "-";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The tool's `kind`/`at`/`days`/`hours` as a schedule time. */
export function whenFrom(args: {
  kind: string;
  at?: string;
  days?: number[];
  hours?: number;
}): ScheduleWhen {
  if (args.kind === "every") {
    if (args.hours === undefined) throw new Error("every needs hours");
    return { kind: "every", hours: args.hours };
  }
  if (args.at === undefined) throw new Error(`${args.kind} needs at`);
  if (args.kind === "once") return { kind: "once", at: args.at };
  if (args.kind === "daily") {
    return { kind: "daily", at: args.at, ...(args.days === undefined ? {} : { days: args.days }) };
  }
  throw new Error('kind must be "daily", "every" or "once"');
}

function oneSchedule(host: HerderHost, query: string): Schedule {
  const q = normalize(query);
  const found = (host.schedules?.() ?? []).filter(
    (s) => s.id.startsWith(query.trim()) || normalize(s.about).includes(q),
  );
  const only = found[0];
  if (found.length === 1 && only !== undefined) return only;
  if (found.length === 0) throw new Error(`no schedule matches "${query}"`);
  throw new Error(
    `several schedules match "${query}": ${found.map((s) => `${s.id.slice(0, 8)} "${s.about}"`).join(", ")}`,
  );
}

/** Schedules exist only because the owner asked, and hold at once (ADR 0055). */
function scheduleTools(host: HerderHost, turn: () => TurnContext) {
  const told = "; tell the owner in one short line what you will do and when, in their words";
  return [
    {
      name: "schedule_add",
      label: "Do something at set times",
      description:
        "Only when the owner asks you to do something at set times or later (e.g. 「每天早上 9 点看看 PI-Desktop 有没有新 issue」, 「明天下午三点提醒我交周报」). It holds at once: at each time `prompt` comes back to you as a turn and you do it then (answer, start a task, or say nothing). Never make one on your own.",
      parameters: scheduleAddSchema,
      execute: async (
        _id: string,
        args: {
          about: string;
          prompt: string;
          kind: string;
          at?: string;
          days?: number[];
          hours?: number;
        },
      ) => {
        ownerOnly(turn, "make schedules");
        const made = host.addSchedule?.({
          about: args.about,
          prompt: args.prompt,
          when: whenFrom(args),
        });
        if (made === undefined) throw new Error("schedules are not available here");
        return ok(`scheduled:\n${scheduleLine(made)}${told}`);
      },
    },
    {
      name: "schedule_change",
      label: "Change a schedule",
      description:
        "Changes, pauses or resumes a schedule when the owner asks. Give kind with at/days/hours only to change when it runs.",
      parameters: scheduleChangeSchema,
      execute: async (
        _id: string,
        args: {
          schedule: string;
          about?: string;
          prompt?: string;
          paused?: boolean;
          kind?: string;
          at?: string;
          days?: number[];
          hours?: number;
        },
      ) => {
        ownerOnly(turn, "change schedules");
        const old = oneSchedule(host, args.schedule);
        const changed = host.changeSchedule?.(old.id, {
          ...(args.about === undefined ? {} : { about: args.about }),
          ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
          ...(args.paused === undefined ? {} : { paused: args.paused }),
          ...(args.kind === undefined ? {} : { when: whenFrom({ ...args, kind: args.kind }) }),
        });
        if (changed === undefined) throw new Error("schedules are not available here");
        return ok(`changed:\n${scheduleLine(changed)}${told}`);
      },
    },
    {
      name: "schedule_remove",
      label: "Remove a schedule",
      description: "Removes a schedule when the owner no longer wants it.",
      parameters: scheduleRemoveSchema,
      execute: async (_id: string, args: { schedule: string }) => {
        ownerOnly(turn, "remove schedules");
        const old = oneSchedule(host, args.schedule);
        host.removeSchedule?.(old.id);
        return ok(`removed "${old.about}"`);
      },
    },
  ];
}

/** Watched sources that stopped answering (ADR 0050). */
function sourceLines(host: HerderHost): string[] {
  const down = host.sources?.() ?? [];
  if (down.length === 0) return [];
  return [
    "Not working now (the owner's pull request or mail updates are paused until it answers again):",
    ...down.map(
      (s) =>
        `- ${s.source === "github" ? "GitHub (gh)" : "Gmail (Composio)"} failing since ${s.since}: ${s.message.slice(0, 200)}${s.told ? " (owner told)" : ""}`,
    ),
  ];
}

/** A mail watch by id prefix or words of what it is about. */
function oneWatch(host: HerderHost, query: string): { id: string; about: string } {
  const q = normalize(query);
  const watches = host.mailWatches?.() ?? [];
  const found = watches.filter(
    (w) =>
      w.id.startsWith(query.trim()) ||
      normalize(w.about).includes(q) ||
      normalize(w.query).includes(q),
  );
  const only = found[0];
  if (found.length === 1 && only !== undefined) return only;
  if (found.length === 0) throw new Error(`no mail watch matches "${query}"`);
  throw new Error(
    `several mail watches match "${query}": ${found.map((w) => `${w.id.slice(0, 8)} "${w.about}"`).join(", ")}`,
  );
}

/** Ended tasks listed by session_list, newest first. */
export const ENDED_TASKS_LISTED = 15;

/** An open task, or else an ended one (session_prompt starts it again, ADR 0039). */
function anyTask(host: HerderHost, query: string): Task {
  const open = findTasks(host.openTasks(), query);
  if (open.length === 1 && open[0] !== undefined) return open[0];
  if (open.length > 1) return oneTask(host, query);
  const ended = findTasks(
    [...host.tasks()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    query,
  );
  if (ended.length === 1 && ended[0] !== undefined) return ended[0];
  if (ended.length === 0) throw new Error(`no task matches "${query}"`);
  throw new Error(
    `several tasks match "${query}": ${ended
      .slice(0, 5)
      .map((t) => `${t.id.slice(0, 8)} "${t.title}"`)
      .join(", ")}`,
  );
}

/** Tasks task_search lists at most. */
export const TASKS_FOUND_MAX = 10;

const taskSearchSchema = obj({
  query: str({ description: "Words to look for, e.g. 'pi-desktop issue'" }),
});

/**
 * Tasks with any of the words in their title, project or last report, the ones matching more
 * words first, then newest first.
 */
export function searchTasks(tasks: readonly Task[], query: string): Task[] {
  const words = query
    .toLowerCase()
    .split(/[\s,，、]+/)
    .filter((w) => w !== "");
  if (words.length === 0) return [];
  return tasks
    .map((t) => {
      const text = `${t.title}\n${t.project}\n${t.lastReport}`.toLowerCase();
      return { t, hits: words.filter((w) => text.includes(w)).length };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.t.updatedAt.localeCompare(a.t.updatedAt))
    .map((x) => x.t);
}

function taskLine(t: Task): string {
  return `- ${t.id.slice(0, 8)} [${t.stage}] "${t.title}" project=${t.project} agent=${t.agent} last="${t.lastReport}" updated=${t.updatedAt}`;
}

const sessionStartSchema = obj({
  project: opt(
    str({
      description:
        "Project folder: an absolute or ~/ path the owner typed or picked this turn, or the one project_find matched. Omit for work that needs no project.",
    }),
  ),
  profile: opt(
    str({
      description:
        "Only when the owner names an agent (e.g. dsh). Omit otherwise: AgentHerd picks the agent from the model.",
    }),
  ),
  name: str({
    description:
      'A short name for the task, 4 to 12 words or about 6 to 15 Chinese characters, in the owner\'s language: what the agent does, e.g. "pi-desktop：梳理可做的 issue". Shown on every report.',
  }),
  ownerText: str({ description: "The owner's request, copied exactly from their message" }),
  addedContext: opt(str({ description: "Anything you add, sent below the owner's words" })),
  model: opt(
    str({
      description:
        "Model name from session_list (e.g. deepseek-v4-pro); AgentHerd uses the first service offering it that answers. service/model picks one service. Omit to select from AgentHerd's configured models in tier order.",
    }),
  ),
  allowed: opt(
    arr(
      oneOf(OUTBOUND_STEPS, {
        description:
          "push: git push; pull-request: open or change a pull request; merge: merge one; comment: comment or review on GitHub; publish: npm publish, releases; deploy; send: mail or messages to people",
      }),
      {
        description:
          'Steps leaving the Mac that the owner\'s request itself asks for, e.g. "做完推上去开个 PR" → ["push", "pull-request"]. They run without asking, for this task only. Never add a step the owner did not ask for; "merge" only when they said merge. Every other such step asks the owner.',
      },
    ),
  ),
});
const taskSchema = obj({ task: str({ description: "Task id prefix or words of its title" }) });
const promptSchema = obj({
  task: str({ description: "Task id prefix or words of its title" }),
  text: str({
    description: "Text for the agent; the owner's words copied exactly if they are theirs",
  }),
  name: opt(
    str({ description: "A new short name for the task, only when this changes what it works on" }),
  ),
});
const askSchema = obj({
  question: str(),
  options: arr(str(), { minItems: 1, maxItems: 4 }),
});
const notifySchema = obj({ text: str() });
const styleSchema = obj({
  style: oneOf(["friend", "partner", "secretary"] as const, {
    description:
      "friend: a capable friend, warm and brief; partner: has opinions and says them; secretary: result first, no small talk",
  }),
});
const findSchema = obj({
  name: str({ description: "The project's name as the owner said it, e.g. pi-desktop" }),
});
const emptySchema = obj({});
const mailWatchSchema = obj({
  about: str({
    description:
      'What the owner wants to hear about, in their words, e.g. "导师的邮件". Shown on every notice.',
  }),
  query: str({
    description:
      "A Gmail search for that mail, e.g. from:prof@uni.edu, subject:offer, is:important, or in:inbox for all new mail.",
  }),
});
const intakeWatchSchema = obj({
  kind: str({
    description:
      '"issues" for issues assigned to the owner, "reviews" for pull requests waiting for their review.',
  }),
  repo: opt(
    str({
      description:
        "Repository to watch only, as owner/name or just the name of one of the owner's own repositories; leave out for all.",
    }),
  ),
  label: opt(str({ description: "Only issues or pull requests with this label." })),
  about: opt(str({ description: 'What the owner wants, in their words, e.g. "acme 的 bug".' })),
  auto: opt(
    bool({
      description:
        "true only when the owner said such items should start without asking (e.g. 「指派给我的 bug 直接做」). Default: ask.",
    }),
  ),
});

const whenFields = {
  kind: oneOf(["daily", "every", "once"] as const, {
    description:
      "daily: at a time on every day or on some weekdays; every: every N hours from now; once: one time at a date and time",
  }),
  at: opt(
    str({
      description:
        'daily: "HH:MM"; once: "YYYY-MM-DD HH:MM". The owner\'s local time, the one in [Now: …].',
    }),
  ),
  days: opt(
    arr(int({ minimum: 1, maximum: 7 }), {
      description: "daily only: weekdays, 1 Monday … 7 Sunday; leave out for every day",
    }),
  ),
  hours: opt(num({ description: "every only: hours between runs, at least 1" })),
};
const scheduleAddSchema = obj({
  about: str({
    description: 'A short name in the owner\'s words, e.g. "早上看 PI-Desktop 新 issue".',
  }),
  prompt: str({
    description:
      "What you do at the time, as a message from the owner would say it, complete on its own: the project (folder or name), what to do or check, and when to stay quiet (e.g. 「没有新的就不用说」). It is all you will have then.",
  }),
  ...whenFields,
});
const scheduleChangeSchema = obj({
  schedule: str({ description: "The schedule's id prefix or words of its name." }),
  about: opt(str()),
  prompt: opt(str()),
  paused: opt(bool({ description: "true to pause, false to run it again" })),
  kind: opt(whenFields.kind),
  at: whenFields.at,
  days: whenFields.days,
  hours: whenFields.hours,
});
const scheduleRemoveSchema = obj({
  schedule: str({ description: "The schedule's id prefix or words of its name." }),
});

const intakeUnwatchSchema = obj({
  watch: str({ description: "The watch's id prefix or words of what it is about." }),
});

const socialWatchSchema = obj({
  platform: oneOf(["xiaohongshu", "zhihu"] as const, {
    description: "xiaohongshu = 小红书, zhihu = 知乎",
  }),
  kind: oneOf(["mentions", "likes", "follows"] as const, {
    description:
      "mentions = comments, answers and @; likes = likes and saves; follows = new followers",
  }),
  on: bool({ description: "true to tell the owner about this kind, false to stop" }),
});

const feedReadSchema = obj({
  source: oneOf(["github-trending", "hacker-news", "arxiv"] as const, {
    description: "github-trending, hacker-news or arxiv",
  }),
  since: opt(
    oneOf(["daily", "weekly", "monthly"] as const, {
      description: "GitHub Trending range; weekly on Hacker News gives the best stories",
    }),
  ),
  language: opt(str({ description: "GitHub Trending language, such as python" })),
  query: opt(str({ description: "search words (Hacker News, arXiv)" })),
  limit: opt(num({ description: "how many, at most 30 (default 15)" })),
  told: opt(
    bool({
      description:
        "true when you are about to tell the owner these items (a digest): later reads mark them as told",
    }),
  ),
});

const mailUnwatchSchema = obj({
  watch: str({ description: "Mail watch id prefix or words of what it is about" }),
});

export function herderTools(
  host: HerderHost,
  turn: () => TurnContext,
  modelTiers?: () => TierPlacement,
): AgentTool[] {
  const tools = [
    {
      name: "session_list",
      label: "List tasks",
      description: "Tasks (open and ended), agent profiles, models and the active relay.",
      parameters: emptySchema,
      execute: async () => {
        const open = host.openTasks();
        const openIds = new Set(open.map((t) => t.id));
        const ended = host
          .tasks()
          .filter((t) => !openIds.has(t.id))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, ENDED_TASKS_LISTED);
        const lines = [
          "Open tasks:",
          ...(open.length === 0 ? ["(none)"] : open.map(taskLine)),
          "Ended tasks, newest first (kept across restarts; session_prompt continues one in the same folder and model):",
          ...(ended.length === 0 ? ["(none)"] : ended.map(taskLine)),
          `Agents: AgentHerd picks one from the model (GPT models run in Codex, the rest in Pi). Installed: ${host
            .profiles()
            .map((p) => `${p.id} (${p.name})`)
            .join(", ")}`,
          "Models (name: services offering it, in order of preference):",
          ...modelLines(host, modelTiers),
          `Relay: ${host.relayTaskId()?.slice(0, 8) ?? "none"}`,
          ...appLines(host),
          ...mailLines(host),
          ...socialLines(host),
          ...intakeLines(host),
          ...scheduleLines(host),
          ...sourceLines(host),
        ];
        return ok(lines.join("\n"));
      },
    },
    {
      name: "task_search",
      label: "Search past tasks",
      description:
        "Searches every task ever run (title, project, last report) for words, newest first. Use it for 'did we do this before', 'that task last week': what a task found or made is kept here, not in memory (ADR 0054).",
      parameters: taskSearchSchema,
      execute: async (_id: string, args: { query: string }) => {
        const found = searchTasks(host.tasks(), args.query).slice(0, TASKS_FOUND_MAX);
        return ok(
          found.length === 0 ? `no task matches "${args.query}"` : found.map(taskLine).join("\n"),
        );
      },
    },
    {
      name: "decisions_list",
      label: "Recent decisions",
      description: "Recent approval decisions (by rules or by the owner). Read only.",
      parameters: emptySchema,
      execute: async () => {
        const rows = host.decisions(20);
        if (rows.length === 0) return ok("(no decisions)");
        return ok(
          rows.map((d) => `- ${d.createdAt} ${d.source} ${d.action}: ${d.reason}`).join("\n"),
        );
      },
    },
    {
      name: "session_start",
      label: "Start a task",
      description: "Starts an agent session in a project with the owner's request.",
      parameters: sessionStartSchema,
      execute: async (
        _id: string,
        args: {
          project?: string;
          name: string;
          profile?: string;
          ownerText: string;
          addedContext?: string;
          model?: string;
          allowed?: OutboundStep[];
        },
      ) => {
        const t = turn();
        if (t.kind === "event") throw new Error("tasks start only when the owner asks");
        if (!isVerbatim(args.ownerText, t.ownerText)) {
          throw new Error("ownerText must be the owner's words copied exactly from their message");
        }
        const named = args.profile?.trim() || undefined;
        const ids = host.profiles().map((p) => p.id);
        if (named !== undefined && !ids.includes(named)) {
          throw new Error(`unknown profile "${named}"`);
        }
        const models = host
          .models()
          .filter((m) =>
            named === undefined ? m.agents.includes(agentForModel(m.ref, ids)) : true,
          );
        const tiers = modelTiers?.() ?? placeModels(modelsByName(models).map((m) => m.name));
        const preferred = TIERS.flatMap((tier) => tiers[tier]).find((entry) =>
          models.some(
            (m) =>
              m.ref.slice(m.ref.indexOf("/") + 1) === entry.model &&
              (named === undefined ? m.agents.length > 0 : m.agents.includes(named)),
          ),
        );
        const asked = args.model?.trim() || preferred?.model;
        if (asked === undefined) {
          throw new Error("no configured model can run this task; configure models in AgentHerd");
        }
        const picked = await pickService(host, asked, named, tiers, models);
        const model = picked.ref;
        const profile = named ?? agentForModel(model, ids);
        const given = args.project?.trim() || undefined;
        const cwd = given === undefined ? undefined : resolveProject(host, given);
        if (cwd !== undefined && !t.pickedDirs.some((d) => samePath(d, cwd))) {
          throw new Error(
            `the owner did not pick ${cwd} in this message; call project_find and ask the owner to pick the folder`,
          );
        }
        if (cwd !== undefined && !isDirectory(cwd)) throw new Error(`${cwd} is not a directory`);
        const lessons =
          host.memory === undefined
            ? []
            : await pastLessons(
                host.memory,
                `${args.name.trim()}\n${args.ownerText}`,
                host.embedder,
                host.memoryComplete,
              );
        const added = [
          args.addedContext?.trim() ?? "",
          ownerPrefsText(host.memory),
          decisionsText(host.memory),
          (host.toolNotes?.() ?? []).join("\n"),
          lessonsText(lessons),
        ]
          .filter((s) => s !== "")
          .join("\n\n");
        const prompt = composeTaskPrompt(args.ownerText.trim(), added === "" ? undefined : added);
        const title = args.name.trim() || args.ownerText.trim();
        const allowed = [...new Set(args.allowed ?? [])];
        const taskId =
          allowed.length > 0
            ? await host.startTask(
                profile,
                cwd,
                title,
                prompt,
                model,
                t.images.length === 0 ? undefined : t.images,
                allowed,
              )
            : t.images.length === 0
              ? await host.startTask(profile, cwd, title, prompt, model)
              : await host.startTask(profile, cwd, title, prompt, model, t.images);
        const switched =
          picked?.switched === undefined
            ? ""
            : `\nModel switched: ${picked.switched}. Tell the owner in one line.`;
        const gave =
          lessons.length === 0
            ? ""
            : `\nGave the agent ${lessons.length} past record(s): ${lessons.map((l) => l.abstract).join("; ")}`;
        const where = cwd === undefined ? "a folder of its own (no project)" : cwd;
        const free =
          allowed.length === 0
            ? "\nPushes, pull requests, merges, comments, publishing, deploys and messages will ask the owner."
            : `\nAllowed without asking: ${allowed.join(", ")}; other steps leaving the Mac ask the owner.`;
        return ok(
          `started task ${taskId.slice(0, 8)} in ${where} with ${profile}, ${model}${switched}${gave}${free}`,
        );
      },
    },
    {
      name: "session_prompt",
      label: "Message a task",
      description:
        "Sends text to a task. The owner's words go unchanged; other text is labeled as yours. An ended task (also one from before a restart) is started again in its folder with its model, then gets the text.",
      parameters: promptSchema,
      execute: async (_id: string, args: { task: string; text: string; name?: string }) => {
        const t = turn();
        if (t.kind === "event") throw new Error("only the owner can message tasks; use notify");
        const task = anyTask(host, args.task);
        const verbatim = isVerbatim(args.text, t.ownerText);
        const name = args.name?.trim();
        if (name !== undefined && name !== "") host.renameTask(task.id, name);
        const text = verbatim
          ? `${"[Owner's message]"}\n${args.text.trim()}`
          : `${HERDER_LABEL}\n${args.text.trim()}`;
        if (t.images.length === 0) host.promptTask(task.id, text);
        else host.promptTask(task.id, text, t.images);
        const reopened = host.openTasks().some((o) => o.id === task.id)
          ? ""
          : " (it had ended; AgentHerd starts its agent again first)";
        return ok(
          `sent to ${task.id.slice(0, 8)}${verbatim ? "" : " (labeled as from the Herder)"}${reopened}`,
        );
      },
    },
    {
      name: "session_cancel",
      label: "Cancel a turn",
      description: "Cancels the running turn of a task. The task stays open.",
      parameters: taskSchema,
      execute: async (_id: string, args: { task: string }) => {
        if (turn().kind === "event") throw new Error("only the owner can cancel");
        const task = oneTask(host, args.task);
        await host.cancelTurn(task.id);
        return ok(`cancelled the turn of ${task.id.slice(0, 8)}`);
      },
    },
    {
      name: "session_end",
      label: "End a task",
      description:
        'Closes a task for good when the owner says it is finished or no longer wanted ("可以结束了", "不用了"). The agent stops; the task stays in the list as ended and can be continued later with session_prompt. To stop only what it is doing now, use session_cancel.',
      parameters: taskSchema,
      execute: async (_id: string, args: { task: string }) => {
        if (turn().kind === "event") throw new Error("only the owner can end a task");
        const task = oneTask(host, args.task);
        await host.endTask(task.id);
        return ok(`ended ${task.id.slice(0, 8)}`);
      },
    },
    {
      name: "relay_start",
      label: "Relay to a task",
      description: "Owner messages go straight to this task until /end.",
      parameters: taskSchema,
      execute: async (_id: string, args: { task: string }) => {
        if (turn().kind === "event") throw new Error("only the owner can start a relay");
        const task = oneTask(host, args.task);
        await host.startRelay(task.id);
        return ok(`relay to ${task.id.slice(0, 8)} started`);
      },
    },
    {
      name: "relay_end",
      label: "End the relay",
      description: "Ends the active relay.",
      parameters: emptySchema,
      execute: async () => {
        await host.endRelay();
        return ok("relay ended");
      },
    },
    {
      name: "project_find",
      label: "Find a project",
      description:
        "Finds project folders (git repositories under the owner's home) by name. One project with the name the owner used: start there. Otherwise ask the owner to pick; never pick yourself.",
      parameters: findSchema,
      execute: async (_id: string, args: { name: string }) => {
        const found = findProjects(host.userHome, args.name);
        const t = turn();
        const only = found.exact.length === 1 ? found.exact[0] : undefined;
        // Only a name the owner typed this turn picks a folder by itself (ADR 0043).
        const unique =
          only !== undefined && t.kind !== "event" && namedBy(t.typedText, args.name)
            ? only
            : undefined;
        if (unique !== undefined) t.pickedDirs.push(unique);
        return ok(foundText(args.name, found, unique));
      },
    },
    {
      name: "ask",
      label: "Ask the owner",
      description:
        "Asks the owner one question with suggested answers as buttons; AgentHerd adds an 「其他」 button for typing their own. End your turn after it.",
      parameters: askSchema,
      execute: async (_id: string, args: { question: string; options: string[] }) => {
        if (turn().kind === "event") throw new Error(SPEAK_IN_REPLY);
        const other = otherOption(host.locale);
        const options = args.options.map((o) => o.trim()).filter((o) => o !== "" && o !== other);
        const all = [...options.slice(0, 4), other];
        host.recordTurn("ask", `${args.question}\n${all.map((o) => `- ${o}`).join("\n")}`);
        await host.ask(args.question, all);
        turn().asked = true;
        return ok("asked; the answer comes as a new message");
      },
    },
    {
      name: "notify",
      label: "Tell the owner",
      description: "Sends a message to the owner now, outside your reply.",
      parameters: notifySchema,
      execute: async (_id: string, args: { text: string }) => {
        if (turn().kind === "event") throw new Error(SPEAK_IN_REPLY);
        await host.say(args.text);
        turn().notified = true;
        return ok("sent");
      },
    },
  ];
  const all = tools.map((t) => t as unknown as AgentTool);
  const setStyle = host.setStyle;
  if (setStyle !== undefined) {
    const styleTool = {
      name: "style_set",
      label: "Change how you talk",
      description:
        "Changes how you talk to the owner, only when the owner asks for it. Takes effect from your next message.",
      parameters: styleSchema,
      execute: async (_id: string, args: { style: "friend" | "partner" | "secretary" }) => {
        ownerOnly(turn, "change how you talk");
        setStyle(args.style);
        return ok(`style is now ${args.style}`);
      },
    };
    all.push(styleTool as unknown as AgentTool);
  }
  if (host.watchMail !== undefined) {
    all.push(...mailTools(host, turn).map((t) => t as unknown as AgentTool));
  }
  const setSocialWatch = host.setSocialWatch;
  if (setSocialWatch !== undefined) {
    const socialTool = {
      name: "social_watch",
      label: "Platform notices",
      description:
        "Turns telling the owner about one kind of notice on their 小红书 or 知乎 account on or off, when the owner asks.",
      parameters: socialWatchSchema,
      execute: async (
        _id: string,
        args: {
          platform: "xiaohongshu" | "zhihu";
          kind: "mentions" | "likes" | "follows";
          on: boolean;
        },
      ) => {
        ownerOnly(turn, "change platform watches");
        setSocialWatch(args.platform, args.kind, args.on);
        return ok(
          `${args.platform} ${args.kind} ${args.on ? "on" : "off"}; tell the owner in one short line`,
        );
      },
    };
    all.push(socialTool as unknown as AgentTool);
  }
  const readFeed = host.readFeed;
  if (readFeed !== undefined && (host.feeds?.() ?? []).length > 0) {
    const feedTool = {
      name: "feed_read",
      label: "News",
      description:
        "Reads GitHub Trending, Hacker News or arXiv. Items marked [told before] were already in an earlier digest: leave them out unless the owner asks.",
      parameters: feedReadSchema,
      execute: async (
        _id: string,
        args: {
          source: FeedSource;
          since?: "daily" | "weekly" | "monthly";
          language?: string;
          query?: string;
          limit?: number;
          told?: boolean;
        },
      ) => {
        const { source, told, ...query } = args;
        const items = await readFeed(source, query, told === true);
        if (items.length === 0) return ok("nothing found");
        return ok(
          items
            .map((i) => `- ${i.seen ? "[told before] " : ""}${i.title} ${i.url}\n  ${i.about}`)
            .join("\n"),
        );
      },
    };
    all.push(feedTool as unknown as AgentTool);
  }
  if (host.watchIntake !== undefined) {
    all.push(...intakeTools(host, turn).map((t) => t as unknown as AgentTool));
  }
  if (host.addSchedule !== undefined) {
    all.push(...scheduleTools(host, turn).map((t) => t as unknown as AgentTool));
  }
  return all;
}

/** A task result is told in the Herder's reply, never in a separate message (ADR 0053). */
const SPEAK_IN_REPLY = "while telling a task's result, put everything in your reply";

/** Only the owner's own words create or change a new-work watch (ADR 0052). */
function ownerOnly(turn: () => TurnContext, what: string): void {
  const kind = turn().kind;
  if (kind === "event" || kind === "intake" || kind === "scheduled") {
    throw new Error(`only the owner can ${what}`);
  }
}

function oneIntake(host: HerderHost, query: string): { id: string; about: string } {
  const q = normalize(query);
  const found = (host.intakeWatches?.() ?? []).filter(
    (w) => w.id.startsWith(query.trim()) || normalize(w.about).includes(q),
  );
  const only = found[0];
  if (found.length === 1 && only !== undefined) return only;
  if (found.length === 0) throw new Error(`no new-work watch matches "${query}"`);
  throw new Error(
    `several new-work watches match "${query}": ${found.map((w) => `${w.id.slice(0, 8)} "${w.about}"`).join(", ")}`,
  );
}

function intakeTools(host: HerderHost, turn: () => TurnContext) {
  return [
    {
      name: "intake_watch",
      label: "Watch for new work",
      description:
        "Only when the owner asks to hear about new GitHub work (e.g. 「有指派给我的 issue 告诉我」, 「有人请我 review 就提醒我」): from now on AgentHerd checks GitHub every few minutes and offers each new item with 「开任务 / 忽略」. Set auto only when the owner said such items should start by themselves; calling again with the same kind/repo/label changes auto. Never start one on your own.",
      parameters: intakeWatchSchema,
      execute: async (
        _id: string,
        args: { kind: string; repo?: string; label?: string; about?: string; auto?: boolean },
      ) => {
        ownerOnly(turn, "ask for new-work watches");
        if (args.kind !== "issues" && args.kind !== "reviews") {
          throw new Error('kind must be "issues" or "reviews"');
        }
        const watch = await host.watchIntake?.({
          kind: args.kind,
          ...(args.repo === undefined ? {} : { repo: args.repo }),
          ...(args.label === undefined ? {} : { label: args.label }),
          ...(args.about === undefined ? {} : { about: args.about }),
          ...(args.auto === undefined ? {} : { auto: args.auto }),
        });
        if (watch === undefined) throw new Error("GitHub cannot be watched here");
        return ok(
          `watching ${watch.id.slice(0, 8)} "${watch.about}" (auto: ${watch.auto}); tell the owner in one short line`,
        );
      },
    },
    {
      name: "intake_unwatch",
      label: "Stop watching for new work",
      description: "Stops a new-work watch when the owner no longer wants those offers.",
      parameters: intakeUnwatchSchema,
      execute: async (_id: string, args: { watch: string }) => {
        ownerOnly(turn, "stop new-work watches");
        const watch = oneIntake(host, args.watch);
        host.unwatchIntake?.(watch.id);
        return ok(`stopped watching "${watch.about}"`);
      },
    },
  ];
}

/** Mail watches exist only because the owner asked (ADR 0048). */
function mailTools(host: HerderHost, turn: () => TurnContext) {
  return [
    {
      name: "mail_watch",
      label: "Watch mail",
      description:
        "Only when the owner asks to be told about some mail (e.g. 「导师来邮件提醒我」): from now on AgentHerd checks Gmail every few minutes and tells the owner about new mail matching the search. Never start one on your own.",
      parameters: mailWatchSchema,
      execute: async (_id: string, args: { about: string; query: string }) => {
        ownerOnly(turn, "ask for mail watches");
        const watch = await host.watchMail?.(args.about, args.query);
        if (watch === undefined) throw new Error("mail cannot be watched here");
        return ok(
          `watching mail ${watch.id.slice(0, 8)} "${watch.about}" (query: ${watch.query}); tell the owner in one short line`,
        );
      },
    },
    {
      name: "mail_unwatch",
      label: "Stop watching mail",
      description: "Stops a mail watch when the owner no longer wants those notices.",
      parameters: mailUnwatchSchema,
      execute: async (_id: string, args: { watch: string }) => {
        ownerOnly(turn, "stop mail watches");
        const watch = oneWatch(host, args.watch);
        host.unwatchMail?.(watch.id);
        return ok(`stopped watching "${watch.about}"`);
      },
    },
  ];
}

/** The owner's models grouped by name: services in list order, agents that can run any of them. */
export function modelsByName(
  models: { ref: string; agents: string[] }[],
): { name: string; refs: string[]; services: string[]; agents: string[] }[] {
  const out = new Map<
    string,
    { name: string; refs: string[]; services: string[]; agents: string[] }
  >();
  for (const m of models) {
    const slash = m.ref.indexOf("/");
    const service = m.ref.slice(0, slash);
    const name = m.ref.slice(slash + 1);
    const entry = out.get(name) ?? { name, refs: [], services: [], agents: [] };
    entry.refs.push(m.ref);
    entry.services.push(service);
    for (const a of m.agents) if (!entry.agents.includes(a)) entry.agents.push(a);
    out.set(name, entry);
  }
  return [...out.values()];
}

/** A model to run and, when it is not the one asked for, why it was swapped. */
export interface PickedModel {
  ref: string;
  /** Set when AgentHerd moved away from what was asked; the Herder tells the owner. */
  switched?: string;
}

/**
 * The `service/model` to run. Tries, in order, each answering a test call first: what was asked
 * (one service, or every service offering the name), other services offering the same name, the
 * other models of its tier, then the other tiers. Only models the agent can run count.
 */
/**
 * Refs to try for `asked`, in order: `asked` itself (one service, or every service offering the
 * name), other services offering the same name, the other models of its tier, then the other
 * tiers. Only models `profile` can run; with no profile, any model an agent can run (AgentHerd then
 * picks the agent from the model, ADR 0031). Throws when the name is unknown or nothing can run it.
 */
export function fallbackOrder(
  models: readonly { ref: string; agents: string[] }[],
  asked: string,
  profile: string | undefined,
  tiers?: TierPlacement,
): string[] {
  const nameOf = (ref: string) => ref.slice(ref.indexOf("/") + 1);
  const exact = models.find((m) => m.ref === asked);
  const name = exact !== undefined ? nameOf(exact.ref) : asked;
  const same = models.filter((m) => nameOf(m.ref) === name);
  if (same.length === 0) throw new Error(`unknown model "${asked}"; see session_list`);
  const runs = (m: { agents: string[] } | undefined) =>
    m !== undefined && (profile === undefined ? m.agents.length > 0 : m.agents.includes(profile));
  if (!same.some(runs)) {
    const can = [...new Set(same.flatMap((m) => m.agents))].join(", ") || "no agent";
    throw new Error(
      `${profile === undefined ? "no agent" : `agent "${profile}"`} cannot run ${asked} (can: ${can})`,
    );
  }
  const order: string[] = [];
  const add = (ref: string) => {
    if (!order.includes(ref)) order.push(ref);
  };
  if (exact !== undefined) add(exact.ref);
  for (const m of same) add(m.ref);
  const byName = (n: string) => models.filter((m) => nameOf(m.ref) === n).map((m) => m.ref);
  if (tiers !== undefined) {
    const home = TIERS.find((t) => tiers[t].some((e) => e.model === name));
    const rest = TIERS.filter((t) => t !== home);
    for (const tier of home === undefined ? rest : [home, ...rest]) {
      for (const e of tiers[tier]) for (const ref of byName(e.model)) add(ref);
    }
  }
  return order.filter((ref) => runs(models.find((m) => m.ref === ref)));
}

async function pickService(
  host: HerderHost,
  asked: string,
  profile: string | undefined,
  tiers: TierPlacement | undefined,
  models: ReturnType<HerderHost["models"]>,
): Promise<PickedModel> {
  const runnable = fallbackOrder(models, asked, profile, tiers);
  const failures: string[] = [];
  for (const ref of runnable) {
    const check = await host.checkModel(ref);
    if (check.ok) {
      if (failures.length === 0) return { ref };
      return { ref, switched: `${failures.join("; ")}; switched to ${ref}` };
    }
    failures.push(`${ref} failed (${check.message})`);
  }
  throw new Error(`no model answers: ${failures.join("; ")}`);
}

function modelLines(host: HerderHost, modelTiers?: () => TierPlacement): string[] {
  const models = modelsByName(host.models());
  if (models.length === 0) return ["(none; configure models in AgentHerd before starting a task)"];
  const lines = models.map(
    (m) =>
      `- ${m.name}: ${m.services.join(", ")}${m.agents.length === 0 ? " (no agent can run it)" : ""}`,
  );
  const placement = modelTiers?.();
  const guide = placement === undefined ? "" : tiersText(placement);
  if (guide) lines.push(guide);
  return lines;
}
