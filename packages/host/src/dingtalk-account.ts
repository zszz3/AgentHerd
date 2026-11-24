import type { DingTalkView } from "./api.ts";
import {
  DingTalkCliError,
  type DingTalkCliPort,
  type DingTalkCommand,
  type DingTalkIdentity,
} from "./dingtalk-cli.ts";

export type BoundDingTalkRun = (
  command: DingTalkCommand,
  beforeDispatch?: () => void,
) => Promise<unknown>;

export const DINGTALK_DISCONNECTED: DingTalkView = { state: "disconnected", capabilities: [] };
const CONNECTING: DingTalkView = { state: "connecting", capabilities: [] };
const CHANGED = "钉钉账号连接已变更，请重新连接后再发起任务。";
const STATUS_UNAVAILABLE = "暂时无法验证钉钉账号状态，本次未执行。";
const STATUS_INTERVAL_MS = 30_000;

/** One user/organization. A prepared command cannot move between generations. */
export class DingTalkAccount {
  private current = DINGTALK_DISCONNECTED;
  private identity: DingTalkIdentity | undefined;
  private generation = new AbortController();
  private initialized = false;
  private stopped = false;
  private restoreRun: Promise<void> | undefined;
  private refreshRun: Promise<void> | undefined;
  private checkedAt = 0;
  private loginRun: Promise<void> | undefined;
  private resetRun: Promise<void> | undefined;
  private readonly active = new Set<Promise<unknown>>();
  private readonly cli: DingTalkCliPort;

  constructor(cli: DingTalkCliPort) {
    this.cli = cli;
  }

  private connected(identity: DingTalkIdentity) {
    this.checkedAt = Date.now();
    this.identity = Object.freeze({ ...identity });
    const { corpName, userName } = identity;
    this.current = {
      state: "connected",
      capabilities: [],
      ...(corpName === undefined ? {} : { corpName }),
      ...(userName === undefined ? {} : { userName }),
    };
  }

  private fail(error: string) {
    this.identity = undefined;
    this.generation.abort();
    this.current = { state: "failed", capabilities: [], error };
  }

  private async restore() {
    if (this.stopped || this.initialized) return;
    const { signal } = this.generation;
    this.restoreRun ??= (async () => {
      try {
        const identity = await this.cli.status(signal);
        if (!signal.aborted && identity !== undefined) this.connected(identity);
      } catch {
        if (!signal.aborted) this.fail("无法验证本地钉钉授权，请先清除连接。");
      } finally {
        this.initialized = true;
      }
    })();
    await this.restoreRun;
  }

  private async verify(identity: DingTalkIdentity, signal: AbortSignal): Promise<void> {
    const actual = await this.cli.status(signal).catch(() => {
      throw new Error(signal.aborted ? CHANGED : STATUS_UNAVAILABLE);
    });
    if (signal.aborted) throw new Error(CHANGED);
    if (actual?.corpId !== identity.corpId || actual?.userId !== identity.userId) {
      this.fail(CHANGED);
      throw new Error(CHANGED);
    }
    this.connected(actual);
  }

  async view(): Promise<DingTalkView> {
    await this.restore();
    if (this.refreshRun !== undefined) await this.refreshRun;
    else if (this.identity !== undefined && Date.now() - this.checkedAt >= STATUS_INTERVAL_MS) {
      this.checkedAt = Date.now();
      this.refreshRun = this.verify(this.identity, this.generation.signal)
        .catch(() => {})
        .finally(() => {
          this.refreshRun = undefined;
        });
      await this.refreshRun;
    }
    return this.current;
  }

  async startLogin(): Promise<DingTalkView> {
    const generation = this.generation;
    await this.restore();
    if (
      this.stopped ||
      this.resetRun !== undefined ||
      this.current.state !== "disconnected" ||
      generation !== this.generation ||
      generation.signal.aborted
    )
      return this.current;
    this.current = CONNECTING;
    const { signal } = generation;
    this.loginRun = (async () => {
      try {
        await this.cli.login(signal);
        if (signal.aborted) return;
        const identity = await this.cli.status(signal);
        if (signal.aborted) return;
        if (identity === undefined) this.fail("未收到钉钉授权，请清除连接后重试。");
        else this.connected(identity);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof DingTalkCliError && error.code === "login_storage_denied") {
          // DWS failed before opening the browser or writing authorization. No reset is needed.
          generation.abort();
          this.generation = new AbortController();
          this.loginRun = undefined;
          this.current = { ...DINGTALK_DISCONNECTED, error: error.message };
          return;
        }
        this.fail("钉钉授权未完成，请清除连接后重试。");
      }
    })();
    return this.current;
  }

  async cancelLogin(): Promise<DingTalkView> {
    // The browser may have completed while the Cancel request was in flight.
    if (this.loginRun !== undefined) return this.disconnect();
    return this.current;
  }

  private drain(): Promise<unknown> {
    return Promise.allSettled([this.restoreRun, this.refreshRun, this.loginRun, ...this.active]);
  }

  async disconnect(): Promise<DingTalkView> {
    if (this.stopped) return this.current;
    if (this.resetRun !== undefined) {
      await this.resetRun;
      return this.current;
    }
    this.generation.abort();
    this.generation = new AbortController();
    this.identity = undefined;
    this.initialized = true;
    this.current = DINGTALK_DISCONNECTED;
    this.resetRun = (async () => {
      try {
        await this.cli.markResetPending();
        await this.drain();
        // Shutdown invalidates business operations, not an owner's pending local reset.
        await this.cli.reset(new AbortController().signal);
      } catch {
        if (!this.stopped) this.fail("无法清除本地钉钉授权，请重试断开。");
      }
    })();
    try {
      await this.resetRun;
    } finally {
      this.resetRun = undefined;
      this.loginRun = undefined;
    }
    return this.current;
  }

  async bind(): Promise<BoundDingTalkRun> {
    await this.restore();
    const identity = this.identity;
    const { signal } = this.generation;
    if (identity === undefined || signal.aborted) throw new Error(CHANGED);
    const check = () => {
      if (signal.aborted) throw new Error(CHANGED);
    };
    return async (command, beforeDispatch) => {
      check();
      const run = (async () => {
        await this.verify(identity, signal);
        check();
        const result = await this.cli.run(identity, command, signal, beforeDispatch);
        check();
        return result;
      })();
      this.active.add(run);
      try {
        return await run;
      } finally {
        this.active.delete(run);
      }
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation.abort();
    this.identity = undefined;
    this.current = DINGTALK_DISCONNECTED;
    await Promise.allSettled([this.drain(), this.resetRun]);
  }
}
