// 定时任务: what the Herder does at set times (ADR 0055). Schedules are made by talking to the
// Herder; here the owner sees them and can pause, resume or remove one. Under them, 在盯的 lists
// what AgentHerd watches for the owner (pull requests, mail, new GitHub work, platform notices).

import type { SchedulesView } from "@agentherd/host/api";
import { CalendarClock, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, Group, Switch } from "../components/ui";
import { WatchesSection } from "../components/WatchesSection";
import { nextText, type Schedule, whenText } from "../schedule-text";
import { call, useApp } from "../store";

/** The Herder changes schedules in chat, and a run moves the next time; look again now and then. */
const REFRESH_MS = 30_000;

function ScheduleRow({
  schedule,
  onChange,
}: {
  schedule: Schedule;
  onChange: (v: SchedulesView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<SchedulesView | undefined>) => {
    setBusy(true);
    const v = await action();
    setBusy(false);
    if (v !== undefined) onChange(v);
  };
  const remove = () => {
    if (!window.confirm(`删除定时任务「${schedule.about}」？删除后主管不会再按时做这件事。`))
      return;
    void run(() => call((h) => h.removeSchedule(schedule.id)));
  };
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-ink text-md" title={schedule.prompt}>
          {schedule.about}
        </div>
        <div className="truncate text-ink-muted text-sm">
          {whenText(schedule.when)} · {nextText(schedule)}
        </div>
      </div>
      <Switch
        label={schedule.paused ? "恢复" : "暂停"}
        checked={!schedule.paused}
        disabled={busy}
        onChange={(on) => void run(() => call((h) => h.setSchedulePaused(schedule.id, !on)))}
      />
      <Button variant="ghost" size="sm" aria-label="删除" disabled={busy} onClick={remove}>
        <Trash2 size={13} />
      </Button>
    </div>
  );
}

/** The Herder's schedules, or why there are none. */
function Schedules() {
  const [view, setView] = useState<SchedulesView | undefined>();
  const load = useCallback(async () => {
    const v = await call((h) => h.schedules());
    if (v !== undefined) setView(v);
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  if (view === undefined) return null;
  if (!view.ready) {
    return (
      <Group>
        <EmptyState
          icon={<CalendarClock size={18} />}
          text="连上飞书、AgentHerd 开始工作后，这里会显示主管的定时任务。"
        />
      </Group>
    );
  }
  if (view.schedules.length === 0) {
    return (
      <Group>
        <EmptyState
          icon={<CalendarClock size={18} />}
          text="还没有定时任务。直接跟主管说，比如「每天早上 9 点看看 PI-Desktop 有没有新 issue」。"
        />
      </Group>
    );
  }
  return (
    <Group>
      {view.schedules.map((s) => (
        <ScheduleRow key={s.id} schedule={s} onChange={setView} />
      ))}
    </Group>
  );
}

export function SchedulesPage() {
  useEffect(() => {
    void call((h) => h.watches()).then((watches) => watches && useApp.setState({ watches }));
  }, []);
  return (
    <div className="flex flex-col gap-7">
      <Schedules />
      <WatchesSection />
    </div>
  );
}
