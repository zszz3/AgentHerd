// 应用连接: what agents can reach with the owner's own accounts (小红书, 知乎, 飞书, Composio apps),
// public news, where notes go, and everything AgentHerd watches for the owner (ADR 0058, 0059).
// Events keep the lists fresh after the first load.

import { useEffect } from "react";
import { AppsSection } from "../components/AppsSection";
import { FeedsSection } from "../components/FeedsSection";
import { LarkSection } from "../components/LarkSection";
import { APPS_ANCHOR, NotesSection } from "../components/NotesSection";
import { SocialSection } from "../components/SocialSection";
import { WatchesSection } from "../components/WatchesSection";
import { call, useApp } from "../store";

export function ConnectionsPage() {
  useEffect(() => {
    void call((h) => h.socials()).then((socials) => socials && useApp.setState({ socials }));
    void call((h) => h.watches()).then((watches) => watches && useApp.setState({ watches }));
    void call((h) => h.lark()).then((lark) => lark && useApp.setState({ lark }));
    void call((h) => h.feeds()).then((feeds) => feeds && useApp.setState({ feeds }));
  }, []);
  return (
    <div className="flex flex-col gap-7">
      <SocialSection />
      <LarkSection />
      <div id={APPS_ANCHOR} className="scroll-mt-4">
        <AppsSection />
      </div>
      <FeedsSection />
      <NotesSection />
      <WatchesSection />
    </div>
  );
}
