// 应用连接: what agents can reach with the owner's own accounts (小红书, 知乎, Composio apps), and
// everything AgentHerd watches for the owner (ADR 0058). Events keep the lists fresh after the
// first load.

import { useEffect } from "react";
import { AppsSection } from "../components/AppsSection";
import { SocialSection } from "../components/SocialSection";
import { WatchesSection } from "../components/WatchesSection";
import { call, useApp } from "../store";

export function ConnectionsPage() {
  useEffect(() => {
    void call((h) => h.socials()).then((socials) => socials && useApp.setState({ socials }));
    void call((h) => h.watches()).then((watches) => watches && useApp.setState({ watches }));
  }, []);
  return (
    <div className="flex flex-col gap-7">
      <SocialSection />
      <AppsSection />
      <WatchesSection />
    </div>
  );
}
