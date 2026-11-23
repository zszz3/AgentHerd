import { coreDataPaths, type DataHomePath } from "@agentherd/core/data-home-paths";

export const westockDataPaths = {
  win32: { relative: "bin/westock.exe", kind: "persistent" },
  posix: { relative: "bin/westock", kind: "persistent" },
} as const satisfies Record<string, DataHomePath>;

export const hostDataPaths = {
  config: { relative: "config.json", kind: "persistent" },
  secrets: { relative: "secrets.json", kind: "persistent" },
  run: { relative: "run", kind: "persistent" },
  hostSocket: { relative: "run/herd.sock", kind: "transient" },
  mcpSocket: { relative: "run/mcp.sock", kind: "transient" },
  feishuQr: { relative: "run/qr.png", kind: "transient" },
  claude: { relative: "run/claude", kind: "persistent" },
  claudeSettings: { relative: "run/claude/settings.json", kind: "persistent" },
  piSessions: { relative: "pi-sessions", kind: "persistent" },
  plugins: { relative: "plugins", kind: "persistent" },
  pluginCatalog: { relative: "plugins/catalog.json", kind: "persistent" },
  pluginStaging: { relative: "plugins/.staging", kind: "persistent" },
  runtimes: { relative: "runtimes", kind: "persistent" },
  feeds: { relative: "feeds", kind: "persistent" },
  feedTold: { relative: "feeds/told.json", kind: "persistent" },
  bin: { relative: "bin", kind: "persistent" },
  westock: process.platform === "win32" ? westockDataPaths.win32 : westockDataPaths.posix,
  models: { relative: "models", kind: "persistent" },
  danjuan: { relative: "danjuan", kind: "persistent" },
  danjuanProfile: { relative: "danjuan/profile", kind: "persistent" },
  zhihu: { relative: "zhihu", kind: "persistent" },
  zhihuProfile: { relative: "zhihu/profile", kind: "persistent" },
  xiaohongshu: { relative: "xiaohongshu", kind: "persistent" },
  xiaohongshuCookies: { relative: "xiaohongshu/cookies.json", kind: "persistent" },
  logs: { relative: "logs", kind: "persistent" },
  hostLog: { relative: "logs/host.log", kind: "persistent" },
} as const satisfies Record<string, DataHomePath>;

const db = coreDataPaths.database.relative;
export const sqliteCompanions = {
  wal: { relative: `${db}-wal`, kind: "sqlite" },
  shm: { relative: `${db}-shm`, kind: "sqlite" },
  journal: { relative: `${db}-journal`, kind: "sqlite" },
} as const satisfies Record<string, DataHomePath>;

// Content under these fixed paths is ordinary unless it has its own declared path.
export const fixedDataPaths: readonly DataHomePath[] = [
  ...Object.values(coreDataPaths),
  ...Object.values(hostDataPaths),
  ...Object.values(sqliteCompanions),
];
