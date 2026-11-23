// 应用连接: the accounts agents can use for the owner, and public news (ADR 0058, 0059).
// Each account is one folded row. 插件 installs Claude Code / Gemini CLI plugins (ADR 0094).

import type { WecomView } from "@agentherd/host/api";
import { useEffect, useState } from "react";
import { MoreAppsRow, NotionRow } from "../components/AppsSection";
import { DanjuanRow } from "../components/DanjuanSection";
import { FeedsSection } from "../components/FeedsSection";
import { LarkRow } from "../components/LarkSection";
import { ObsidianRow } from "../components/ObsidianRow";
import { PluginsSection } from "../components/PluginsSection";
import { SocialRows } from "../components/SocialSection";
import { Group, Section } from "../components/ui";
import { WecomRow } from "../components/WecomSection";
import { WestockRow } from "../components/WestockSection";
import { call, useApp } from "../store";

/** 「已连接 4 个 · 1 个出错」 across the account rows. */
function Summary({ wecom }: { wecom: WecomView | undefined }) {
  const socials = useApp((s) => s.socials);
  const lark = useApp((s) => s.lark);
  const apps = useApp((s) => s.apps);
  const vault = useApp((s) => s.status?.obsidianVault);
  if (socials === undefined || lark === undefined || apps === undefined) return null;
  const connected =
    socials.filter((s) => s.state === "ready").length +
    (lark.state === "ready" ? 1 : 0) +
    (apps.apps.some((a) => a.slug === "notion" && a.connected) ? 1 : 0) +
    (vault !== undefined && vault !== "" ? 1 : 0) +
    (wecom?.state === "connected" ? 1 : 0);
  const failed =
    socials.filter((s) => s.state === "failed").length +
    (lark.state === "failed" ? 1 : 0) +
    (wecom?.state === "failed" ? 1 : 0);
  return (
    <p className="text-ink-2 text-md">
      {connected === 0 ? "还没连接账号" : `已连接 ${connected} 个`}
      {failed > 0 && <span className="text-danger-text"> · {failed} 个出错</span>}
    </p>
  );
}

export function ConnectionsPage() {
  const [moreOpen, setMoreOpen] = useState(false);
  const [wecom, setWecom] = useState<WecomView>();
  useEffect(() => {
    void call((h) => h.socials()).then((socials) => socials && useApp.setState({ socials }));
    void call((h) => h.lark()).then((lark) => lark && useApp.setState({ lark }));
    void call((h) => h.apps()).then((apps) => apps && useApp.setState({ apps }));
    void call((h) => h.feeds()).then((feeds) => feeds && useApp.setState({ feeds }));
    void call((h) => h.westock()).then((westock) => westock && useApp.setState({ westock }));
    void call((h) => h.danjuan()).then((danjuan) => danjuan && useApp.setState({ danjuan }));
  }, []);
  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-3">
        <Summary wecom={wecom} />
        <Section title="账号">
          <Group>
            <SocialRows />
            <LarkRow />
            <WecomRow view={wecom} onView={setWecom} />
            <NotionRow onNeedKey={() => setMoreOpen(true)} />
            <ObsidianRow />
            <MoreAppsRow open={moreOpen} onOpenChange={setMoreOpen} />
          </Group>
        </Section>
      </div>
      <Section title="行情与投研" hint="免登录看最新大盘与个股行情，或连接雪球基金查看个人持仓涨跌">
        <Group>
          <WestockRow />
          <DanjuanRow />
        </Group>
      </Section>
      <PluginsSection />
      <FeedsSection />
    </div>
  );
}
