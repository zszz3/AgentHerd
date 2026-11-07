// A HerderHost that records what the Herder does, for unit tests.

import type { HerderHost, MailWatch, MemoryStore, Task } from "@agentherd/core";
import { CORE_TEXTS } from "@agentherd/core";

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
    startTask: async (profileId, cwd, title, prompt, model, images) => {
      rec.started.push({
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
