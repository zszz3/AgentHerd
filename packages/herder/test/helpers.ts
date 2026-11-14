// A HerderHost that records what the Herder does, for unit tests.

import type {
  FeedItem,
  FeedQuery,
  FeedSource,
  HerderHost,
  IntakeWatch,
  MailWatch,
  MemoryStore,
  NoticeKind,
  NoticeLevel,
  Schedule,
  Task,
  TranscriptEntry,
} from "@agentherd/core";
import { CORE_TEXTS, checkWhen, nextRun } from "@agentherd/core";

export interface Recorded {
  said: string[];
  asked: { text: string; options: string[] }[];
  started: {
    profileId: string;
    cwd: string | undefined;
    title: string;
    prompt: string;
    model?: string;
    images?: string[];
    allowed?: string[];
  }[];
  prompted: { taskId: string; text: string; images?: string[] }[];
  renamed: { taskId: string; name: string }[];
  cancelled: string[];
  ended: string[];
  relays: string[];
  audits: { type: string; data: Record<string, unknown> }[];
  turns: { role: string; text: string }[];
  alerts: { text: string; retry: boolean }[];
  state: Map<string, unknown>;
  /** The saved Herder conversation (`herder_log`). */
  log: unknown[];
}

export function task(id: string, title: string): Task {
  return {
    id,
    title,
    project: "app",
    agent: "Mock",
    stage: "working",
    lastReport: "",
    startedAt: "2026-11-04T07:00:00.000Z",
    updatedAt: "2026-11-04T07:00:00.000Z",
    automaticDecisions: [],
  };
}

function mailHost(
  watches: MailWatch[],
): Pick<HerderHost, "mailWatches" | "watchMail" | "unwatchMail"> {
  return {
    mailWatches: () => watches,
    watchMail: async (about, query) => {
      const watch = {
        id: `watch-${watches.length + 1}-0000`,
        about,
        query,
        createdAt: "2026-11-04T00:00:00.000Z",
        seen: [],
      };
      watches.push(watch);
      return watch;
    },
    unwatchMail: (id) => {
      const i = watches.findIndex((w) => w.id === id);
      if (i >= 0) watches.splice(i, 1);
      return i >= 0;
    },
  };
}

function intakeHost(
  watches: IntakeWatch[],
): Pick<HerderHost, "intakeWatches" | "watchIntake" | "unwatchIntake"> {
  return {
    intakeWatches: () => watches,
    watchIntake: async (request) => {
      // Like core's Intake.add: an automatic watch starts on a trial run (ADR 0064).
      const i = watches.findIndex(
        (w) => w.kind === request.kind && w.repo === request.repo && w.label === request.label,
      );
      const same = watches[i];
      if (same !== undefined) {
        const auto = request.auto ?? same.auto;
        const trial = auto && (request.trial ?? (same.auto ? same.trial === true : true));
        const { trial: _trial, ...rest } = same;
        const changed: IntakeWatch = { ...rest, auto, ...(trial ? { trial: true } : {}) };
        watches[i] = changed;
        return changed;
      }
      const auto = request.auto === true;
      const watch: IntakeWatch = {
        id: `intake-${watches.length + 1}-0000`,
        kind: request.kind,
        ...(request.repo === undefined ? {} : { repo: request.repo }),
        ...(request.label === undefined ? {} : { label: request.label }),
        about: request.about ?? request.kind,
        auto,
        ...(auto && request.trial !== false ? { trial: true } : {}),
        createdAt: "2026-11-04T00:00:00.000Z",
        seen: [],
        offers: [],
      };
      watches.push(watch);
      return watch;
    },
    unwatchIntake: (id) => {
      const i = watches.findIndex((w) => w.id === id);
      if (i >= 0) watches.splice(i, 1);
      return i >= 0;
    },
  };
}

const NOW = new Date("2026-11-04T00:00:00.000Z");

function scheduleHost(
  list: Schedule[],
): Pick<HerderHost, "schedules" | "addSchedule" | "changeSchedule" | "removeSchedule"> {
  return {
    schedules: () => list,
    addSchedule: (input) => {
      const when = checkWhen(input.when);
      const schedule: Schedule = {
        id: `sched-${list.length + 1}-0000`,
        ...input,
        when,
        paused: false,
        createdAt: NOW.toISOString(),
        nextAt: nextRun(when, NOW)?.toISOString() ?? NOW.toISOString(),
      };
      list.push(schedule);
      return schedule;
    },
    changeSchedule: (id, patch) => {
      const i = list.findIndex((s) => s.id === id);
      const old = list[i];
      if (old === undefined) throw new Error("no such schedule");
      const changed: Schedule = { ...old, ...patch };
      list[i] = changed;
      return changed;
    },
    removeSchedule: (id) => {
      const i = list.findIndex((s) => s.id === id);
      if (i >= 0) list.splice(i, 1);
      return i >= 0;
    },
  };
}

export function fakeHost(
  opts: {
    tasks?: Task[];
    /** Ids of tasks that ended; the rest are open. */
    ended?: string[];

    models?: { ref: string; agents: string[] }[];
    failing?: string[];
    profiles?: { id: string; name: string }[];
    memory?: MemoryStore;
    apps?: string[];
    userHome?: string;
    /** Mail watches kept in memory (ADR 0048). */
    mail?: MailWatch[];
    /** New-work watches kept in memory (ADR 0052). */
    intake?: IntakeWatch[];
    /** Schedules kept in memory (ADR 0055). */
    schedules?: Schedule[];
    /** What every new task is told about this Mac (ADR 0059). */
    toolNotes?: string[];
    /** A news source answer; reads are recorded in rec.state "feeds" (ADR 0059). */
    feed?: FeedItem[];
    /** Where small news goes, kept in memory (ADR 0061). */
    notices?: Record<NoticeKind, NoticeLevel>;
    /** What each task's agent was sent and wrote, by task id (task_read, ADR 0062). */
    transcripts?: Record<string, TranscriptEntry[]>;
  } = {},
): {
  host: HerderHost;
  rec: Recorded;
} {
  const rec: Recorded = {
    said: [],
    asked: [],
    started: [],
    prompted: [],
    renamed: [],
    cancelled: [],
    ended: [],
    relays: [],
    audits: [],
    turns: [],
    alerts: [],
    state: new Map(),
    log: [],
  };
  const tasks = opts.tasks ?? [];
  const host: HerderHost = {
    locale: "zh-CN",
    texts: CORE_TEXTS["zh-CN"],
    userHome: opts.userHome ?? "/Users/me",
    profiles: () => opts.profiles ?? [{ id: "mock", name: "Mock" }],
    tasks: () => tasks,
    openTasks: () => tasks.filter((t) => !(opts.ended ?? []).includes(t.id)),
    relayTaskId: () => undefined,
    decisions: () => [],
    models: () => opts.models ?? [],
    apps: () => opts.apps ?? [],
    checkModel: async (ref) =>
      opts.failing?.includes(ref) ? { ok: false, message: "down" } : { ok: true },
    startTask: async (profileId, cwd, title, prompt, model, images, allowed) => {
      rec.started.push({
        ...(allowed === undefined ? {} : { allowed: [...allowed] }),
        profileId,
        cwd,
        title,
        prompt,
        ...(model === undefined ? {} : { model }),
        ...(images === undefined ? {} : { images: images.map((i) => i.path) }),
      });
      return `task-${rec.started.length}-0000-0000`;
    },
    promptTask: (taskId, text, images) =>
      void rec.prompted.push({
        taskId,
        text,
        ...(images === undefined ? {} : { images: images.map((i) => i.path) }),
      }),
    renameTask: (taskId, name) => void rec.renamed.push({ taskId, name }),
    cancelTurn: async (taskId) => void rec.cancelled.push(taskId),
    endTask: async (taskId) => void rec.ended.push(taskId),
    startRelay: async (taskId) => void rec.relays.push(taskId),
    endRelay: async () => void rec.relays.push("end"),
    say: async (text) => void rec.said.push(text),
    alert: async (text, retry) => void rec.alerts.push({ text, retry }),
    ask: async (text, options) => void rec.asked.push({ text, options }),
    audit: (type, data) => void rec.audits.push({ type, data }),
    recordTurn: (role, text) => void rec.turns.push({ role, text }),
    ...(opts.memory === undefined ? {} : { memory: opts.memory }),
    ...(opts.mail === undefined ? {} : mailHost(opts.mail)),
    ...(opts.intake === undefined ? {} : intakeHost(opts.intake)),
    ...(opts.schedules === undefined ? {} : scheduleHost(opts.schedules)),
    ...(opts.toolNotes === undefined ? {} : { toolNotes: () => opts.toolNotes ?? [] }),
    ...(opts.transcripts === undefined
      ? {}
      : { transcript: (taskId: string) => opts.transcripts?.[taskId] ?? [] }),
    ...(opts.notices === undefined
      ? {}
      : {
          noticeLevels: () => ({ ...(opts.notices as Record<NoticeKind, NoticeLevel>) }),
          setNoticeLevel: (kind: NoticeKind, level: NoticeLevel) => {
            (opts.notices as Record<NoticeKind, NoticeLevel>)[kind] = level;
          },
        }),
    ...(opts.feed === undefined
      ? {}
      : {
          feeds: () => ["github-trending", "hacker-news"] as const,
          readFeed: async (source: FeedSource, query: FeedQuery, mark: boolean) => {
            const reads = (rec.state.get("feeds") as unknown[] | undefined) ?? [];
            rec.state.set("feeds", [...reads, { source, query, mark }]);
            return opts.feed ?? [];
          },
        }),
    getState: <T>(key: string) => rec.state.get(key) as T | undefined,
    setState: (key, value) => void rec.state.set(key, structuredClone(value)),
    herderLog: () => structuredClone(rec.log),
    writeHerderLog: (from, messages) => {
      rec.log.length = Math.min(rec.log.length, from);
      rec.log.push(...structuredClone(messages));
    },
  };
  return { host, rec };
}
