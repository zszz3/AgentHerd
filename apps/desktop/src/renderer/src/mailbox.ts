// What the 信箱 page shows (ADR 0099, 0100), kept apart from the components so it can be tested.

import type {
  MailboxAct,
  MailboxActChoice,
  MailboxDraft,
  MailboxFields,
  MailboxKind,
  MailboxLetterView,
  MailboxSource,
  MailboxSourcePatch,
  MailboxSourceView,
  MailboxView,
  ScheduleWhen,
} from "@agentherd/host/api";
import type { Tone } from "./components/ui";
import { nextText, whenText as timerText } from "./schedule-text";

export const KIND_LABELS: Record<MailboxKind, string> = {
  github: "GitHub 仓库",
  work: "派给你的活",
  mail: "邮件",
  social: "小红书/知乎",
  rss: "RSS 订阅",
  hn: "Hacker News",
  script: "自己的脚本",
  timer: "定时",
};

export const KIND_HINTS: Record<MailboxKind, string> = {
  github: "仓库的新 issue、PR 和发布；用你登录的 gh 去看",
  work: "GitHub 上派给你的 issue、请你评审的 PR；可以每件都问你，或者直接开任务",
  mail: "Gmail 里符合搜索条件的新邮件；要先在「应用连接」里连上 Gmail",
  social: "你账号下的新评论和 @；要先在「应用连接」里登录",
  rss: "博客、新闻站的 RSS 或 Atom 订阅",
  hn: "Hacker News 上带这些词的新帖子",
  script: "任何语言的命令：读进上次留下的状态，打印新信件和新状态",
  timer: "到点主管照你写的话去做，比如每天早上看看有没有新 issue",
};

export const KIND_ORDER: readonly MailboxKind[] = [
  "github",
  "work",
  "mail",
  "social",
  "rss",
  "hn",
  "script",
  "timer",
];

export const PLATFORM_LABELS: Record<string, string> = { xiaohongshu: "小红书", zhihu: "知乎" };

/** What happens to a new letter, as the owner picks it. */
export const ACT_CHOICES: readonly { value: MailboxActChoice; label: string; hint: string }[] = [
  { value: "sort", label: "主管看着办", hint: "要紧的马上告诉你，别的留到早上汇总或只记下" },
  { value: "offer", label: "每封都问我", hint: "每件新的都发给你，点「开任务」才开" },
  { value: "auto", label: "直接开任务", hint: "先试跑：前几件只问你、主管说它本来会怎么做" },
];

/** The choice a source's act shows as (a trial run is 「直接开任务」 still on trial). */
export function actChoice(act: MailboxAct): MailboxActChoice {
  return act === "trial" ? "auto" : act;
}

/** 「每封都问你」「试跑中 · 已经 2 件」「直接开任务」; nothing for the default. */
export function actText(s: Pick<MailboxSource, "act" | "trials">): string | undefined {
  if (s.act === "offer") return "每封都问你";
  if (s.act === "trial") return s.trials === 0 ? "试跑中" : `试跑中 · 已经 ${s.trials} 件`;
  if (s.act === "auto") return "直接开任务";
  return undefined;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 「今天 14:05」「昨天 09:00」「11-19 21:31」. */
export function whenText(at: string | undefined, now: Date = new Date()): string {
  if (at === undefined) return "";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (day(d) === day(now)) return `今天 ${clock}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (day(d) === day(yesterday)) return `昨天 ${clock}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock}`;
}

/** 「每 10 分钟」「每 2 小时」「每天」. */
export function everyText(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? "每天" : `每 ${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`;
  return `每 ${minutes} 分钟`;
}

/** What the source looks at, in one short line. */
export function whatText(s: MailboxSource): string {
  const c = s.config;
  if (s.kind === "work") {
    const what = Array.isArray(c.what) ? (c.what as string[]) : [];
    const names = what.map(
      (w) => ({ assigned: "派给你的 issue", reviews: "请你评审的 PR" })[w] ?? w,
    );
    const where = typeof c.repo === "string" && c.repo !== "" ? `${c.repo} 里` : "";
    const label = typeof c.label === "string" && c.label !== "" ? `，标签「${c.label}」` : "";
    return `${where}${names.join("、")}${label}`;
  }
  if (s.kind === "mail") return `Gmail 搜「${String(c.query ?? "")}」`;
  if (s.kind === "social") {
    return `${PLATFORM_LABELS[String(c.platform)] ?? String(c.platform)}的新评论和 @`;
  }
  if (s.kind === "timer") {
    const when = c.when as ScheduleWhen | undefined;
    return when === undefined ? s.note : timerText(when);
  }
  const words = Array.isArray(c.words) ? (c.words as string[]).join("、") : "";
  if (s.kind === "github") {
    const what = Array.isArray(c.what) ? (c.what as string[]) : ["issues", "releases"];
    const names = what.map((w) => ({ issues: "issue", prs: "PR", releases: "发布" })[w] ?? w);
    return `${String(c.repo ?? "")} 的新 ${names.join("、")}${words === "" ? "" : `，带「${words}」`}`;
  }
  if (s.kind === "rss") {
    return `${String(c.url ?? "")}${words === "" ? "" : `，带「${words}」`}`;
  }
  if (s.kind === "hn") {
    const points = typeof c.points === "number" && c.points > 0 ? `，${c.points} 分以上` : "";
    return `「${String(c.words ?? "")}」${points}`;
  }
  if (s.kind === "script") return String(c.command ?? "");
  return s.note;
}

export interface SourceState {
  label: string;
  tone: Tone;
}

export function sourceState(s: MailboxSource): SourceState {
  if (s.paused) return { label: "停着", tone: "gray" };
  if (s.lastError !== undefined && s.fails > 0) {
    return { label: s.fails >= 3 ? `连着 ${s.fails} 次没取到` : "上次没取到", tone: "red" };
  }
  if (!s.started) return { label: "第一次还没看", tone: "amber" };
  return { label: "正常", tone: "green" };
}

/** 「每 10 分钟 · 上次 今天 14:05 · 来了 3 封」; a timer: 「下次：11月23日 09:00 · 上次 …」. */
export function sourceLine(s: MailboxSourceView, now: Date = new Date()): string {
  if (s.kind === "timer") {
    const parts = [nextText(s)];
    if (s.lastRunAt !== undefined) parts.push(`上次 ${whenText(s.lastRunAt, now)}`);
    if (s.by === "herder") parts.push("主管加的");
    return parts.join(" · ");
  }
  const parts = [everyText(s.everyMinutes)];
  if (s.lastRunAt !== undefined) parts.push(`上次 ${whenText(s.lastRunAt, now)}`);
  parts.push(s.letters === 0 ? "还没来过信" : `来了 ${s.letters} 封`);
  if (s.by === "herder") parts.push("主管加的");
  return parts.join(" · ");
}

export type LetterFilter = "all" | "now" | "digest" | "noted" | "waiting";

export const LETTER_FILTERS: readonly { value: LetterFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "now", label: "告诉你了" },
  { value: "digest", label: "留到汇总" },
  { value: "noted", label: "记下了" },
  { value: "waiting", label: "等主管看" },
];

export interface FateView {
  label: string;
  tone: Tone;
}

/** What became of a letter: told now, kept for the morning digest, only noted, or still waiting. */
export function fateOf(l: MailboxLetterView): FateView {
  if (l.fate === "now") return { label: "告诉你了", tone: "blue" };
  if (l.fate === "digest") {
    return l.digestedAt === undefined
      ? { label: "留到汇总", tone: "amber" }
      : { label: "已汇总", tone: "green" };
  }
  if (l.fate === "noted") return { label: "记下了", tone: "gray" };
  if (l.sentAt !== undefined) return { label: "主管在看", tone: "amber" };
  return { label: "等主管看", tone: "gray" };
}

export function filterLetters(
  letters: readonly MailboxLetterView[],
  filter: LetterFilter,
  sourceId?: string,
): MailboxLetterView[] {
  return letters.filter((l) => {
    if (sourceId !== undefined && l.sourceId !== sourceId) return false;
    if (filter === "all") return true;
    if (filter === "waiting") return l.fate === undefined;
    return l.fate === filter;
  });
}

export function fateCounts(letters: readonly MailboxLetterView[]): Record<LetterFilter, number> {
  const counts: Record<LetterFilter, number> = { all: 0, now: 0, digest: 0, noted: 0, waiting: 0 };
  for (const l of letters) {
    counts.all += 1;
    counts[l.fate ?? "waiting"] += 1;
  }
  return counts;
}

/** Why a draft cannot be added yet, in the owner's words; undefined when it can. */
export function draftProblem(d: MailboxDraft, view?: MailboxView): string | undefined {
  if (d.name.trim() === "") return "起个名字";
  if (d.kind === "github") {
    const repo = (d.repo ?? "")
      .trim()
      .replace(/^https?:\/\/github\.com\//, "")
      .replace(/\/$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return "仓库写成 owner/name，比如 openai/codex";
    if (d.what !== undefined && d.what.length === 0) return "至少选一样：issue、PR 或发布";
  }
  if (d.kind === "work") {
    if (d.what === undefined || d.what.length === 0)
      return "至少选一样：派给你的 issue 或请你评审的 PR";
  }
  if (d.kind === "mail" && (d.query ?? "").trim() === "")
    return "填 Gmail 的搜索条件，比如 from:li@uni.edu";
  if (d.kind === "social" && d.platform === undefined) return "选一个平台";
  if (d.kind === "timer") {
    const problem = whenProblem(d.when);
    if (problem !== undefined) return problem;
  }
  if (d.kind === "rss" && !/^https?:\/\/\S+$/.test((d.url ?? "").trim()))
    return "填订阅的地址（http 开头）";
  if (d.kind === "hn" && (d.words ?? "").trim() === "") return "填要搜的词";
  if (d.kind === "script" && (d.command ?? "").trim() === "") return "填要运行的命令";
  if (d.kind === "timer" && (d.note ?? "").trim() === "") return "写下到点要主管做什么";
  const every = view?.every[d.kind];
  if (d.everyMinutes !== undefined && every !== undefined && d.everyMinutes < every.min) {
    return `${KIND_LABELS[d.kind]}最快${everyText(every.min)}看一次`;
  }
  return undefined;
}

/** The name a new source starts with, from what was filled in. */
export function suggestedName(d: MailboxDraft): string {
  if (d.kind === "github") {
    const repo = (d.repo ?? "")
      .trim()
      .replace(/^https?:\/\/github\.com\//, "")
      .replace(/\/$/, "");
    return repo.split("/")[1] ?? "";
  }
  if (d.kind === "rss") {
    try {
      return new URL((d.url ?? "").trim()).host.replace(/^www\./, "");
    } catch {
      return "";
    }
  }
  if (d.kind === "hn") return (d.words ?? "").trim() === "" ? "" : `HN：${(d.words ?? "").trim()}`;
  if (d.kind === "work") {
    const what = d.what ?? [];
    if (what.length === 0) return "";
    return what.includes("reviews") && !what.includes("assigned") ? "等我评审的 PR" : "派给我的活";
  }
  if (d.kind === "social" && d.platform !== undefined) {
    return `${PLATFORM_LABELS[d.platform] ?? d.platform}的评论和@`;
  }
  return "";
}

/** Why a timer's time is not right yet; undefined when it is. */
export function whenProblem(when: ScheduleWhen | undefined): string | undefined {
  if (when === undefined) return "选好什么时候";
  if (when.kind === "every") {
    return Number.isInteger(when.hours) && when.hours >= 1 && when.hours <= 168
      ? undefined
      : "每隔 1 到 168 小时";
  }
  if (when.kind === "daily") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(when.at)) return "时间写成 09:00 这样";
    if (when.days !== undefined && when.days.length === 0) return "至少选一天";
    return undefined;
  }
  return /^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$/.test(when.at)
    ? undefined
    : "日期和时间写成 2026-11-23 09:00 这样";
}

/** A source as the form shows it, to change it (the same fields it was added with). */
export function draftOf(s: MailboxSource): MailboxDraft {
  const c = s.config;
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  const words = Array.isArray(c.words) ? (c.words as string[]).join(", ") : text(c.words);
  const what = Array.isArray(c.what) ? (c.what as MailboxDraft["what"]) : undefined;
  const d: MailboxDraft = {
    kind: s.kind,
    name: s.name,
    note: s.note,
    ...(s.kind === "timer" ? {} : { everyMinutes: s.everyMinutes, act: actChoice(s.act) }),
  };
  const fields: Partial<MailboxDraft> = {
    repo: text(c.repo),
    what,
    url: text(c.url),
    words,
    points: typeof c.points === "number" ? c.points : undefined,
    command: text(c.command),
    cwd: text(c.cwd),
    label: text(c.label),
    query: text(c.query),
    platform: c.platform === "xiaohongshu" || c.platform === "zhihu" ? c.platform : undefined,
    when: s.kind === "timer" ? (c.when as ScheduleWhen | undefined) : undefined,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) (d as unknown as Record<string, unknown>)[k] = v;
  }
  return d;
}

const FIELD_KEYS = [
  "repo",
  "what",
  "url",
  "words",
  "points",
  "command",
  "cwd",
  "label",
  "query",
  "platform",
  "when",
] as const;

/**
 * What changed between a source and its edited form: only those go to the host, so an untouched
 * source keeps its letters, and only a change of what it looks at makes it start over.
 */
export function editPatch(s: MailboxSource, d: MailboxDraft): MailboxSourcePatch {
  const old = draftOf(s);
  const patch: MailboxSourcePatch = {};
  if (d.name.trim() !== old.name) patch.name = d.name.trim();
  if ((d.note ?? "") !== (old.note ?? "")) patch.note = d.note ?? "";
  if (s.kind !== "timer") {
    if (d.everyMinutes !== undefined && d.everyMinutes !== old.everyMinutes) {
      patch.everyMinutes = d.everyMinutes;
    }
    if (d.act !== undefined && d.act !== old.act) patch.act = d.act;
  }
  const same = FIELD_KEYS.every((k) => JSON.stringify(d[k]) === JSON.stringify(old[k]));
  if (!same) {
    const fields: MailboxFields = {};
    for (const k of FIELD_KEYS) {
      if (d[k] !== undefined) (fields as Record<string, unknown>)[k] = d[k];
    }
    patch.fields = fields;
  }
  return patch;
}

/** Whether a change makes the source start over: a new place to look, not a new note or name. */
export function startsOver(patch: MailboxSourcePatch, kind: MailboxKind): boolean {
  return patch.fields !== undefined && kind !== "timer";
}
