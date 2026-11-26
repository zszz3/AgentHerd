// A HerderHost that records what the Herder does, for unit tests.

import type {
  FeedItem,
  FeedQuery,
  FeedSource,
  HerderHost,
  MailboxSource,
  MemoryStore,
  NoticeKind,
  NoticeLevel,
  Task,
  TranscriptEntry,
} from "@agentherd/core";
import { CORE_TEXTS, checkWhen, nextRun, timerWhen } from "@agentherd/core";

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
  /** Calls to closeAlerts, with why. */
  closed: string[];
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

const NOW = new Date("2026-11-04T00:00:00.000Z");

/** Mailbox sources kept in memory, like core's Mailbox (ADR 0099, 0100). */
function mailboxHost(
  list: MailboxSource[],
): Pick<
  HerderHost,
  | "mailboxSources"
  | "addMailboxSource"
  | "changeMailboxSource"
  | "removeMailboxSource"
  | "tryMailboxSource"
> {
  // Like core: a timer's time is checked and kept in its tidy form.
  const timerConfig = (config: Record<string, unknown>) => {
    const when = checkWhen(timerWhen(config));
    if (nextRun(when, NOW) === undefined) throw new Error("already past");
    return { ...config, when };
  };
  return {
    mailboxSources: () => list,
    addMailboxSource: (input) => {
      const timer = input.kind === "timer";
      const config = timer ? timerConfig(input.config ?? {}) : (input.config ?? {});
      const s: MailboxSource = {
        id: `src-${list.length + 1}-0000`,
        kind: input.kind,
        name: input.name,
        note: input.note ?? "",
        config,
        everyMinutes: timer ? 0 : (input.everyMinutes ?? 10),
        paused: false,
        by: input.by ?? "owner",
        createdAt: NOW.toISOString(),
        started: timer,
        fails: 0,
        letters: 0,
        act: input.act ?? "sort",
        trials: 0,
      };
      list.push(s);
      return s;
    },
    changeMailboxSource: (id, patch) => {
      const i = list.findIndex((s) => s.id === id);
      const old = list[i];
      if (old === undefined) throw new Error(`no source ${id}`);
      const config =
        patch.config === undefined
          ? old.config
          : old.kind === "timer"
            ? timerConfig(patch.config)
            : patch.config;
      const changed: MailboxSource = { ...old, ...patch, config };
      list[i] = changed;
      return changed;
    },
    removeMailboxSource: (id) => {
      const i = list.findIndex((s) => s.id === id);
      if (i >= 0) list.splice(i, 1);
      return i >= 0;
    },
    tryMailboxSource: async (input) =>
      input.kind === "timer"
        ? [{ id: "next", title: input.name, body: "at 2026-11-04 09:00" }]
        : [{ id: "1", title: "#1 hello", link: "https://example.com/1" }],
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
    /** Mailbox sources and timers kept in memory (ADR 0099, 0100). */
    mailbox?: MailboxSource[];
    /** What every new task is told about this Mac (ADR 0059). */
    toolNotes?: string[];
    /** A news source answer; reads are recorded in rec.state "feeds" (ADR 0059). */
    feed?: FeedItem[];
    /** Tencent WeStock mock state and quote response (ADR 0076). */
    westock?: { enabled: boolean; cliReady: boolean; quote?: string };
    /** 雪球基金 mock state and holdings summary (ADR 0077). */
    danjuan?: { enabled: boolean; ready: boolean; state: string; report?: string };
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
    closed: [],
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
    closeAlerts: async (why) => void rec.closed.push(why),
    ask: async (text, options) => void rec.asked.push({ text, options }),
    audit: (type, data) => void rec.audits.push({ type, data }),
    recordTurn: (role, text) => void rec.turns.push({ role, text }),
    ...(opts.memory === undefined ? {} : { memory: opts.memory }),
    ...(opts.mailbox === undefined ? {} : mailboxHost(opts.mailbox)),
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
    ...(opts.westock === undefined
      ? {}
      : {
          westock: () => ({
            enabled: opts.westock?.enabled ?? true,
            cliReady: opts.westock?.cliReady ?? false,
          }),
          stockQuote: async (query: string) => {
            const reads = (rec.state.get("quotes") as unknown[] | undefined) ?? [];
            rec.state.set("quotes", [...reads, query]);
            return opts.westock?.quote ?? `mock quote for ${query}`;
          },
        }),
    ...(opts.danjuan === undefined
      ? {}
      : {
          danjuan: () => ({
            enabled: opts.danjuan?.enabled ?? true,
            ready: opts.danjuan?.ready ?? false,
            state: opts.danjuan?.state ?? "off",
          }),
          fundHoldings: async (query?: { days?: number; account?: string }) => {
            const reads = (rec.state.get("fundHoldings") as unknown[] | undefined) ?? [];
            rec.state.set("fundHoldings", [...reads, query ?? {}]);
            return opts.danjuan?.report ?? "mock fund holdings report";
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
