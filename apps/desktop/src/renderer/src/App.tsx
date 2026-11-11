// The app shell: a sidebar on the window frame, and the page on a rounded card beside it.

import {
  Bot,
  Boxes,
  ListTodo,
  Loader2,
  type LucideIcon,
  Settings,
  SquareTerminal,
  WifiOff,
} from "lucide-react";
import { useEffect } from "react";
import { Logo } from "./components/Logo";
import { SidebarStatus } from "./components/SidebarStatus";
import { Dot, Segmented, Toasts } from "./components/ui";
import { FirstRun } from "./firstrun/FirstRun";
import { AgentsPage } from "./pages/AgentsPage";
import { HerdersPage } from "./pages/HerdersPage";
import { MemoryPage } from "./pages/MemoryPage";
import { ModelsPage } from "./pages/ModelsPage";
import { SchedulesPage } from "./pages/SchedulesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TasksPage } from "./pages/TasksPage";
import { type Page, startStore, useApp } from "./store";

/** The sidebar entries; 主管 holds several pages, shown as tabs. */
const NAV: { page: Page; label: string; icon: LucideIcon; pages: readonly Page[] }[] = [
  { page: "tasks", label: "任务", icon: ListTodo, pages: ["tasks"] },
  { page: "herders", label: "主管", icon: Bot, pages: ["herders", "memory", "schedules"] },
  { page: "models", label: "模型", icon: Boxes, pages: ["models"] },
  { page: "agents", label: "Agent", icon: SquareTerminal, pages: ["agents"] },
  { page: "settings", label: "设置", icon: Settings, pages: ["settings"] },
];

const TABS: Partial<Record<Page, string>> = {
  herders: "模型和风格",
  memory: "记忆",
  schedules: "定时任务",
};

function entryOf(page: Page) {
  return NAV.find((n) => n.pages.includes(page)) ?? NAV[0];
}

const HEADERS: Record<Page, { title: string; hint: string }> = {
  tasks: { title: "任务", hint: "Agent 在做什么，哪些在等你" },
  herders: {
    title: "主管",
    hint: "在飞书里回答你、帮你开任务、跟进进度；不会替你批准任何请求",
  },
  memory: {
    title: "主管",
    hint: "主管长期记住的事；不对就改掉或忘掉，飞书里也能用 /记忆 查看",
  },
  schedules: {
    title: "主管",
    hint: "主管按时去做的事；在飞书里跟主管说就能加，这里可以暂停或删除",
  },
  models: { title: "模型", hint: "模型服务和 Key，Pi 和各档任务用哪个模型" },
  agents: { title: "Agent", hint: "替你干活的编程 Agent；主管开任务时按模型自动挑" },
  settings: { title: "设置", hint: "飞书、应用连接、审批方式、外观、电源和数据目录" },
};

function Sidebar() {
  const page = useApp((s) => s.page);
  const setPage = useApp((s) => s.setPage);
  const waiting = useApp((s) => s.tasks?.items.length ?? 0);
  const herderOff = useApp((s) => s.status?.herder.on === false);
  return (
    <aside className="relative z-10 flex w-(--ah-sidebar-width) shrink-0 flex-col">
      {/* The traffic lights of the hiddenInset title bar sit in this strip. */}
      <div className="app-drag h-(--ah-titlebar-height) shrink-0" />
      <div className="app-drag flex items-center gap-2.5 px-4 pt-1 pb-5">
        <Logo size={28} />
        <div className="min-w-0">
          <div className="font-semibold text-base text-ink tracking-[-0.1px]">AgentHerd</div>
          <div className="truncate text-ink-muted text-xs">在飞书里管理你的 Agent</div>
        </div>
      </div>
      <nav className="flex flex-col gap-px px-2.5">
        {NAV.map(({ page: p, label, icon: Icon, pages }) => {
          const active = pages.includes(page);
          return (
            <button
              key={p}
              type="button"
              data-nav={p}
              aria-current={active ? "page" : undefined}
              onClick={() => setPage(p)}
              className={`flex h-8 items-center gap-2.5 rounded-md px-2.5 text-left text-md ${
                active
                  ? "bg-selected font-medium text-ink"
                  : "text-ink-2 hover:bg-hover hover:text-ink"
              }`}
            >
              <Icon
                size={16}
                strokeWidth={1.75}
                className={active ? "text-accent-text" : "text-ink-muted"}
              />
              <span className="flex-1">{label}</span>
              {p === "tasks" && waiting > 0 && (
                <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-warning px-1.5 font-semibold text-white text-xs">
                  {waiting}
                </span>
              )}
              {p === "herders" && herderOff && <Dot tone="amber" />}
            </button>
          );
        })}
      </nav>
      <SidebarStatus />
    </aside>
  );
}

function ConnectionBanner() {
  const connected = useApp((s) => s.connected);
  if (connected) return null;
  return (
    <div className="shrink-0 overflow-hidden px-8 pb-3 [scrollbar-gutter:stable]">
      <div className="mx-auto flex max-w-[760px] items-center gap-2 rounded-lg bg-warning-soft px-3 py-2 text-md text-warning-text">
        <WifiOff size={14} />
        正在连接 AgentHerd 服务…
      </div>
    </div>
  );
}

function CurrentPage() {
  const page = useApp((s) => s.page);
  const setPage = useApp((s) => s.setPage);
  const loaded = useApp((s) => s.loaded);
  if (!loaded) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-ink-muted text-md">
        <Loader2 size={16} className="animate-spin" />
        正在加载…
      </div>
    );
  }
  const entry = entryOf(page);
  if (entry.pages.length === 1) return <PageBody page={page} />;
  return (
    <div className="flex flex-col gap-6">
      <Segmented
        label={entry.label}
        options={entry.pages.map((p) => ({ value: p, label: TABS[p] ?? p }))}
        value={page}
        onChange={setPage}
      />
      <PageBody page={page} />
    </div>
  );
}

function PageBody({ page }: { page: Page }) {
  switch (page) {
    case "tasks":
      return <TasksPage />;
    case "herders":
      return <HerdersPage />;
    case "memory":
      return <MemoryPage />;
    case "schedules":
      return <SchedulesPage />;
    case "agents":
      return <AgentsPage />;
    case "models":
      return <ModelsPage />;
    case "settings":
      return <SettingsPage />;
  }
}

export function App() {
  const page = useApp((s) => s.page);
  const firstRun = useApp((s) => s.firstRun);
  const loaded = useApp((s) => s.loaded);
  useEffect(() => startStore(), []);
  const header = HEADERS[page];
  return (
    <>
      {/* Under the first run the shell stays in the DOM, hidden, so a click on a
          data-nav button (screenshot capture) still opens its page and closes the first run. */}
      <div
        className={`ah-frame flex h-full text-ink ${firstRun ? "invisible" : ""}`}
        aria-hidden={firstRun || undefined}
      >
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col pr-2 pb-2">
          <div className="app-drag h-2 shrink-0" />
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-card border border-line bg-canvas">
            {/* Both reserve the scrollbar's width, so the title lines up with the content. */}
            <header className="app-drag flex min-h-[88px] shrink-0 flex-col justify-end overflow-hidden px-8 pb-5 [scrollbar-gutter:stable]">
              <div className="mx-auto w-full max-w-[760px]">
                <h1 className="font-semibold text-ink text-xl tracking-[-0.2px]">{header.title}</h1>
                <p className="mt-0.5 text-ink-muted text-md">{header.hint}</p>
              </div>
            </header>
            <ConnectionBanner />
            <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-10 [scrollbar-gutter:stable]">
              <div className="mx-auto flex min-h-full w-full max-w-[760px] flex-col">
                <CurrentPage />
              </div>
            </div>
          </main>
        </div>
      </div>
      {firstRun && loaded && <FirstRun />}
      <Toasts />
    </>
  );
}
