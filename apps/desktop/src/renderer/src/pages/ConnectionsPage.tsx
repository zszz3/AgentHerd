// 应用连接: the accounts agents can use for the owner (小红书, 知乎, 飞书, Notion, Obsidian and more
// Composio apps), and public news (ADR 0058, 0059). Each account is one folded row. Events keep
// the lists fresh after the first load.

import { useEffect, useState } from "react";
import { MoreAppsRow, NotionRow } from "../components/AppsSection";
import { FeedsSection } from "../components/FeedsSection";
import { LarkRow } from "../components/LarkSection";
import { ObsidianRow } from "../components/ObsidianRow";
import { SocialRows } from "../components/SocialSection";
import { Group, Section } from "../components/ui";
import { call, useApp } from "../store";

/** 「已连接 4 个 · 1 个出错」 over 小红书, 知乎, 飞书, Notion and Obsidian. */
function Summary() {
  const socials = useApp((s) => s.socials);
  const lark = useApp((s) => s.lark);
  const apps = useApp((s) => s.apps);
  const vault = useApp((s) => s.status?.obsidianVault);
  if (socials === undefined || lark === undefined || apps === undefined) return null;
  const connected =
    socials.filter((s) => s.state === "ready").length +
    (lark.state === "ready" ? 1 : 0) +
    (apps.apps.some((a) => a.slug === "notion" && a.connected) ? 1 : 0) +
    (vault !== undefined && vault !== "" ? 1 : 0);
  const failed =
    socials.filter((s) => s.state === "failed").length + (lark.state === "failed" ? 1 : 0);
  return (
    <p className="text-ink-2 text-md">
      {connected === 0 ? "还没连接账号" : `已连接 ${connected} 个`}
      {failed > 0 && <span className="text-danger-text"> · {failed} 个出错</span>}
    </p>
  );
}

export function ConnectionsPage() {
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    void call((h) => h.socials()).then((socials) => socials && useApp.setState({ socials }));
    void call((h) => h.lark()).then((lark) => lark && useApp.setState({ lark }));
    void call((h) => h.apps()).then((apps) => apps && useApp.setState({ apps }));
    void call((h) => h.feeds()).then((feeds) => feeds && useApp.setState({ feeds }));
  }, []);
  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-3">
        <Summary />
        <Section title="账号">
          <Group>
            <SocialRows />
            <LarkRow />
            <NotionRow onNeedKey={() => setMoreOpen(true)} />
            <ObsidianRow />
            <MoreAppsRow open={moreOpen} onOpenChange={setMoreOpen} />
          </Group>
        </Section>
      </div>
      <FeedsSection />
    </div>
  );
}
