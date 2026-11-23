import type { AppTools } from "@agentherd/core";
import type { WecomView } from "./api.ts";
import { WecomDisconnectPendingError } from "./wecom-cli.ts";
import { discoverWecomCliTools } from "./wecom-cli-tools.ts";

export interface WecomCliPort {
  run(args: readonly string[], signal?: AbortSignal): Promise<unknown>;
  status(signal?: AbortSignal): Promise<boolean>;
  login(onQr: (dataUrl: string) => void, signal: AbortSignal): Promise<void>;
  logout(): Promise<void>;
}

interface Catalog extends AppTools {
  capabilities: WecomView["capabilities"];
}

type Discover = (run: WecomCliPort["run"], signal?: AbortSignal) => Promise<Catalog>;

const UNAVAILABLE = "企业微信连接已变更，请重新发起任务。";
const DISCONNECTED: WecomView = { state: "disconnected", capabilities: [] };
const CONNECTING: WecomView = { state: "connecting", capabilities: [] };

/** One owner account, with catalog and tool approvals bound to its login generation. */
export class WecomAccount {
  private current: WecomView = DISCONNECTED;
  private catalog: Catalog | undefined;
  private generation = new AbortController();
  private initialized = false;
  private closed = false;
  private restoring: Promise<void> | undefined;
  private loginRun: Promise<void> | undefined;
  private disconnecting: Promise<void> | undefined;
  private mustDisconnect = false;

  private readonly cli: WecomCliPort;
  private readonly discover: Discover;

  constructor(cli: WecomCliPort, discover: Discover = discoverWecomCliTools) {
    this.cli = cli;
    this.discover = discover;
  }

  private async load(signal: AbortSignal): Promise<void> {
    const operation = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const catalog = await this.discover((args, childSignal) => {
      const runSignal = childSignal === undefined ? signal : AbortSignal.any([signal, childSignal]);
      runSignal.throwIfAborted();
      return this.cli.run(args, runSignal);
    }, operation);
    operation.throwIfAborted();
    this.catalog = catalog;
    this.current = { state: "connected", capabilities: catalog.capabilities };
  }

  private fail(signal: AbortSignal, error: unknown): void {
    if (!signal.aborted) {
      this.mustDisconnect = error instanceof WecomDisconnectPendingError;
      this.catalog = undefined;
      this.current = {
        state: "failed",
        capabilities: [],
        error: this.mustDisconnect
          ? "无法清除本地企业微信登录，请重试断开。"
          : "无法连接企业微信，请检查网络后重试。",
      };
    }
  }

  async restore(): Promise<void> {
    if (this.closed || this.initialized || this.disconnecting !== undefined) return;
    if (this.restoring !== undefined) return this.restoring;
    const { signal } = this.generation;
    this.restoring = (async () => {
      try {
        if (await this.cli.status(signal)) await this.load(signal);
      } catch (error) {
        this.fail(signal, error);
      } finally {
        if (!signal.aborted) this.initialized = true;
      }
    })();
    try {
      await this.restoring;
    } finally {
      this.restoring = undefined;
    }
  }

  connectedNames(): string[] {
    return this.catalog?.capabilities.some(({ toolCount }) => toolCount > 0) ? ["企业微信"] : [];
  }

  async view(): Promise<WecomView> {
    await this.restore();
    return this.current;
  }

  async startLogin(): Promise<WecomView> {
    await this.restore();
    if (this.closed || this.current.state === "connected" || this.loginRun !== undefined)
      return this.current;
    if (this.disconnecting !== undefined || this.mustDisconnect) return this.current;
    this.current = CONNECTING;
    const { signal } = this.generation;
    this.loginRun = (async () => {
      try {
        if (!(await this.cli.status(signal))) {
          signal.throwIfAborted();
          await this.cli.login((qr) => {
            if (!signal.aborted) this.current = { ...CONNECTING, qr };
          }, signal);
        }
        signal.throwIfAborted();
        this.current = CONNECTING;
        await this.load(signal);
      } catch (error) {
        this.fail(signal, error);
      } finally {
        this.loginRun = undefined;
      }
    })();
    return this.current;
  }

  async cancelLogin(): Promise<WecomView> {
    if (this.current.state === "connecting") return this.disconnect();
    return this.current;
  }

  async disconnect(): Promise<WecomView> {
    if (this.closed) return this.current;
    if (this.disconnecting !== undefined) {
      await this.disconnecting;
      return this.current;
    }
    this.generation.abort();
    this.generation = new AbortController();
    this.initialized = true;
    this.catalog = undefined;
    this.current = DISCONNECTED;
    this.disconnecting = (async () => {
      try {
        await Promise.all([this.restoring, this.loginRun]);
        await this.cli.logout();
        this.mustDisconnect = false;
      } catch {
        this.mustDisconnect = true;
        if (!this.closed) {
          this.current = {
            state: "failed",
            capabilities: [],
            error: "无法清除本地企业微信登录，请重试断开。",
          };
        }
      } finally {
        this.disconnecting = undefined;
      }
    })();
    await this.disconnecting;
    return this.current;
  }

  close(): void {
    this.closed = true;
    this.generation.abort();
    this.catalog = undefined;
    this.current = DISCONNECTED;
  }

  apps(): AppTools {
    const generation = this.generation;
    let snapshot: Promise<Catalog | undefined> | undefined;
    const get = () =>
      (snapshot ??= (async () => {
        await this.restore();
        return generation.signal.aborted ? undefined : this.catalog;
      })());
    const active = (catalog: Catalog | undefined): catalog is Catalog =>
      catalog !== undefined && !generation.signal.aborted && catalog === this.catalog;
    return {
      list: async () => (await get())?.list() ?? [],
      describe: async (names) => (await get())?.describe(names) ?? new Map(),
      preflight: async (name, args) => {
        const catalog = await get();
        if (!active(catalog)) {
          if (name.startsWith("WECOM_")) throw new Error(UNAVAILABLE);
          return undefined;
        }
        const plan = await catalog.preflight?.(name, args);
        if (!plan) return undefined;
        return {
          approvalArguments: plan.approvalArguments,
          execute: async () => {
            if (!active(catalog)) throw new Error(UNAVAILABLE);
            return plan.execute();
          },
        };
      },
      call: async (name, args) => {
        const catalog = await get();
        if (!active(catalog)) throw new Error(UNAVAILABLE);
        return catalog.call(name, args);
      },
    };
  }
}
