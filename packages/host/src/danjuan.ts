// 雪球基金 (Danjuan Funds, danjuanfunds.com) in the host (ADR 0077): interactive login via an
// isolated Chrome/Edge window keeps session cookies strictly local under `<home>/danjuan/profile`,
// reads personal fund sub-accounts and holdings over in-page fetch, and combines them with public
// NAV history to report recent N-day fund gains/losses. Strictly read-only: no subscription,
// redemption or switch endpoints are ever exposed or called.

import { join } from "node:path";
import type { AppToolInfo, AppTools, McpTool } from "@agentherd/core";
import type { DanjuanState, DanjuanTest, DanjuanView } from "./api.ts";
import { type CdpPage, Chrome, findChrome } from "./cdp.ts";
import { hostDataPaths } from "./data-home-paths.ts";

export const DANJUAN_DOMAIN = "danjuanfunds.com";
export const DANJUAN_ASSET_PAGE = `https://${DANJUAN_DOMAIN}/my-money`;
export const DANJUAN_LOGIN_URL = `https://${DANJUAN_DOMAIN}/account/login?redirect=%2Fmy-money`;

const GAIN_PATH = "/djapi/fundx/profit/assets/gain?gains=%5B%22private%22%5D";
const SUMMARY_PATH = "/djapi/fundx/profit/assets/summary?invest_account_id=";
const NAV_HISTORY_URL = `https://${DANJUAN_DOMAIN}/djapi/fund/nav/history`;

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const LOGIN_POLL_MS = 1_200;
const HEADLESS_IDLE_MS = 3 * 60_000;
const NAV_TIMEOUT_MS = 8_000;
const NAV_CONCURRENCY = 6;

const IN_PAGE_FETCH_SCRIPT = `(async () => {
  const f = async (u) => {
    const r = await fetch(u, { credentials: "include" });
    const text = await r.text();
    try { return { status: r.status, body: JSON.parse(text) }; }
    catch { return { status: r.status, body: text }; }
  };
  const gain = await f(${JSON.stringify(GAIN_PATH)});
  const gData = gain.body && typeof gain.body === "object" ? gain.body.data : null;
  const gItems = gData && Array.isArray(gData.items) ? gData.items : [];
  const ids = [];
  for (const sec of gItems) {
    const list = sec && Array.isArray(sec.invest_account_list) ? sec.invest_account_list : [];
    for (const acc of list) {
      const id = acc && acc.invest_account_id !== undefined ? String(acc.invest_account_id) : "";
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  const pairs = await Promise.all(
    ids.map(async (id) => [id, await f(${JSON.stringify(SUMMARY_PATH)} + encodeURIComponent(id))])
  );
  return { gain, summaries: Object.fromEntries(pairs) };
})()`;

export interface DanjuanAccount {
  accountId: string;
  accountName: string;
  accountType: string;
  marketValue?: number;
  dailyGain?: number;
}

export interface DanjuanHolding {
  accountId: string;
  accountName: string;
  fdCode: string;
  fdName: string;
  category?: string;
  marketValue?: number;
  volume?: number;
  usableRemainShare?: number;
  dailyGain?: number;
  holdGain?: number;
  /** Holding gain rate in percent (e.g. `12.5` means `+12.5%`). */
  holdGainRate?: number;
  totalGain?: number;
  nav?: number;
  /** Position weight in percent within its sub-account (e.g. `35.2` means `35.2%`). */
  marketPercent?: number;
}

export type DanjuanRawSnapshot =
  | { signedOut: true; message?: string }
  | {
      signedOut: false;
      accountLabel?: string;
      asOf?: string;
      totalAssetAmount?: number;
      totalAssetDailyGain?: number;
      totalAssetHoldGain?: number;
      totalAssetTotalGain?: number;
      totalFundMarketValue?: number;
      accounts: DanjuanAccount[];
      holdings: DanjuanHolding[];
      detailErrors?: string[];
    };

export interface NavDay {
  date: string;
  nav?: number;
  /** Daily percentage change in percent points (e.g. `0.95` means `+0.95%`). */
  pct: number;
}

export interface FundNavSummary {
  fdCode: string;
  /** Oldest -> newest daily items within the requested trading-day window. */
  days: NavDay[];
  /** Compounded return over `days` in percent points. */
  cumulativePct: number;
}

export interface DanjuanBrowser {
  available(): boolean;
  fetchGainAndSummaries(): Promise<DanjuanRawSnapshot>;
  openLoginWindow(
    onSignedIn: (snapshot: DanjuanRawSnapshot) => void,
    onClosed: (reason?: string) => void,
  ): Promise<void>;
  cancelLogin(): Promise<void>;
  clearSession(): Promise<void>;
  stop(): void;
}

export interface DanjuanSettings {
  enabled?: boolean;
  acceptedAt?: string;
}

export interface DanjuanOptions {
  home: string;
  settings: () => DanjuanSettings;
  save: (patch: DanjuanSettings) => void;
  changed: () => void;
  fetch?: typeof fetch;
  browser?: DanjuanBrowser;
  log?: (line: string) => void;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function strVal(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

/**
 * Normalizes `hold_gain_rate` to percentage points (e.g. `12.5` for `+12.5%`). Upstream sometimes
 * returns a decimal ratio (`0.125`) or percentage points (`12.5`); comparing against cost basis
 * disambiguates the two without guessing.
 */
export function normalizeHoldGainRate(
  rawRate: number | undefined,
  holdGain: number | undefined,
  marketValue: number | undefined,
): number | undefined {
  if (rawRate === undefined) return undefined;
  if (holdGain !== undefined && marketValue !== undefined) {
    const cost = marketValue - holdGain;
    if (cost > 1 && Math.abs(holdGain) > 0.01) {
      const approxPct = (holdGain / cost) * 100;
      const errAsPct = Math.abs(rawRate - approxPct);
      const errAsRatio = Math.abs(rawRate * 100 - approxPct);
      return errAsRatio + 0.05 < errAsPct ? rawRate * 100 : rawRate;
    }
  }
  return rawRate;
}

interface HttpPayload {
  status: number;
  body: unknown;
}

/** Parses in-page `gain` + per-account `summary` JSON answers into a typed snapshot. */
export function parseDanjuanPayload(
  gainRes: HttpPayload,
  summaryMap: Record<string, HttpPayload>,
): DanjuanRawSnapshot {
  const gainBody = obj(gainRes.body);
  const gainCode = num(gainBody.result_code);
  if (gainRes.status === 401 || gainCode === 300001) {
    return { signedOut: true, message: strVal(gainBody.message) || "请重新登录" };
  }
  if (gainRes.status < 200 || gainRes.status >= 300) {
    throw new Error(`danjuan gain HTTP ${gainRes.status}`);
  }
  if (gainCode !== undefined && gainCode !== 0) {
    const msg = strVal(gainBody.message);
    if (msg.includes("登录")) return { signedOut: true, message: msg };
    throw new Error(`danjuan gain error ${gainCode}${msg ? `: ${msg}` : ""}`);
  }

  const root = obj(gainBody.data);
  const rootItems = arr(root.items).map(obj);
  const fundSec = rootItems.find((i) => i.summary_type === "FUND");

  const accounts: DanjuanAccount[] = [];
  const seenAcc = new Set<string>();
  const rawSections = fundSec !== undefined ? [fundSec, ...rootItems] : rootItems;
  for (const sec of rawSections) {
    for (const rawAcc of arr(sec.invest_account_list).map(obj)) {
      const accountId = strVal(rawAcc.invest_account_id);
      if (accountId === "" || seenAcc.has(accountId)) continue;
      seenAcc.add(accountId);
      const marketValue = num(rawAcc.market_value);
      const dailyGain = num(rawAcc.daily_gain);
      accounts.push({
        accountId,
        accountName: strVal(rawAcc.invest_account_name) || "默认账户",
        accountType: strVal(rawAcc.invest_account_type),
        ...(marketValue === undefined ? {} : { marketValue }),
        ...(dailyGain === undefined ? {} : { dailyGain }),
      });
    }
  }

  const holdings: DanjuanHolding[] = [];
  const detailErrors: string[] = [];
  for (const acc of accounts) {
    const res = summaryMap[acc.accountId];
    if (res === undefined) continue;
    const body = obj(res.body);
    const code = num(body.result_code);
    if (res.status === 401 || code === 300001) {
      return { signedOut: true, message: strVal(body.message) || "请重新登录" };
    }
    if (res.status < 200 || res.status >= 300 || (code !== undefined && code !== 0)) {
      detailErrors.push(`${acc.accountName}: HTTP ${res.status}`);
      continue;
    }
    const data = obj(body.data);
    const accName = strVal(data.invest_account_name) || acc.accountName;
    for (const fd of arr(data.items).map(obj)) {
      const fdCode = strVal(fd.fd_code);
      const fdName = strVal(fd.fd_name);
      if (fdCode === "" && fdName === "") continue;
      const marketValue = num(fd.market_value);
      const volume = num(fd.volume);
      const usableRemainShare = num(fd.usable_remain_share);
      const dailyGain = num(fd.daily_gain);
      const holdGain = num(fd.hold_gain);
      const holdGainRate = normalizeHoldGainRate(num(fd.hold_gain_rate), holdGain, marketValue);
      const totalGain = num(fd.total_gain);
      const navValue = num(fd.nav);
      const rawPct = num(fd.market_percent);
      const marketPercent =
        rawPct === undefined ? undefined : rawPct > 0 && rawPct <= 1 ? rawPct * 100 : rawPct;
      const category = strVal(fd.category_text || fd.category);
      holdings.push({
        accountId: acc.accountId,
        accountName: accName,
        fdCode,
        fdName: fdName || fdCode,
        ...(category === "" ? {} : { category }),
        ...(marketValue === undefined ? {} : { marketValue }),
        ...(volume === undefined ? {} : { volume }),
        ...(usableRemainShare === undefined ? {} : { usableRemainShare }),
        ...(dailyGain === undefined ? {} : { dailyGain }),
        ...(holdGain === undefined ? {} : { holdGain }),
        ...(holdGainRate === undefined ? {} : { holdGainRate }),
        ...(totalGain === undefined ? {} : { totalGain }),
        ...(navValue === undefined ? {} : { nav: navValue }),
        ...(marketPercent === undefined ? {} : { marketPercent }),
      });
    }
  }

  const nick = strVal(root.nick_name || root.user_name);
  const accountLabel =
    nick !== ""
      ? nick
      : accounts.length === 1
        ? accounts[0]?.accountName
        : accounts.length > 1
          ? `${accounts.length} 个基金账户`
          : "已连接";
  const asOf = strVal(root.daily_gain_date);
  const totalAssetAmount = num(root.amount);
  const totalAssetDailyGain = num(root.daily_gain);
  const totalAssetHoldGain = num(root.hold_gain);
  const totalAssetTotalGain = num(root.total_gain);
  const totalFundMarketValue = num(fundSec?.amount);

  return {
    signedOut: false,
    ...(accountLabel === undefined ? {} : { accountLabel }),
    ...(asOf === "" ? {} : { asOf }),
    ...(totalAssetAmount === undefined ? {} : { totalAssetAmount }),
    ...(totalAssetDailyGain === undefined ? {} : { totalAssetDailyGain }),
    ...(totalAssetHoldGain === undefined ? {} : { totalAssetHoldGain }),
    ...(totalAssetTotalGain === undefined ? {} : { totalAssetTotalGain }),
    ...(totalFundMarketValue === undefined ? {} : { totalFundMarketValue }),
    accounts,
    holdings,
    ...(detailErrors.length === 0 ? {} : { detailErrors }),
  };
}

class ChromeDanjuan implements DanjuanBrowser {
  private readonly profileDir: string;
  private readonly log: ((line: string) => void) | undefined;
  private headless: Chrome | undefined;
  private headlessPage: CdpPage | undefined;
  private loginWin: Chrome | undefined;
  private loginTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private closingLogin = false;

  constructor(home: string, log?: (line: string) => void) {
    this.profileDir = join(home, hostDataPaths.danjuanProfile.relative);
    this.log = log;
  }

  available(): boolean {
    return findChrome() !== undefined;
  }

  private bumpIdle(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.closeHeadless();
    }, HEADLESS_IDLE_MS);
    this.idleTimer.unref?.();
  }

  private async closeHeadless(): Promise<void> {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.headlessPage = undefined;
    const chrome = this.headless;
    this.headless = undefined;
    if (chrome !== undefined) await chrome.closeGracefully();
  }

  private async closeLoginWindow(): Promise<void> {
    if (this.loginTimer !== undefined) {
      clearTimeout(this.loginTimer);
      this.loginTimer = undefined;
    }
    const win = this.loginWin;
    this.loginWin = undefined;
    if (win !== undefined) {
      this.closingLogin = true;
      try {
        await win.closeGracefully();
      } finally {
        this.closingLogin = false;
      }
    }
  }

  private async runFetchInPage(page: CdpPage): Promise<DanjuanRawSnapshot> {
    const raw = await page.evaluate<{
      gain: HttpPayload;
      summaries: Record<string, HttpPayload>;
    }>(IN_PAGE_FETCH_SCRIPT);
    return parseDanjuanPayload(raw.gain, raw.summaries);
  }

  async fetchGainAndSummaries(): Promise<DanjuanRawSnapshot> {
    if (this.loginWin?.running()) {
      return { signedOut: true, message: "正在等待网页登录" };
    }
    if (this.headless === undefined || !this.headless.running()) {
      const chrome = new Chrome(this.profileDir, (code) => {
        this.log?.(`[danjuan] headless Chrome exited (${code ?? "signal"})`);
        if (this.headless === chrome) {
          this.headless = undefined;
          this.headlessPage = undefined;
        }
      });
      await chrome.start({ headless: true });
      this.headless = chrome;
    }
    try {
      if (this.headlessPage === undefined) {
        const page = await this.headless.open();
        await page.go(DANJUAN_ASSET_PAGE, 1_200);
        this.headlessPage = page;
      }
      const res = await this.runFetchInPage(this.headlessPage);
      this.bumpIdle();
      return res;
    } catch (error) {
      this.log?.(`[danjuan] retry page fetch: ${(error as Error).message}`);
      await this.closeHeadless();
      const chrome = new Chrome(this.profileDir, () => {
        if (this.headless === chrome) {
          this.headless = undefined;
          this.headlessPage = undefined;
        }
      });
      await chrome.start({ headless: true });
      this.headless = chrome;
      const page = await chrome.open();
      await page.go(DANJUAN_ASSET_PAGE, 1_200);
      this.headlessPage = page;
      const res = await this.runFetchInPage(page);
      this.bumpIdle();
      return res;
    }
  }

  async openLoginWindow(
    onSignedIn: (snapshot: DanjuanRawSnapshot) => void,
    onClosed: (reason?: string) => void,
  ): Promise<void> {
    await this.closeLoginWindow();
    await this.closeHeadless();
    const win = new Chrome(this.profileDir, (code) => {
      if (this.loginWin === win) this.loginWin = undefined;
      if (this.loginTimer !== undefined) {
        clearTimeout(this.loginTimer);
        this.loginTimer = undefined;
      }
      if (!this.closingLogin) {
        onClosed(code === 0 ? undefined : `登录窗口关闭（${code ?? "signal"}）`);
      }
    });
    this.loginWin = win;
    await win.start({ headless: false, url: DANJUAN_LOGIN_URL, windowSize: "520,760" });
    const page = await win.firstPage();
    const until = Date.now() + LOGIN_TIMEOUT_MS;
    let polling = false;

    const tick = async () => {
      this.loginTimer = undefined;
      if (this.loginWin !== win || !win.running()) return;
      if (Date.now() >= until) {
        await this.closeLoginWindow();
        onClosed("登录超时，请重试");
        return;
      }
      if (!polling) {
        polling = true;
        try {
          const loc = await page.evaluate<{ host: string; path: string }>(
            "({ host: location.hostname, path: location.pathname })",
          );
          if (loc.host.endsWith(DANJUAN_DOMAIN) && !loc.path.startsWith("/account/login")) {
            await new Promise((r) => setTimeout(r, 600));
            const snap = await this.runFetchInPage(page);
            if (!snap.signedOut) {
              await this.closeLoginWindow();
              onSignedIn(snap);
              return;
            }
          }
        } catch {
          // page navigating
        } finally {
          polling = false;
        }
      }
      if (this.loginWin === win && win.running()) {
        this.loginTimer = setTimeout(() => void tick(), LOGIN_POLL_MS);
      }
    };
    this.loginTimer = setTimeout(() => void tick(), LOGIN_POLL_MS);
  }

  async cancelLogin(): Promise<void> {
    await this.closeLoginWindow();
  }

  async clearSession(): Promise<void> {
    await this.closeLoginWindow();
    await this.closeHeadless();
    if (!this.available()) return;
    const chrome = new Chrome(this.profileDir, () => {});
    try {
      await chrome.start({ headless: true });
      const page = await chrome.open();
      await page.go(DANJUAN_ASSET_PAGE, 500);
      await page.send("Network.clearBrowserCookies");
      await page.evaluate("(() => { localStorage.clear(); sessionStorage.clear(); })()");
    } finally {
      await chrome.closeGracefully();
    }
  }

  stop(): void {
    if (this.loginTimer !== undefined) {
      clearTimeout(this.loginTimer);
      this.loginTimer = undefined;
    }
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.closingLogin = true;
    this.loginWin?.stop();
    this.loginWin = undefined;
    this.closingLogin = false;
    this.headlessPage = undefined;
    this.headless?.stop();
    this.headless = undefined;
  }
}

/** Fetches recent `days` trading-day NAV percentage changes for a single fund code. */
export async function fetchFundNavHistory(
  fdCode: string,
  days: number,
  fetchFn: typeof fetch = fetch,
): Promise<FundNavSummary | undefined> {
  const clean = fdCode.trim();
  if (clean === "") return undefined;
  const count = Math.max(1, Math.min(30, Math.floor(days)));
  const url = `${NAV_HISTORY_URL}/${encodeURIComponent(clean)}?page=1&size=${count + 1}`;
  const res = await fetchFn(url, { signal: AbortSignal.timeout(NAV_TIMEOUT_MS) });
  if (!res.ok) return undefined;
  const json = obj(await res.json());
  const data = obj(json.data);
  const rawItems = arr(data.items).map(obj).slice(0, count);
  const parsed: NavDay[] = [];
  for (const item of rawItems) {
    const date = strVal(item.date);
    const pct = num(item.percentage);
    const navVal = num(item.nav);
    if (date === "" || pct === undefined) continue;
    parsed.push({ date, pct, ...(navVal === undefined ? {} : { nav: navVal }) });
  }
  if (parsed.length === 0) return undefined;
  const chronological = parsed.reverse();
  const factor = chronological.reduce((acc, d) => acc * (1 + d.pct / 100), 1);
  return {
    fdCode: clean,
    days: chronological,
    cumulativePct: (factor - 1) * 100,
  };
}

function fmtMoney(n: number | undefined): string {
  if (n === undefined) return "--";
  return `${n.toFixed(2)}元`;
}

function fmtSignedMoney(n: number | undefined): string {
  if (n === undefined) return "--";
  const s = n.toFixed(2);
  return `${n > 0 ? `+${s}` : s}元`;
}

function fmtSignedPct(n: number | undefined): string {
  if (n === undefined) return "--";
  const s = n.toFixed(2);
  return `${n > 0 ? `+${s}` : s}%`;
}

/** Formats personal Danjuan holdings plus recent N-day NAV gains/losses into readable plain text. */
export function formatDanjuanReport(
  snapshot: Extract<DanjuanRawSnapshot, { signedOut: false }>,
  navMap: ReadonlyMap<string, FundNavSummary>,
  days: number,
  accountFilter?: string,
): string {
  const filter = accountFilter?.trim() ?? "";
  const matched =
    filter === ""
      ? snapshot.holdings
      : snapshot.holdings.filter((h) => h.accountId === filter || h.accountName.includes(filter));

  const lines: string[] = [];
  const headParts = [`总资产 ${fmtMoney(snapshot.totalAssetAmount)}`];
  if (snapshot.totalAssetDailyGain !== undefined) {
    const dateTag = snapshot.asOf ? ` (${snapshot.asOf})` : "";
    headParts.push(`最新日收益${dateTag} ${fmtSignedMoney(snapshot.totalAssetDailyGain)}`);
  }
  if (snapshot.totalAssetHoldGain !== undefined) {
    headParts.push(`持有收益 ${fmtSignedMoney(snapshot.totalAssetHoldGain)}`);
  }
  if (snapshot.totalAssetTotalGain !== undefined) {
    headParts.push(`累计收益 ${fmtSignedMoney(snapshot.totalAssetTotalGain)}`);
  }
  lines.push(`雪球基金账户概览：${headParts.join(" · ")}`);

  if (matched.length === 0) {
    lines.push(
      filter === "" ? "当前账户暂无基金持仓记录。" : `未找到匹配账户「${filter}」的基金持仓记录。`,
    );
    return lines.join("\n");
  }

  // Reconstruct portfolio daily estimated P&L backwards from each holding's current marketValue.
  const dateTotals = new Map<string, { gain: number; baseValue: number }>();
  let totalPeriodGain = 0;
  let totalPeriodBase = 0;
  let hasPeriodGain = false;

  const sorted = [...matched].sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0));
  const multiAccount = new Set(matched.map((h) => h.accountName)).size > 1;
  const totalShownValue = sorted.reduce((sum, h) => sum + (h.marketValue ?? 0), 0);

  const itemLines: string[] = [];
  for (const h of sorted) {
    const nav = navMap.get(h.fdCode);
    const val = h.marketValue;
    let periodGainStr = "";
    if (nav !== undefined && nav.days.length > 0 && val !== undefined && val > 0) {
      let runningVal = val;
      for (let i = nav.days.length - 1; i >= 0; i--) {
        const d = nav.days[i];
        if (d === undefined) continue;
        const factor = 1 + d.pct / 100;
        const prevVal = factor > 0 ? runningVal / factor : runningVal;
        const dayGain = runningVal - prevVal;
        const bucket = dateTotals.get(d.date) ?? { gain: 0, baseValue: 0 };
        bucket.gain += dayGain;
        bucket.baseValue += prevVal;
        dateTotals.set(d.date, bucket);
        runningVal = prevVal;
      }
      const periodGain = val - runningVal;
      totalPeriodGain += periodGain;
      totalPeriodBase += runningVal;
      hasPeriodGain = true;
      periodGainStr = ` | 近${nav.days.length}日 ${fmtSignedPct(nav.cumulativePct)} (估算 ${fmtSignedMoney(periodGain)})`;
    } else if (nav !== undefined && nav.days.length > 0) {
      periodGainStr = ` | 近${nav.days.length}日 ${fmtSignedPct(nav.cumulativePct)}`;
    }

    const weight =
      h.marketPercent !== undefined
        ? h.marketPercent
        : totalShownValue > 0 && val !== undefined
          ? (val / totalShownValue) * 100
          : undefined;
    const accTag = multiAccount ? `[${h.accountName}] ` : "";
    const parts = [
      `${accTag}${h.fdName} (${h.fdCode})`,
      `市值 ${fmtMoney(val)}${weight === undefined ? "" : ` (占比 ${weight.toFixed(1)}%)`}`,
    ];
    if (h.dailyGain !== undefined) parts.push(`日收益 ${fmtSignedMoney(h.dailyGain)}`);
    if (h.holdGain !== undefined || h.holdGainRate !== undefined) {
      parts.push(
        `持有 ${fmtSignedMoney(h.holdGain)}${h.holdGainRate === undefined ? "" : ` (${fmtSignedPct(h.holdGainRate)})`}`,
      );
    }
    const recentSeries =
      nav === undefined || nav.days.length === 0
        ? ""
        : `\n  每日净值涨跌: ${nav.days.map((d) => `${d.date.slice(5)} ${fmtSignedPct(d.pct)}`).join(" · ")}`;
    itemLines.push(`- ${parts.join(" | ")}${periodGainStr}${recentSeries}`);
  }

  if (hasPeriodGain && totalPeriodBase > 0) {
    const periodPct = (totalPeriodGain / totalPeriodBase) * 100;
    lines.push(
      `近 ${days} 个交易日估算汇总：${fmtSignedPct(periodPct)} (${fmtSignedMoney(totalPeriodGain)}，按当前持仓静态回算)`,
    );
  }

  if (dateTotals.size > 0) {
    const dates = [...dateTotals.keys()].sort().slice(-days);
    lines.push("近期每日组合涨跌（按当前持仓权重估算）：");
    for (const date of dates) {
      const bucket = dateTotals.get(date);
      if (bucket === undefined || bucket.baseValue <= 0) continue;
      const pct = (bucket.gain / bucket.baseValue) * 100;
      lines.push(`  • ${date}: ${fmtSignedPct(pct)} (${fmtSignedMoney(bucket.gain)})`);
    }
  }

  lines.push("持仓明细（按市值降序）：");
  lines.push(...itemLines);
  lines.push(
    "Source: 雪球基金 (danjuanfunds.com) 本机登录态 · 近几日区间涨跌按当前持仓市值回算（未计期间申赎），仅供参考，不构成投资建议。",
  );
  return lines.join("\n");
}

export class Danjuan {
  private readonly opts: DanjuanOptions;
  private readonly browser: DanjuanBrowser;
  private state: DanjuanState;
  private account: string | undefined;
  private problem: string | undefined;
  private checkedAt: string | undefined;
  private cached: Extract<DanjuanRawSnapshot, { signedOut: false }> | undefined;
  private checking: Promise<DanjuanView> | undefined;

  constructor(opts: DanjuanOptions) {
    this.opts = opts;
    this.browser = opts.browser ?? new ChromeDanjuan(opts.home, opts.log);
    const saved = opts.settings();
    this.state = saved.enabled === true ? "signed-out" : "off";
  }

  private get fetchFn(): typeof fetch {
    return this.opts.fetch ?? fetch;
  }

  available(): boolean {
    return this.browser.available();
  }

  enabled(): boolean {
    return this.opts.settings().enabled === true;
  }

  ready(): boolean {
    return this.enabled() && this.state === "ready";
  }

  current(): DanjuanView {
    const saved = this.opts.settings();
    const isOn = saved.enabled === true;
    const state: DanjuanState = !isOn && this.state !== "signing-in" ? "off" : this.state;
    return {
      available: this.available(),
      accepted: saved.acceptedAt !== undefined,
      enabled: isOn,
      state,
      ...(this.account === undefined ? {} : { account: this.account }),
      ...(this.problem === undefined ? {} : { problem: this.problem }),
      ...(this.checkedAt === undefined ? {} : { checkedAt: this.checkedAt }),
    };
  }

  private emitState(state: DanjuanState, problem?: string): DanjuanView {
    this.state = state;
    this.problem = problem;
    this.opts.changed();
    return this.current();
  }

  /** Checks saved session state (launches Chrome only when enabled in config). */
  async check(): Promise<DanjuanView> {
    if (this.state === "signing-in") return this.current();
    if (!this.enabled()) {
      this.account = undefined;
      this.cached = undefined;
      return this.emitState("off");
    }
    if (!this.available()) {
      return this.emitState("failed", "需要先安装 Google Chrome 或 Microsoft Edge");
    }
    this.checking ??= this.runCheck().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async runCheck(): Promise<DanjuanView> {
    this.checkedAt = new Date().toISOString();
    try {
      const snap = await this.browser.fetchGainAndSummaries();
      if (snap.signedOut) {
        this.account = undefined;
        this.cached = undefined;
        return this.emitState("signed-out");
      }
      this.cached = snap;
      this.account = snap.accountLabel;
      return this.emitState("ready");
    } catch (error) {
      return this.emitState("failed", (error as Error).message.slice(0, 200));
    }
  }

  /** Starts interactive Chrome window login after verifying risk acceptance. */
  async connect(accepted: boolean): Promise<DanjuanView> {
    const saved = this.opts.settings();
    const acceptedAt = saved.acceptedAt ?? (accepted ? new Date().toISOString() : undefined);
    if (acceptedAt === undefined) {
      throw new Error("连接雪球基金前需先确认只读风险提示");
    }
    if (!this.available()) {
      throw new Error("需要先安装 Google Chrome 或 Microsoft Edge");
    }
    if (this.state === "signing-in") return this.current();
    const wasEnabled = saved.enabled === true;
    this.opts.save({ enabled: true, acceptedAt });
    this.emitState("signing-in");
    try {
      await this.browser.openLoginWindow(
        (snap) => {
          this.checkedAt = new Date().toISOString();
          if (!snap.signedOut) {
            this.cached = snap;
            this.account = snap.accountLabel;
            this.emitState("ready");
          } else {
            this.emitState("signed-out");
          }
        },
        (reason) => {
          if (this.state === "signing-in") {
            if (!wasEnabled && this.cached === undefined) {
              this.opts.save({ enabled: false, acceptedAt });
              this.emitState("off", reason);
            } else {
              this.emitState(reason === undefined ? "signed-out" : "failed", reason);
            }
          }
        },
      );
    } catch (error) {
      this.emitState("failed", (error as Error).message.slice(0, 200));
    }
    return this.current();
  }

  async cancelLogin(): Promise<DanjuanView> {
    await this.browser.cancelLogin();
    if (this.state === "signing-in") {
      if (this.cached === undefined) {
        this.opts.save({ enabled: false });
        return this.emitState("off");
      }
      return this.emitState("ready");
    }
    return this.current();
  }

  async logout(): Promise<DanjuanView> {
    await this.browser.clearSession();
    this.opts.save({ enabled: false });
    this.account = undefined;
    this.cached = undefined;
    this.checkedAt = new Date().toISOString();
    return this.emitState("off");
  }

  private async fetchNavMap(
    codes: readonly string[],
    days: number,
  ): Promise<Map<string, FundNavSummary>> {
    const unique = [...new Set(codes.map((c) => c.trim()).filter((c) => c !== ""))];
    const map = new Map<string, FundNavSummary>();
    for (let i = 0; i < unique.length; i += NAV_CONCURRENCY) {
      const batch = unique.slice(i, i + NAV_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((code) => fetchFundNavHistory(code, days, this.fetchFn)),
      );
      for (const r of results) {
        if (r.status === "fulfilled" && r.value !== undefined) {
          map.set(r.value.fdCode, r.value);
        }
      }
    }
    return map;
  }

  /** Reads personal holdings plus recent `days` trading-day NAV gains/losses. */
  async holdings(query?: { days?: number; account?: string }): Promise<string> {
    if (!this.enabled()) {
      return "雪球基金尚未连接，请先在「设置 › 应用连接 › 行情与投研 › 雪球基金」中登录后再试。";
    }
    if (!this.available()) {
      return "本机未找到 Google Chrome 或 Microsoft Edge，无法读取雪球基金登录态。";
    }
    const days =
      typeof query?.days === "number" && Number.isFinite(query.days)
        ? Math.max(1, Math.min(30, Math.floor(query.days)))
        : 5;
    const snap = await this.browser.fetchGainAndSummaries();
    this.checkedAt = new Date().toISOString();
    if (snap.signedOut) {
      this.account = undefined;
      this.cached = undefined;
      this.emitState("signed-out");
      return "雪球基金登录已失效，请在「设置 › 应用连接 › 行情与投研 › 雪球基金」中点击「重连」完成短信登录。";
    }
    this.cached = snap;
    this.account = snap.accountLabel;
    this.emitState("ready");

    const filter = query?.account?.trim() ?? "";
    const relevantCodes = snap.holdings
      .filter((h) => filter === "" || h.accountId === filter || h.accountName.includes(filter))
      .map((h) => h.fdCode);
    const navMap = await this.fetchNavMap(relevantCodes, days);
    return formatDanjuanReport(snap, navMap, days, query?.account);
  }

  async test(): Promise<DanjuanTest> {
    if (!this.enabled()) {
      return { ok: false, message: "还没连接雪球基金", danjuan: this.current() };
    }
    const checked = await this.check();
    if (checked.state !== "ready" || this.cached === undefined) {
      return {
        ok: false,
        message:
          checked.state === "signed-out"
            ? "登录已失效，请点击「重连」重新扫码或短信登录"
            : (checked.problem ?? "连接失败"),
        danjuan: checked,
      };
    }
    const navMap = await this.fetchNavMap(
      this.cached.holdings.slice(0, 10).map((h) => h.fdCode),
      5,
    );
    const sample = formatDanjuanReport(this.cached, navMap, 5);
    const summary = `连接正常：共 ${this.cached.holdings.length} 只持仓基金，总资产 ${fmtMoney(this.cached.totalAssetAmount)}`;
    return { ok: true, message: summary, sample, danjuan: checked };
  }

  /** Context line injected into new coding/research tasks when 雪球基金 is ready. */
  note(): string | undefined {
    if (!this.ready()) return undefined;
    return "雪球基金 (Danjuan Funds): use the read-only `DANJUAN_HOLDINGS` MCP tool to read the owner's personal fund portfolio and recent N-day NAV gains/losses (`days`, `account`). Read-only; never invent holdings or returns.";
  }

  /** Read-only MCP tool exposed to tasks while 雪球基金 is signed in. */
  tools(): AppTools {
    const info: AppToolInfo = {
      title: "Read personal fund holdings (雪球基金)",
      toolkit: "danjuan",
      hints: { readOnly: true, create: false, update: false, destructive: false },
    };
    const tool: McpTool = {
      name: "DANJUAN_HOLDINGS",
      description:
        "Read the owner's personal 雪球基金 (danjuanfunds.com) fund holdings, daily gain, holding gain/rate, and recent N trading days' NAV percentage changes and estimated P&L. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          days: {
            type: "number",
            description: "Recent trading days to summarize (1-30, default 5)",
          },
          account: {
            type: "string",
            description: "Optional sub-account name or ID filter",
          },
        },
        required: [],
      },
    };
    return {
      list: async () => (this.ready() ? [tool] : []),
      describe: async (slugs) =>
        new Map(
          this.ready() && slugs.includes("DANJUAN_HOLDINGS") ? [["DANJUAN_HOLDINGS", info]] : [],
        ),
      call: async (name, args) => {
        if (name !== "DANJUAN_HOLDINGS") throw new Error(`unknown danjuan tool ${name}`);
        const objArgs = obj(args);
        const days = num(objArgs.days);
        const account = strVal(objArgs.account);
        try {
          const text = await this.holdings({
            ...(days === undefined ? {} : { days }),
            ...(account === "" ? {} : { account }),
          });
          return { content: [{ type: "text", text }] };
        } catch (error) {
          return {
            content: [{ type: "text", text: (error as Error).message }],
            isError: true,
          };
        }
      },
    };
  }

  stop(): void {
    this.browser.stop();
  }
}
