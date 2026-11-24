import { coreDataPaths, type DataHomePath } from "@agentherd/core/data-home-paths";
import { dingTalkStateFiles } from "./dingtalk-cli.ts";

export const westockDataPaths = {
  win32: { relative: "bin/westock.exe", kind: "persistent" },
  posix: { relative: "bin/westock", kind: "persistent" },
} as const satisfies Record<string, DataHomePath>;

const bin = { relative: "bin", kind: "persistent" } as const;

export const XHS_VERSION = "v2.7.4";
const xhsAssets: Record<string, string> = {
  "darwin-arm64": "xiaohongshu-mcp-darwin-arm64",
  "win32-x64": "xiaohongshu-mcp-windows-amd64.exe",
  "win32-arm64": "xiaohongshu-mcp-windows-amd64.exe",
  "linux-x64": "xiaohongshu-mcp-linux-amd64",
};

export function xhsDownload(plat: NodeJS.Platform, cpu: string) {
  const asset = xhsAssets[`${plat}-${cpu}`];
  if (asset === undefined) return undefined;
  const ext = plat === "win32" ? ".exe" : "";
  const relative = `${bin.relative}/xiaohongshu-mcp-${XHS_VERSION}${ext}`;
  return {
    asset,
    paths: {
      xiaohongshuBinary: { relative, kind: "persistent" },
      xiaohongshuPartial: { relative: `${relative}.part`, kind: "transient" },
    } as const satisfies Record<string, DataHomePath>,
  };
}

const wecomCli = { relative: "wecom-cli", kind: "persistent" } as const;

export const wecomConfigFiles = {
  credentials: ["credentials.enc", "bot.enc", "token.enc", ".encryption_key"],
  config: "config.json",
  disconnectPending: "disconnect-pending",
} as const;

const dingTalkDws = { relative: "dingtalk-dws", kind: "persistent" } as const;

export const hostDataPaths = {
  wecomCli,
  dingTalkDws,
  dingTalkConfig: {
    relative: `${dingTalkDws.relative}/${dingTalkStateFiles.config}`,
    kind: "persistent",
  },
  // The CLI takes this lock while it runs and creates it again when it is missing.
  dingTalkConfigLock: {
    relative: `${dingTalkDws.relative}/${dingTalkStateFiles.config}/.data.lock`,
    kind: "transient",
  },
  dingTalkCredentials: {
    relative: `${dingTalkDws.relative}/${dingTalkStateFiles.credentials}`,
    kind: "persistent",
  },
  dingTalkResetPending: {
    relative: `${dingTalkDws.relative}/${dingTalkStateFiles.resetPending}`,
    kind: "persistent",
  },
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
  bin,
  ...xhsDownload(process.platform, process.arch)?.paths,
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
  ...[
    ...wecomConfigFiles.credentials,
    wecomConfigFiles.config,
    wecomConfigFiles.disconnectPending,
  ].map((name): DataHomePath => ({ relative: `${wecomCli.relative}/${name}`, kind: "persistent" })),
  ...Object.values(sqliteCompanions),
];
