// 应用连接 › 资讯 (ADR 0059): public news sources the Herder and agents can read without signing
// in. A switch turns a source on or off for everyone.

import type { FeedSource } from "@agentherd/host/api";
import { Loader2 } from "lucide-react";
import { call, useApp } from "../store";
import { Group, IconTile, Row, Section, Switch } from "./ui";

/** What each source offers, one line each. */
const ABOUT: Record<FeedSource, string> = {
  "github-trending": "今天 / 本周 / 本月的热门仓库，可按语言看",
  "hacker-news": "首页、每周最佳、按关键词搜",
  arxiv: "按关键词或分类看最新论文",
};

const TILE: Record<FeedSource, string> = {
  "github-trending": "G",
  "hacker-news": "Y",
  arxiv: "a",
};

export function FeedsSection() {
  const feeds = useApp((s) => s.feeds);
  const toggle = async (source: FeedSource, on: boolean) => {
    const next = await call((h) => h.setFeed(source, on));
    if (next !== undefined) useApp.setState({ feeds: next });
  };
  return (
    <Section title="资讯" hint="不用登录。主管和 Agent 都能读，可以配定时任务每天推给你">
      <Group>
        {feeds === undefined ? (
          <div className="flex items-center gap-2 px-4 py-3 text-ink-muted text-md">
            <Loader2 size={14} className="animate-spin" />
            正在加载…
          </div>
        ) : (
          feeds.map((f) => (
            <Row
              key={f.source}
              icon={<IconTile tone={f.on ? "green" : "gray"}>{TILE[f.source]}</IconTile>}
              title={f.name}
              description={ABOUT[f.source]}
              trailing={
                <Switch
                  label={f.name}
                  checked={f.on}
                  onChange={(on) => void toggle(f.source, on)}
                />
              }
            />
          ))
        )}
        <div className="px-4 py-2.5 text-ink-muted text-xs">
          跟主管说就行，比如「每天早上 9 点把 AI 相关的 Trending 挑几个发我」
        </div>
      </Group>
    </Section>
  );
}
