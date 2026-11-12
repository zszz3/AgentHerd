import { createRoot } from "react-dom/client";
import { AppsPanel } from "../../src/renderer/src/components/AppsSection";
import { useApp } from "../../src/renderer/src/store";

const apps = [
  { slug: "gmail", name: "Gmail", connected: true, connecting: false },
  { slug: "CODE_HOST", name: "GitHub", connected: false, connecting: false },
];
const all = { hasKey: true, apps };
const calls: { search?: string; resolve: (view: typeof all) => void }[] = [];
// The real component and store run in Chromium; only the external host is replaced.
Object.assign(window, {
  agentherd: {
    host: {
      apps: (search?: string) =>
        new Promise<typeof all>((resolve) => calls.push({ search, resolve })),
    },
  },
  searchTest: {
    pending: () => calls.length,
    stored: () => useApp.getState().apps?.apps.map((a) => a.slug),
    answer: (i: number, filtered: boolean) =>
      calls[i]?.resolve({ ...all, apps: filtered ? [apps[1]] : apps }),
    event: () => useApp.setState({ apps: all }),
    many: () =>
      useApp.setState({
        apps: {
          hasKey: true,
          apps: Array.from({ length: 12 }, (_, i) => ({
            slug: `app-${i}`,
            name: `App ${i}`,
            connected: i >= 10,
            connecting: false,
          })),
        },
      }),
  },
});
useApp.setState({ apps: all });
const root = document.getElementById("root");
if (root === null) throw new Error("missing root");
createRoot(root).render(<AppsPanel />);
