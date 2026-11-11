// App state: one zustand store fed by host calls, host events and a 5 s task poll.
// The renderer reaches the host only through `window.agentherd` (see src/shared/bridge.ts).

import type {
  AgentView,
  AppsView,
  FeedView,
  HostApi,
  HostEvent,
  HostStatus,
  LarkView,
  ModelsView,
  ProviderView,
  RemoteHost,
  SetupState,
  SocialView,
  TasksView,
  TranscriptView,
  WatchView,
} from "@agentherd/host/api";
import { create } from "zustand";
import type { Bridge } from "../../shared/bridge";

export type { TranscriptView };

// Core types, derived from the host API so the renderer depends on one package only.
export type Task = TasksView["tasks"][number];
export type ItemSummary = TasksView["items"][number];
export type ServiceView = ModelsView["services"][number];
export type ModelService = Parameters<HostApi["putService"]>[0];
export type ModelRole = Parameters<HostApi["chooseModel"]>[0];
export type ModelRef = NonNullable<Parameters<HostApi["chooseModel"]>[1]>;
export type Stage = Task["stage"];
export type Mode = HostStatus["mode"];

export type Page =
  | "tasks"
  | "herders"
  | "memory"
  | "schedules"
  | "connections"
  | "agents"
  | "models"
  | "settings";

export interface Toast {
  id: number;
  kind: "error" | "info";
  text: string;
}

interface AppState {
  connected: boolean;
  loaded: boolean;
  status: HostStatus | undefined;
  tasks: TasksView | undefined;
  models: ModelsView | undefined;
  agents: AgentView[];
  /** 应用连接 › 应用 (Composio); loaded when the section shows. */
  apps: AppsView | undefined;
  /** 应用连接 › 平台 (小红书, 知乎); loaded when the page shows, then kept by events. */
  socials: SocialView[] | undefined;
  /** 应用连接 › 监听; loaded when the page shows, then kept by events. */
  watches: WatchView[] | undefined;
  /** 应用连接 › 飞书 (lark-cli); loaded when the page shows, then kept by "lark" events. */
  lark: LarkView | undefined;
  /** 应用连接 › 资讯; loaded when the page shows. */
  feeds: FeedView[] | undefined;
  providers: ProviderView[];
  setup: SetupState | undefined;
  page: Page;
  /** The first-run flow covers the window. */
  firstRun: boolean;
  toasts: Toast[];
  /** Shows a page. It also closes the first run, without marking it done. */
  setPage(page: Page): void;
  openFirstRun(): void;
  /** Closes the first run and remembers that it ran, so it does not open by itself again. */
  finishFirstRun(): void;
  toast(text: string, kind?: Toast["kind"]): void;
  dismissToast(id: number): void;
}

const PAGES: readonly Page[] = [
  "tasks",
  "herders",
  "memory",
  "schedules",
  "connections",
  "agents",
  "models",
  "settings",
];

/** Set once the owner finished or skipped the first run. */
const FIRST_RUN_DONE = "agentherd.firstRunDone";

function firstRunDone(): boolean {
  try {
    return window.localStorage.getItem(FIRST_RUN_DONE) !== null;
  } catch {
    return false;
  }
}

/** A page named in the URL hash (e.g. "#models"), for previews and reloads. */
function hashPage(): Page | undefined {
  const name = window.location.hash.slice(1);
  return PAGES.find((p) => p === name);
}

export const useApp = create<AppState>()((set, get) => ({
  connected: false,
  loaded: false,
  status: undefined,
  tasks: undefined,
  models: undefined,
  agents: [],
  apps: undefined,
  socials: undefined,
  watches: undefined,
  lark: undefined,
  feeds: undefined,
  providers: [],
  setup: undefined,
  page: hashPage() ?? "tasks",
  // "#onboarding" opens the first run at once, for previews and screenshots.
  firstRun: window.location.hash === "#onboarding",
  toasts: [],
  setPage: (page) => set({ page, firstRun: false }),
  openFirstRun: () => set({ firstRun: true }),
  finishFirstRun: () => {
    try {
      window.localStorage.setItem(FIRST_RUN_DONE, new Date().toISOString());
    } catch {
      // Without storage the first run may show again next time; nothing else breaks.
    }
    set({ firstRun: false });
  },
  toast: (text, kind = "error") => {
    const id = nextToastId++;
    set({ toasts: [...get().toasts, { id, kind, text }] });
    setTimeout(() => get().dismissToast(id), 6000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

let nextToastId = 1;

export function bridge(): Bridge {
  return window.agentherd;
}

export function host(): RemoteHost {
  return window.agentherd.host;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Runs a host call and shows a toast if it fails.
 * @returns The result, or undefined after an error.
 */
export async function call<T>(fn: (h: RemoteHost) => Promise<T>): Promise<T | undefined> {
  try {
    return await fn(host());
  } catch (error) {
    useApp.getState().toast(errorText(error));
    return undefined;
  }
}

/** Connects the channel again and shows the status it returns. */
export async function reconnect(): Promise<void> {
  const status = await call((h) => h.reconnect());
  if (status !== undefined) useApp.setState({ status });
}

/** Applies a models view returned by a host call. */
export function applyModels(models: ModelsView | undefined): void {
  if (models !== undefined) useApp.setState({ models });
}

/** True when setup is not finished: no Feishu binding or no Herder model. */
export function needsOnboarding(status: HostStatus | undefined, models: ModelsView | undefined) {
  if (status === undefined || models === undefined) return false;
  return !status.channel.bound || models.roles.herder === undefined;
}

function applyEvent(event: HostEvent): void {
  switch (event.topic) {
    case "status":
      useApp.setState({ status: event.data });
      break;
    case "tasks":
      useApp.setState({ tasks: event.data });
      break;
    case "models":
      useApp.setState({ models: event.data });
      break;
    case "agents":
      useApp.setState({ agents: event.data });
      break;
    case "apps":
      useApp.setState({ apps: event.data });
      break;
    case "socials":
      useApp.setState({ socials: event.data });
      break;
    case "watches":
      useApp.setState({ watches: event.data });
      break;
    case "lark":
      useApp.setState({ lark: event.data });
      break;
    case "setup":
      useApp.setState({ setup: event.data });
      if (event.data.phase === "connected") void refreshStatus();
      break;
  }
}

async function refreshStatus(): Promise<void> {
  try {
    useApp.setState({ status: await host().status() });
  } catch {
    // The connection banner explains failures; nothing else to do here.
  }
}

/** Loads everything from the host. Shows a toast on failure unless `quiet`. */
export async function loadAll(quiet = false): Promise<boolean> {
  try {
    const h = host();
    const [status, tasks, models, providers, setup, agents] = await Promise.all([
      h.status(),
      h.tasks(),
      h.models(),
      h.providers(),
      h.setupState(),
      h.agents(),
    ]);
    const first = !useApp.getState().loaded;
    useApp.setState({
      status,
      tasks,
      models,
      providers,
      setup,
      agents,
      connected: true,
      loaded: true,
    });
    // The first run opens by itself once, when setup is not finished. A page in the hash is a
    // preview of that page, so it does not.
    if (first && window.location.hash === "" && needsOnboarding(status, models) && !firstRunDone())
      useApp.setState({ firstRun: true });
    return true;
  } catch (error) {
    if (!quiet) useApp.getState().toast(errorText(error));
    return false;
  }
}

let started = false;

/** Connects the store to the bridge. Call once at startup. */
export function startStore(): void {
  if (started) return;
  started = true;
  const b = bridge();
  b.onEvent(applyEvent);
  b.onConnection((connected) => {
    const was = useApp.getState().connected;
    useApp.setState({ connected });
    if (connected && !was) void loadAll(true);
  });
  void loadAll(true);
  // Retry the first load until the host answers; events and the poll take over after that.
  const retry = setInterval(() => {
    if (useApp.getState().loaded) clearInterval(retry);
    else void loadAll(true);
  }, 2000);
  setInterval(() => {
    if (!useApp.getState().loaded) return;
    host()
      .tasks()
      .then((tasks) => useApp.setState({ tasks }))
      .catch(() => {
        // Poll failures are expected while the host restarts; the banner covers it.
      });
  }, 5000);
}
