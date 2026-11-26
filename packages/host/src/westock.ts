// Tencent WeStock (腾讯自选股): zero-login live market quotes for the Herder and MCP tasks, plus
// one-click installation and health checks for the official `@tencent-adm/westock-data` CLI
// (`westock`) so coding/research agents can run deep fundamental, technical and flow analysis
// (ADR 0076).

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { promisify } from "node:util";
import type { AppToolInfo, AppTools, McpTool } from "@agentherd/core";
import type { WestockTest, WestockView } from "./api.ts";
import { hostDataPaths, westockDataPaths } from "./data-home-paths.ts";
import { envValue, onPath, searchPath } from "./profiles.ts";
import { currentTarget, renameWithRetry } from "./runtimes.ts";

const runExecFile = promisify(execFile);

export const WESTOCK_VERSION = "0.0.2";
export const WESTOCK_BASE_URL = `https://stockbuddy.qq.com/release/skillhub/cli/v${WESTOCK_VERSION}`;

interface WestockRelease {
  asset: string;
  sha256: string;
}

/** Pinned official `@tencent-adm/westock-data` CLI binaries from `SHA256.txt` (v0.0.2). */
export const WESTOCK_RELEASES: Readonly<Record<string, WestockRelease>> = {
  "darwin-arm64": {
    asset: "westock-darwin-arm64",
    sha256: "8018d5f7fe8efbd97887afee4d79f8c6cd900b586b99ea0de6d1ce7d53abdb8c",
  },
  "darwin-x64": {
    asset: "westock-darwin-amd64",
    sha256: "a0177711456d7bf701a352922b66c59c013860cc1460e3c20710c172de675615",
  },
  "linux-x64": {
    asset: "westock-linux-amd64",
    sha256: "8db2859db73dfd63b347779360213c00c20d96b43a2f0c66ca1171d1e32183e9",
  },
  "linux-arm64": {
    asset: "westock-linux-arm64",
    sha256: "47a1df7e71292661f3e422703a18eff35ca9d730075e8bcf400d251d106203c1",
  },
  "win32-x64": {
    asset: "westock-windows-amd64.exe",
    sha256: "eb7d4eb83ac1501cb349693f8b383b81f23dd2c6554b5fbfccb4b30e2a931e0a",
  },
};

const DEFAULT_MARKET_CODES = [
  "sh000001",
  "sz399001",
  "sz399006",
  "sh000688",
  "hkHSI",
  "hkHSTECH",
  "us.DJI",
  "us.IXIC",
  "us.INX",
] as const;

const A_SHARE_MARKET_CODES = [
  "sh000001",
  "sz399001",
  "sz399006",
  "sh000688",
  "sh000300",
  "sh000905",
] as const;

const HK_MARKET_CODES = ["hkHSI", "hkHSTECH", "hkHSCEI"] as const;
const US_MARKET_CODES = ["us.DJI", "us.IXIC", "us.INX"] as const;

const SINGLE_ALIASES: Readonly<Record<string, string>> = {
  上证: "sh000001",
  上证指数: "sh000001",
  沪指: "sh000001",
  深成指: "sz399001",
  深证成指: "sz399001",
  深指: "sz399001",
  创业板: "sz399006",
  创业板指: "sz399006",
  科创50: "sh000688",
  科创板: "sh000688",
  沪深300: "sh000300",
  上证50: "sh000016",
  中证500: "sh000905",
  中证1000: "sh000852",
  北证50: "bj899050",
  恒指: "hkHSI",
  恒生指数: "hkHSI",
  恒生科技: "hkHSTECH",
  恒生科技指数: "hkHSTECH",
  国企指数: "hkHSCEI",
  道指: "us.DJI",
  道琼斯: "us.DJI",
  纳指: "us.IXIC",
  纳斯达克: "us.IXIC",
  标普: "us.INX",
  标普500: "us.INX",
  hsi: "hkHSI",
  hstech: "hkHSTECH",
  hscei: "hkHSCEI",
  dji: "us.DJI",
  "^dji": "us.DJI",
  ".dji": "us.DJI",
  ixic: "us.IXIC",
  nasdaq: "us.IXIC",
  "^ixic": "us.IXIC",
  ".ixic": "us.IXIC",
  inx: "us.INX",
  spx: "us.INX",
  "^gspc": "us.INX",
  ".inx": "us.INX",
};

const SUMMARY_ALL_RE =
  /^(?:今[天日]|最新|目前|当前|最近)?(?:的)?(?:股市|大盘|市场|主要指数|全球指数|股市行情|行情|指数)(?:情况|怎么样|如何|走势|表现|快照)?$|^market$/i;
const SUMMARY_A_RE =
  /^(?:今[天日]|最新|目前|当前)?(?:的)?(?:a股|大a|沪深|沪深两市)(?:行情|指数|大盘|情况|怎么样|如何|走势)?$/i;
const SUMMARY_HK_RE =
  /^(?:今[天日]|最新|目前|当前)?(?:的)?(?:港股|恒生系)(?:行情|指数|大盘|情况|怎么样|如何|走势)?$/i;
const SUMMARY_US_RE =
  /^(?:今[天日]|最新|目前|当前)?(?:的)?(?:美股|三大股指)(?:行情|指数|大盘|情况|怎么样|如何|走势)?$/i;

const REQUEST_TIMEOUT_MS = 8_000;
const INSTALL_TIMEOUT_MS = 60_000;
const MAX_CODES_PER_CALL = 20;

/** One candidate parsed from `smartbox.gtimg.cn`. */
export interface SmartboxHit {
  market: string;
  rawCode: string;
  code: string;
  name: string;
  pinyin: string;
  kind: string;
}

/** One parsed live quote packet from `qt.gtimg.cn`. */
export interface StockQuote {
  code: string;
  name: string;
  symbol: string;
  currency: "CNY" | "HKD" | "USD";
  isIndex: boolean;
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  change: number;
  changePct: number;
  /** Turnover in 100 million units of `currency` (亿元 / 亿港元 / 亿美元), when reported. */
  turnoverYi?: number;
  turnoverRate?: number;
  pe?: number;
  /** Total market capitalization in 100 million units of `currency`. */
  marketCapYi?: number;
  time: string;
}

/** Command runner injected for tests. */
export type WestockRun = (
  file: string,
  args: string[],
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export interface WestockOptions {
  home: string;
  /** Whether built-in quote lookup is enabled (defaults to true). */
  enabled?: () => boolean;
  fetch?: typeof fetch;
  run?: WestockRun;
  exists?: (path: string) => boolean;
  target?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  changed?: () => void;
  log?: (line: string) => void;
}

function unescapeUnicode(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCodePoint(Number.parseInt(hex, 16)),
  );
}

function normalizeSmartboxCode(market: string, rawCode: string): string | undefined {
  const m = market.toLowerCase();
  const c = rawCode.trim();
  if (m === "sh" || m === "sz" || m === "bj") return `${m}${c.toLowerCase()}`;
  if (m === "hk") {
    if (/^\d{1,5}$/.test(c)) return `hk${c.padStart(5, "0")}`;
    return `hk${c.toUpperCase()}`;
  }
  if (m === "us") {
    const stripped = c.replace(/\.(oq|n|am|ps|o|pk)$/i, "");
    return `us${stripped.toUpperCase()}`;
  }
  return undefined;
}

/**
 * Normalizes an unambiguous stock or index code into a Tencent Finance `qt.gtimg.cn` symbol
 * (`sh600519`, `hk00700`, `usNVDA`, `us.IXIC`), or returns undefined when Smartbox lookup is needed.
 */
export function normalizeStockCode(raw: string): string | undefined {
  const s = raw.trim();
  if (s === "") return undefined;

  const alias = SINGLE_ALIASES[s.toLowerCase()];
  if (alias !== undefined) return alias;

  const prefixedCn = /^(sh|sz|bj)(\d{6})$/i.exec(s);
  if (prefixedCn !== null) {
    return `${(prefixedCn[1] as string).toLowerCase()}${prefixedCn[2]}`;
  }

  const prefixedHkNum = /^hk(\d{1,5})$/i.exec(s);
  if (prefixedHkNum !== null) {
    return `hk${(prefixedHkNum[1] as string).padStart(5, "0")}`;
  }

  const prefixedHkIdx = /^hk(hsi|hstech|hscei|hsci)$/i.exec(s);
  if (prefixedHkIdx !== null) {
    return `hk${(prefixedHkIdx[1] as string).toUpperCase()}`;
  }

  const prefixedUs = /^us(\.[a-z]+|[a-z][a-z0-9.-]*)$/i.exec(s);
  if (prefixedUs !== null) {
    const sym = (prefixedUs[1] as string).replace(/\.(oq|n|am|ps|o|pk)$/i, "");
    return `us${sym.toUpperCase()}`;
  }

  const suffixCn = /^(\d{6})\.(sh|sz|bj)$/i.exec(s);
  if (suffixCn !== null) {
    return `${(suffixCn[2] as string).toLowerCase()}${suffixCn[1]}`;
  }

  const suffixHk = /^(\d{1,5})\.hk$/i.exec(s);
  if (suffixHk !== null) {
    return `hk${(suffixHk[1] as string).padStart(5, "0")}`;
  }

  const suffixUs = /^([a-z][a-z0-9.-]*)\.(us|oq|n|am|ps|o|pk)$/i.exec(s);
  if (suffixUs !== null) {
    return `us${(suffixUs[1] as string).toUpperCase()}`;
  }

  if (/^\d{6}$/.test(s)) {
    if (s.startsWith("6") || s.startsWith("5") || s.startsWith("900")) return `sh${s}`;
    if (s.startsWith("4") || s.startsWith("8") || s.startsWith("92")) return `bj${s}`;
    return `sz${s}`;
  }

  if (/^\d{5}$/.test(s)) return `hk${s}`;

  return undefined;
}

/** Parses `v_hint="..."` returned by `smartbox.gtimg.cn`. */
export function parseSmartbox(body: string): SmartboxHit[] {
  const match = /v_hint\s*=\s*"([^"]*)"/.exec(body);
  if (match === null) return [];
  const decoded = unescapeUnicode(match[1] ?? "");
  if (decoded === "" || decoded === "N") return [];
  const hits: SmartboxHit[] = [];
  for (const entry of decoded.split("^")) {
    const parts = entry.split("~");
    if (parts.length < 5) continue;
    const market = (parts[0] ?? "").trim();
    const rawCode = (parts[1] ?? "").trim();
    const name = (parts[2] ?? "").trim();
    const pinyin = (parts[3] ?? "").trim();
    const kind = (parts[4] ?? "").trim();
    const code = normalizeSmartboxCode(market, rawCode);
    if (code === undefined || name === "") continue;
    hits.push({ market, rawCode, code, name, pinyin, kind });
  }
  return hits;
}

/**
 * Picks the best match from Smartbox results: drops warrants (`QZ`) and HK RMB counters (`hk8xxxx`)
 * when an HKD primary listing (`hk0xxxx`) is available, and ranks equities/ETFs above indices (`ZS`)
 * unless the query specifically asks for an index or matches the index name exactly.
 */
export function pickSmartboxCode(hits: readonly SmartboxHit[], query: string): string | undefined {
  if (hits.length === 0) return undefined;
  const q = query.trim().toLowerCase();
  const wantsIndex = q.includes("指数") || q.includes("index");

  const nonWarrants = hits.filter((h) => h.kind.toUpperCase() !== "QZ");
  const pool0 = nonWarrants.length > 0 ? nonWarrants : [...hits];
  const hasPrimaryHk = pool0.some((h) => /^hk0\d{4}$/.test(h.code));
  const pool = hasPrimaryHk ? pool0.filter((h) => !/^hk8\d{4}$/.test(h.code)) : pool0;

  const scored = pool.map((hit, idx) => {
    const nameLower = hit.name.toLowerCase();
    const codeLower = hit.code.toLowerCase();
    const rawLower = hit.rawCode.replace(/\.(oq|n|am|ps|o|pk)$/i, "").toLowerCase();
    const isExact = nameLower === q || codeLower === q || rawLower === q;
    const isIndex = hit.kind.toUpperCase() === "ZS";
    let score = 0;
    if (isExact) score += 100;
    else if (nameLower.startsWith(q) || rawLower.startsWith(q)) score += 30;
    if (!isIndex) score += wantsIndex ? 5 : 40;
    else if (wantsIndex || isExact) score += 50;
    if (["GP", "GP-A", "GP-B", "ETF", "LOF", "QDII-ETF"].includes(hit.kind.toUpperCase())) {
      score += 10;
    }
    return { hit, score, idx };
  });

  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored[0]?.hit.code;
}

function parseFinite(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeQuoteTime(raw: string | undefined): string {
  const s = (raw ?? "").trim();
  if (/^\d{14}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
  }
  return s.replaceAll("/", "-");
}

/** Parses one `v_<code>="..."` packet payload from `qt.gtimg.cn`. */
export function parseQuotePacket(code: string, payload: string): StockQuote | undefined {
  const fields = payload.split("~");
  if (fields.length < 36) return undefined;
  const flag = (fields[0] ?? "").trim();
  const name = (fields[1] ?? "").trim();
  const symbol = (fields[2] ?? "").trim();
  const price = parseFinite(fields[3]);
  const prevClose = parseFinite(fields[4]);
  const open = parseFinite(fields[5]);
  const change = parseFinite(fields[31]);
  const changePct = parseFinite(fields[32]);
  const high = parseFinite(fields[33]);
  const low = parseFinite(fields[34]);
  if (
    name === "" ||
    price === undefined ||
    prevClose === undefined ||
    open === undefined ||
    change === undefined ||
    changePct === undefined ||
    high === undefined ||
    low === undefined
  ) {
    return undefined;
  }

  const kindTag = (fields[61] ?? "").trim().toUpperCase();
  const isCn = flag === "1" || flag === "51" || flag === "62";
  const isHk = flag === "100" || code.startsWith("hk");
  const currency: StockQuote["currency"] = isHk
    ? "HKD"
    : flag === "200" || code.startsWith("us")
      ? "USD"
      : "CNY";
  const isIndex =
    kindTag === "ZS" ||
    /^(?:sh000|sz399|bj899)/.test(code) ||
    /^hk[A-Z]/.test(code) ||
    code.startsWith("us.");

  const rawTurnover = parseFinite(fields[37]);
  let turnoverYi: number | undefined;
  if (rawTurnover !== undefined && rawTurnover > 0) {
    if (isCn) turnoverYi = rawTurnover / 10_000;
    else if (!isIndex) turnoverYi = rawTurnover / 1e8;
  }

  const rawTurnoverRate = parseFinite(fields[38]);
  const turnoverRate =
    rawTurnoverRate !== undefined && rawTurnoverRate > 0 ? rawTurnoverRate : undefined;
  const rawPe = parseFinite(fields[39]);
  const pe = rawPe !== undefined && rawPe !== 0 ? rawPe : undefined;
  const rawCap = parseFinite(fields[45]);
  const marketCapYi = rawCap !== undefined && rawCap > 0 ? rawCap : undefined;

  return {
    code,
    name,
    symbol,
    currency,
    isIndex,
    price,
    prevClose,
    open,
    high,
    low,
    change,
    changePct,
    ...(turnoverYi === undefined ? {} : { turnoverYi }),
    ...(turnoverRate === undefined ? {} : { turnoverRate }),
    ...(pe === undefined ? {} : { pe }),
    ...(marketCapYi === undefined ? {} : { marketCapYi }),
    time: normalizeQuoteTime(fields[30]),
  };
}

/** Parses one or more `v_<code>="...";` lines returned by `qt.gtimg.cn`. */
export function parseQuotesResponse(body: string): StockQuote[] {
  const quotes: StockQuote[] = [];
  const packetRe = /v_([^=\s]+)\s*=\s*"([^"]*)"\s*;?/g;
  for (const m of body.matchAll(packetRe)) {
    const code = m[1] ?? "";
    const payload = m[2] ?? "";
    if (code === "" || code === "pv_none_match" || payload === "") continue;
    const parsed = parseQuotePacket(code, payload);
    if (parsed !== undefined) quotes.push(parsed);
  }
  return quotes;
}

function formatSigned(n: number): string {
  const s = n.toFixed(2);
  return n > 0 ? `+${s}` : s;
}

function formatYi(n: number): string {
  return `${n >= 1 ? n.toFixed(2) : n.toFixed(4)}亿`;
}

/** Formats parsed live quotes into compact plain text for the Herder and task agents. */
export function formatQuotes(quotes: readonly StockQuote[]): string {
  if (quotes.length === 0) return "No live quotes available.";
  const lines = quotes.map((q) => {
    const unit = q.isIndex ? "" : ` ${q.currency}`;
    const parts = [
      `${q.name} (${q.code}): ${q.price.toFixed(2)}${unit} (${formatSigned(q.change)} / ${formatSigned(q.changePct)}%)`,
      `开 ${q.open.toFixed(2)} 昨收 ${q.prevClose.toFixed(2)} 区间 ${q.low.toFixed(2)}-${q.high.toFixed(2)}`,
    ];
    if (q.turnoverYi !== undefined) {
      parts.push(`成交额 ${formatYi(q.turnoverYi)}${q.isIndex ? "" : ` ${q.currency}`}`);
    }
    if (q.turnoverRate !== undefined) parts.push(`换手 ${q.turnoverRate.toFixed(2)}%`);
    if (q.pe !== undefined) parts.push(`PE ${q.pe.toFixed(2)}`);
    if (q.marketCapYi !== undefined) parts.push(`总市值 ${formatYi(q.marketCapYi)} ${q.currency}`);
    const stamp = q.time === "" ? "" : ` [${q.time}]`;
    return `- ${parts.join(" | ")}${stamp}`;
  });
  return [
    ...lines,
    "Source: 腾讯财经实时行情 (qt.gtimg.cn) · Objective market data for reference only, not investment advice.",
  ].join("\n");
}

function expandMarketAlias(token: string): readonly string[] | undefined {
  const s = token.trim();
  if (SUMMARY_ALL_RE.test(s)) return DEFAULT_MARKET_CODES;
  if (SUMMARY_A_RE.test(s)) return A_SHARE_MARKET_CODES;
  if (SUMMARY_HK_RE.test(s)) return HK_MARKET_CODES;
  if (SUMMARY_US_RE.test(s)) return US_MARKET_CODES;
  const lower = s.toLowerCase();
  const single = SINGLE_ALIASES[lower];
  return single === undefined ? undefined : [single];
}

async function defaultRun(file: string, args: string[]) {
  try {
    const { stdout, stderr } = await runExecFile(file, args, {
      timeout: 8_000,
      windowsHide: true,
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message ?? "" };
  }
}

export class Westock {
  private readonly opts: WestockOptions;
  private view: WestockView;
  private installAbort: AbortController | undefined;
  private installRun: Promise<WestockView> | undefined;

  constructor(opts: WestockOptions) {
    this.opts = opts;
    this.view = {
      enabled: this.isEnabled(),
      cliState: "missing",
      supported: this.releaseForTarget() !== undefined,
    };
  }

  private get fetchFn(): typeof fetch {
    return this.opts.fetch ?? fetch;
  }

  private get runFn(): WestockRun {
    return this.opts.run ?? defaultRun;
  }

  private get platform(): NodeJS.Platform {
    if (this.opts.platform !== undefined) return this.opts.platform;
    if (this.opts.target?.startsWith("win32-")) return "win32";
    if (this.opts.target?.startsWith("darwin-")) return "darwin";
    if (this.opts.target?.startsWith("linux-")) return "linux";
    return process.platform;
  }

  private get target(): string {
    return this.opts.target ?? currentTarget();
  }

  private get exists(): (path: string) => boolean {
    return this.opts.exists ?? existsSync;
  }

  private get env(): NodeJS.ProcessEnv {
    return this.opts.env ?? process.env;
  }

  private isEnabled(): boolean {
    return this.opts.enabled?.() ?? true;
  }

  private managedPath(): string {
    const path = this.platform === "win32" ? westockDataPaths.win32 : westockDataPaths.posix;
    return join(this.opts.home, path.relative);
  }

  private releaseForTarget(): WestockRelease | undefined {
    return WESTOCK_RELEASES[this.target];
  }

  /** Finds `westock` in AgentHerd's managed `bin` directory or on `PATH`. */
  findCli(): { path: string; managed: boolean } | undefined {
    const managed = this.managedPath();
    if (this.exists(managed)) return { path: managed, managed: true };
    const env = this.env;
    const sep = this.platform === "win32" ? win32.delimiter : posix.delimiter;
    const dirs = [searchPath(env, this.platform)].filter((d) => d !== "").join(sep);
    const onSys = onPath(["westock"], dirs, this.exists, this.platform, envValue(env, "PATHEXT"));
    if (onSys !== undefined) return { path: onSys, managed: false };
    return undefined;
  }

  /** Current snapshot without running external checks. */
  current(): WestockView {
    return {
      ...this.view,
      enabled: this.isEnabled(),
      supported: this.releaseForTarget() !== undefined,
    };
  }

  /** True when the `westock` binary is installed and passed its executable check. */
  cliReady(): boolean {
    return this.view.cliState === "ready";
  }

  /** Directory containing the managed `westock` executable when present on disk. */
  binDir(): string | undefined {
    return this.exists(this.managedPath())
      ? join(this.opts.home, hostDataPaths.bin.relative)
      : undefined;
  }

  /** Re-syncs the cached `enabled` bit after `config.json` changed and notifies listeners. */
  syncEnabled(): WestockView {
    this.view = { ...this.current(), enabled: this.isEnabled() };
    this.opts.changed?.();
    return this.current();
  }

  private update(next: Omit<WestockView, "enabled" | "supported">): WestockView {
    this.view = {
      ...next,
      enabled: this.isEnabled(),
      supported: this.releaseForTarget() !== undefined,
    };
    this.opts.changed?.();
    return this.current();
  }

  private async verifyBinary(
    binPath: string,
  ): Promise<{ ok: boolean; version?: string; problem?: string }> {
    const verRes = await this.runFn(binPath, ["--version"]);
    const verMatch = /(\d+\.\d+\.\d+)/.exec(`${verRes.stdout}\n${verRes.stderr}`);
    if (verRes.ok) {
      return { ok: true, ...(verMatch?.[1] === undefined ? {} : { version: verMatch[1] }) };
    }
    const helpRes = await this.runFn(binPath, ["--help"]);
    if (helpRes.ok) {
      return { ok: true, ...(verMatch?.[1] === undefined ? {} : { version: verMatch[1] }) };
    }
    const problem = (verRes.stderr || helpRes.stderr || "westock failed to start")
      .trim()
      .slice(0, 200);
    return { ok: false, problem };
  }

  /** Checks whether `westock` is installed and runnable. */
  async check(): Promise<WestockView> {
    if (this.view.cliState === "installing") return this.current();
    const found = this.findCli();
    if (found === undefined) {
      return this.update({ cliState: "missing" });
    }
    const checked = await this.verifyBinary(found.path);
    if (!checked.ok) {
      return this.update({
        cliState: "failed",
        managed: found.managed,
        path: found.path,
        problem: checked.problem ?? "westock failed to run",
      });
    }
    return this.update({
      cliState: "ready",
      managed: found.managed,
      path: found.path,
      version: checked.version ?? WESTOCK_VERSION,
    });
  }

  /**
   * Installs the pinned official `@tencent-adm/westock-data` CLI (`v0.0.2`) into `<home>/bin`
   * after strict SHA-256 verification. Concurrent calls reuse the active install.
   */
  async install(): Promise<WestockView> {
    if (this.installRun !== undefined) return this.installRun;
    const run = this.performInstall().finally(() => {
      if (this.installRun === run) this.installRun = undefined;
    });
    this.installRun = run;
    return run;
  }

  private async performInstall(): Promise<WestockView> {
    const release = this.releaseForTarget();
    if (release === undefined) {
      return this.update({
        cliState: "failed",
        problem: `当前平台 (${this.target}) 暂未提供官方 westock 预编译包`,
      });
    }
    const controller = new AbortController();
    this.installAbort = controller;
    const timeout = setTimeout(
      () => controller.abort(new Error("download timed out")),
      INSTALL_TIMEOUT_MS,
    );
    timeout.unref?.();
    const dest = this.managedPath();
    const tmp = `${dest}.tmp-${randomUUID()}`;
    this.update({ cliState: "installing" });
    try {
      const url = `${WESTOCK_BASE_URL}/${release.asset}`;
      this.opts.log?.(`[westock] downloading ${url}`);
      const res = await this.fetchFn(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${release.asset}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const digest = createHash("sha256").update(buf).digest("hex");
      if (digest !== release.sha256) {
        throw new Error(`westock SHA-256 mismatch (expected ${release.sha256}, got ${digest})`);
      }
      mkdirSync(join(this.opts.home, hostDataPaths.bin.relative), { recursive: true });
      writeFileSync(tmp, buf);
      if (this.platform !== "win32") chmodSync(tmp, 0o755);
      await renameWithRetry(tmp, dest);
      const verified = await this.verifyBinary(dest);
      if (!verified.ok) {
        throw new Error(verified.problem ?? "installed westock binary failed health check");
      }
      this.opts.log?.(`[westock] ready at ${dest} (${verified.version ?? WESTOCK_VERSION})`);
      return this.update({
        cliState: "ready",
        managed: true,
        path: dest,
        version: verified.version ?? WESTOCK_VERSION,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.opts.log?.(`[westock] install failed: ${msg}`);
      return this.update({ cliState: "failed", problem: msg.slice(0, 200) });
    } finally {
      clearTimeout(timeout);
      if (this.installAbort === controller) this.installAbort = undefined;
      rmSync(tmp, { force: true });
    }
  }

  /** Removes AgentHerd's managed `westock` binary from `<home>/bin` and re-checks state. */
  async remove(): Promise<WestockView> {
    this.stop();
    const managed = this.managedPath();
    if (this.exists(managed)) {
      rmSync(managed, { force: true, maxRetries: 5, retryDelay: 50 });
    }
    return this.check();
  }

  stop(): void {
    this.installAbort?.abort(new Error("stopped"));
  }

  private async lookupSmartbox(query: string): Promise<string | undefined> {
    const url = `https://smartbox.gtimg.cn/s3/?v=2&t=all&c=1&q=${encodeURIComponent(query)}`;
    const res = await this.fetchFn(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Tencent Smartbox HTTP ${res.status}`);
    const body = await res.text();
    const hit = pickSmartboxCode(parseSmartbox(body), query);
    if (hit !== undefined) return hit;
    if (/^[A-Za-z]{1,6}$/.test(query.trim())) return `us${query.trim().toUpperCase()}`;
    return undefined;
  }

  private async resolveCodes(query: string): Promise<string[]> {
    const trimmed = query.trim();
    if (trimmed === "") return [...DEFAULT_MARKET_CODES];

    const whole = expandMarketAlias(trimmed);
    if (whole !== undefined) return [...whole];

    let parts = trimmed
      .split(/[,，、;；\n]+/)
      .map((p) => p.trim())
      .filter((p) => p !== "");

    if (parts.length === 1 && /\s+/.test(parts[0] as string)) {
      const words = (parts[0] as string).split(/\s+/).filter((p) => p !== "");
      if (
        words.every(
          (w) =>
            expandMarketAlias(w) !== undefined ||
            normalizeStockCode(w) !== undefined ||
            /^[A-Za-z]{1,6}$/.test(w),
        )
      ) {
        parts = words;
      }
    }

    const codes: string[] = [];
    const seen = new Set<string>();
    const pushCode = (c: string) => {
      if (!seen.has(c) && codes.length < MAX_CODES_PER_CALL) {
        seen.add(c);
        codes.push(c);
      }
    };

    for (const part of parts) {
      const aliased = expandMarketAlias(part);
      if (aliased !== undefined) {
        for (const c of aliased) pushCode(c);
        continue;
      }
      const direct = normalizeStockCode(part);
      if (direct !== undefined) {
        pushCode(direct);
        continue;
      }
      const resolved = await this.lookupSmartbox(part);
      if (resolved !== undefined) pushCode(resolved);
    }
    return codes;
  }

  /** Fetches structured live quotes for a query string via Tencent Finance. */
  async fetchQuotes(query: string): Promise<StockQuote[]> {
    const codes = await this.resolveCodes(query);
    if (codes.length === 0) return [];
    const url = `https://qt.gtimg.cn/q=${codes.join(",")}`;
    const res = await this.fetchFn(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Tencent Finance HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    const decoded = new TextDecoder("gbk", { fatal: false }).decode(bytes);
    return parseQuotesResponse(decoded);
  }

  /** Queries live stock/index/ETF market quotes and formats them for the Herder or an agent. */
  async quote(query: string): Promise<string> {
    if (!this.isEnabled()) {
      return "腾讯自选股 is turned off in 设置 › 应用连接; ask the owner to enable it.";
    }
    const trimmed = query.trim();
    const quotes = await this.fetchQuotes(trimmed);
    if (quotes.length === 0) {
      return trimmed === ""
        ? "No market quotes returned."
        : `No stock or index matched "${trimmed}".`;
    }
    return formatQuotes(quotes);
  }

  /** Tests live quotes and refreshes CLI status for the 连接测试 button. */
  async test(query = "sh000001,hk00700"): Promise<WestockTest> {
    const westock = await this.check();
    try {
      const quotes = await this.fetchQuotes(query);
      if (quotes.length === 0) {
        return { ok: false, message: "行情接口未返回有效报价", westock };
      }
      const summary = quotes
        .slice(0, 2)
        .map((q) => `${q.name} ${q.price.toFixed(2)} (${formatSigned(q.changePct)}%)`)
        .join(" · ");
      const cliLabel =
        westock.cliState === "ready"
          ? ` · westock v${westock.version ?? WESTOCK_VERSION} 就绪`
          : "";
      return {
        ok: true,
        message: `实时行情正常：${summary}${cliLabel}`,
        sample: formatQuotes(quotes),
        westock,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `行情请求失败：${msg}`, westock };
    }
  }

  /** Context line injected into every new task when 腾讯自选股 is enabled. */
  note(): string | undefined {
    if (!this.isEnabled()) return undefined;
    if (this.view.cliState === "ready") {
      return `Tencent WeStock (腾讯自选股): the read-only \`westock\` CLI is ready (${this.view.path ?? "on PATH"}) for deep investment research (K-line, technical indicators, chips, financial reports, fund flows, announcements, research reports, macro data; run \`westock --help\` to discover subcommands). Live quotes are also available via the \`WESTOCK_QUOTE\` MCP tool. Always state objective market data is for reference only, not investment advice.`;
    }
    return "Tencent WeStock (腾讯自选股): use the read-only `WESTOCK_QUOTE` MCP tool for live A-share, HK, US, ETF and index quotes (no login needed). Always state objective market data is for reference only, not investment advice.";
  }

  /** Read-only MCP tool offered to coding/research tasks alongside Composio & feeds. */
  tools(): AppTools {
    const info: AppToolInfo = {
      title: "Read live stock quotes (腾讯自选股)",
      toolkit: "westock",
      hints: { readOnly: true, create: false, update: false, destructive: false },
    };
    const tool: McpTool = {
      name: "WESTOCK_QUOTE",
      description:
        "Read live stock, index or ETF market quotes (price, change, pct, open, high/low, prevClose, turnover, turnover rate, PE, market cap) from Tencent Finance across A-shares, HK and US markets. Read-only, zero login.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'Market summary ("大盘"/"A股"/"港股"/"美股"/"指数") or comma-separated names/tickers (e.g. "腾讯控股", "600519", "NVDA,AAPL")',
          },
        },
        required: ["query"],
      },
    };
    return {
      list: async () => (this.isEnabled() ? [tool] : []),
      describe: async (slugs) =>
        new Map(
          this.isEnabled() && slugs.includes("WESTOCK_QUOTE") ? [["WESTOCK_QUOTE", info]] : [],
        ),
      call: async (name, args) => {
        if (name !== "WESTOCK_QUOTE") throw new Error(`unknown westock tool ${name}`);
        if (!this.isEnabled()) {
          return {
            content: [{ type: "text", text: "腾讯自选股 is turned off in 设置 › 应用连接." }],
            isError: true,
          };
        }
        const query =
          typeof args === "object" &&
          args !== null &&
          "query" in args &&
          typeof args.query === "string"
            ? args.query
            : "大盘";
        try {
          return { content: [{ type: "text", text: await this.quote(query) }] };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text", text: msg }], isError: true };
        }
      },
    };
  }
}
