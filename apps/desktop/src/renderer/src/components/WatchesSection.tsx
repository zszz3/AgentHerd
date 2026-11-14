// 定时任务 › 在盯的 (ADR 0058): everything AgentHerd watches for the owner — pull requests, mail, new
// GitHub work and platform notices. The Herder adds them in chat; here the owner can pause one or
// remove it. Platform watches are switched in 应用连接 › 账号, so they cannot be removed here.

import type { WatchView } from "@agentherd/host/api";
import { Eye, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
import { call, useApp } from "../store";
import { Badge, Button, EmptyState, Group, Section, Switch } from "./ui";

const KIND: Record<WatchView["kind"], string> = {
  pr: "PR",
  mail: "邮件",
  intake: "GitHub 新工作",
  social: "平台",
};

/** 「刚刚」「5 分钟前」「3 小时前」「2 天前」, or 「11月3日」 when older than a week. */
export function ago(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  const ms = now - at.getTime();
  if (Number.isNaN(ms)) return iso;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return `${at.getMonth() + 1}月${at.getDate()}日`;
}

function WatchRow({ watch }: { watch: WatchView }) {
  const [busy, setBusy] = useState(false);
  const apply = async (action: () => Promise<WatchView[] | undefined>) => {
    setBusy(true);
    const next = await action();
    setBusy(false);
    if (next !== undefined) useApp.setState({ watches: next });
  };
  const remove = () => {
    if (!window.confirm(`不再盯着「${watch.title}」？`)) return;
    void apply(() => call((h) => h.removeWatch(watch.id)));
  };
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-ink text-md" title={watch.title}>
            {watch.title}
          </span>
          <Badge tone={watch.kind === "social" ? "blue" : "gray"}>{KIND[watch.kind]}</Badge>
          {watch.paused && <Badge tone="amber">已暂停</Badge>}
        </div>
        <div className="truncate text-ink-muted text-sm">
          {watch.detail}
          {watch.activeAt !== undefined && ` · 最近动静 ${ago(watch.activeAt)}`}
        </div>
      </div>
      <Switch
        label={watch.paused ? "继续" : "暂停"}
        checked={!watch.paused}
        disabled={busy}
        onChange={(on) => void apply(() => call((h) => h.setWatchPaused(watch.id, !on)))}
      />
      {watch.removable ? (
        <Button variant="ghost" size="sm" aria-label="删除" disabled={busy} onClick={remove}>
          <Trash2 size={13} />
        </Button>
      ) : (
        // Keeps the switches in one column when a row has no delete button.
        <span className="w-[29px] shrink-0" aria-hidden />
      )}
    </div>
  );
}

export function WatchesSection() {
  const watches = useApp((s) => s.watches);
  return (
    <Section title="在盯的" hint="跟主管说「帮我盯着…」就会加进来，说一句也能暂停">
      <Group>
        {watches === undefined ? (
          <div className="flex items-center gap-2 px-4 py-3 text-ink-muted text-md">
            <Loader2 size={14} className="animate-spin" />
            正在加载…
          </div>
        ) : watches.length === 0 ? (
          <EmptyState icon={<Eye size={18} />} text="还没有在盯的东西" />
        ) : (
          watches.map((w) => <WatchRow key={w.id} watch={w} />)
        )}
      </Group>
    </Section>
  );
}
