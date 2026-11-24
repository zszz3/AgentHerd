import {
  acquireLocationLease,
  canListDirectory,
  hasLocationRequest,
  isAgentHerdHome,
  LocationBusyError,
  type LocationContext,
  LocationError,
  type LocationLease,
  type LocationRecord,
  readLocationRecord,
  resolveLocation,
  writeLocationRecord,
  writeLocationRequest,
} from "@agentherd/host/data-location";
import { type ApplyResult, canCopy } from "@agentherd/host/location-apply";
import type {
  DataDirectoryResult,
  DataDirectoryView,
  RecoveryChoice,
} from "../shared/data-directory.ts";

interface Ports {
  pick(existing: boolean): Promise<string | undefined>;
  confirm(from: string, to: string, copy: boolean): Promise<"empty" | "copy" | undefined>;
  confirmPrevious(path: string): Promise<boolean>;
  restart(): void;
  ready(home: string): void;
  changed(files: number): void;
  checkParent(parent: string, protectedPaths: readonly string[]): Promise<string>;
  /** Settles (rejects) soon after `signal` aborts. */
  apply(progress: (files: number) => void, signal: AbortSignal): Promise<ApplyResult>;
}

const errorResult = (code: string): DataDirectoryResult => ({ ok: false, code });

/** The native confirmation for a change; the owner reads it before AgentHerd restarts. */
export function changeConfirmation(
  from: string,
  to: string,
  copy: boolean,
): { message: string; detail: string; buttons: string[] } {
  return {
    message: "AgentHerd 将重启并切换数据目录。",
    detail: [
      `当前：${from}`,
      `新目录：${to}`,
      "",
      "重启时运行中的任务会像正常退出一样停止。旧目录及其中的文件会保留，不会被删除。",
      "切换前请关闭旧版 AgentHerd 和正在运行的 AgentHerd 命令行。",
      "使用空目录时，新目录中没有账号和历史，需要重新设置。",
      copy
        ? "复制会包含凭据，请不要选择共享或同步文件夹。缓存和运行状态不会复制。"
        : "当前数据目录的 worktrees 中有 Git 工作树，无法复制，只能使用空目录。",
    ].join("\n"),
    buttons: ["取消", "使用空目录并重启", ...(copy ? ["复制并重启"] : [])],
  };
}
const cancelled = { ok: true, state: "cancelled" } as const;

export class DataDirectory {
  private view: DataDirectoryView = { state: "starting", canCopy: false };
  private lease?: LocationLease;
  private readonly stopping = new AbortController();
  private acting = false;
  private closed = false;

  private readonly ctx: LocationContext;
  private readonly ports: Ports;

  constructor(ctx: LocationContext, ports: Ports) {
    this.ctx = ctx;
    this.ports = ports;
  }

  status(): DataDirectoryView {
    return this.view;
  }

  async start(): Promise<void> {
    let result: ApplyResult;
    try {
      // Only a pending request is shown as a move; a normal start stays neutral.
      if (hasLocationRequest(this.ctx)) this.view = { state: "moving", canCopy: false };
      result = await this.ports.apply((files) => this.ports.changed(files), this.stopping.signal);
    } catch {
      // Whatever failed, offer the recovery the saved record allows.
      this.unavailable();
      return;
    }
    this.admit(result.kind === "failed" ? result.code : undefined);
  }

  /** Quit begins: end a running apply and start no host after it. */
  stop(): void {
    this.closed = true;
    this.stopping.abort();
  }

  private saved(): LocationRecord | undefined {
    try {
      return readLocationRecord(this.ctx);
    } catch (error) {
      if (error instanceof LocationError) return undefined;
      throw error;
    }
  }

  private unavailable(): void {
    const override = this.ctx.env.AGENTHERD_HOME;
    if (override !== undefined) {
      // The environment wins over the record, so name its directory and offer no return.
      this.view = { state: "unavailable", canCopy: false, home: override };
      return;
    }
    const saved = this.saved();
    this.view = {
      state: "unavailable",
      canCopy: false,
      ...(saved ? { home: saved.active } : {}),
      ...(saved?.previous && canListDirectory(saved.previous) ? { previous: saved.previous } : {}),
    };
  }

  private admit(failure?: DataDirectoryView["failure"]): boolean {
    if (this.closed) return false;
    try {
      this.lease = acquireLocationLease(this.ctx.base, "shared");
      const { home, source } = resolveLocation(this.ctx);
      this.view = {
        // While the environment wins, the app shows the override and offers no change.
        state: source === "env" ? "override" : failure ? "failed" : "ready",
        home,
        canCopy: source !== "env" && canCopy(home),
        ...(failure ? { failure } : {}),
      };
      this.ports.ready(home);
      return true;
    } catch {
      this.lease?.release();
      this.lease = undefined;
      this.unavailable();
      return false;
    }
  }

  close(): void {
    this.stop();
    this.lease?.release();
    this.lease = undefined;
  }

  private async action(work: () => Promise<DataDirectoryResult>): Promise<DataDirectoryResult> {
    if (this.closed || this.acting) return errorResult("busy");
    this.acting = true;
    try {
      return await work();
    } catch (error) {
      // Another AgentHerd or a CLI holds the location: tell the owner to close it.
      return errorResult(error instanceof LocationBusyError ? "busy" : "location-error");
    } finally {
      this.acting = false;
    }
  }

  change(): Promise<DataDirectoryResult> {
    return this.action(async () => {
      if (this.ctx.env.AGENTHERD_HOME !== undefined) return errorResult("env-override");
      if (this.lease === undefined) return errorResult("location-unavailable");
      const parent = await this.ports.pick(false);
      if (parent === undefined || this.closed) return cancelled;
      const { home, protectedPaths, protectedLocationFiles } = resolveLocation(this.ctx);
      let target: string;
      try {
        target = await this.ports.checkParent(parent, [
          ...protectedPaths,
          ...protectedLocationFiles,
        ]);
      } catch {
        return errorResult("invalid-target");
      }
      const copy = canCopy(home);
      const mode = await this.ports.confirm(home, target, copy);
      if (mode === undefined || this.closed) return cancelled;
      if (mode === "copy" && !copy) return errorResult("worktrees");
      writeLocationRequest(this.ctx, { version: 1, parent, mode });
      this.ports.restart();
      return { ok: true, state: "restarting" };
    });
  }

  recover(choice: RecoveryChoice): Promise<DataDirectoryResult> {
    return this.action(async () => {
      if (this.view.state !== "unavailable") return errorResult("not-unavailable");
      if (choice !== "retry") {
        if (this.ctx.env.AGENTHERD_HOME !== undefined) return errorResult("env-override");
        const target = choice === "pick" ? await this.ports.pick(true) : this.view.previous;
        if (target === undefined || this.closed) return cancelled;
        if (choice === "previous" && !(await this.ports.confirmPrevious(target))) return cancelled;
        if (this.closed) return cancelled;
        const lease = acquireLocationLease(this.ctx.base, "exclusive");
        try {
          const saved = this.saved();
          if (choice === "pick" && !isAgentHerdHome(target)) return errorResult("not-agentherd");
          if (!canListDirectory(target) || (choice === "previous" && saved?.previous !== target)) {
            this.unavailable();
            return errorResult("location-unavailable");
          }
          const retained = saved
            ? [
                ...new Set([
                  saved.active,
                  ...(saved.previous ? [saved.previous] : []),
                  ...saved.retained,
                ]),
              ].filter((path) => path !== target)
            : [];
          writeLocationRecord(this.ctx, { version: 1, active: target, retained }, lease);
        } finally {
          lease.release();
        }
      }
      return this.admit() ? { ok: true, state: "recovered" } : errorResult("location-unavailable");
    });
  }
}
