import { type ReactNode, useEffect, useState } from "react";
import type { DataDirectoryView, RecoveryChoice } from "../../../shared/data-directory";
import { Button } from "./ui";

function explain(code: string): string {
  switch (code) {
    case "busy":
    case "host-running":
      return "请关闭其他 AgentHerd 进程后重试。";
    case "env-override":
      return "数据目录由 AGENTHERD_HOME 指定。";
    case "invalid-target":
      return "无法在所选位置创建私有 AgentHerd 文件夹，请选择其他本地文件夹。";
    case "worktrees":
      return "当前目录包含工作树，无法复制。";
    case "copy-failed":
      return "复制或校验失败。新位置可能留有不完整的文件夹，请选择其他位置。";
    case "corrupt-request":
      return "无法读取切换请求，请重新选择。";
    case "not-agentherd":
      return "所选文件夹不是现有的 AgentHerd 数据目录（缺少 herd.db），请选择其他文件夹。";
    case "location-unavailable":
      return "无法打开此数据目录。请检查磁盘连接和访问权限。";
    default:
      return "无法完成数据目录操作，请重试。";
  }
}

export function DataDirectoryGate({ children }: { children: ReactNode }) {
  const bridge = window.agentherd.dataDirectory;
  const [view, setView] = useState<DataDirectoryView>({ state: "starting", canCopy: false });
  const [files, setFiles] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const next = await bridge
        .status()
        .catch(() => ({ state: "unavailable", canCopy: false }) as const);
      if (!active) return;
      setView(next);
      if (next.state === "starting" || next.state === "moving") {
        timer = setTimeout(() => void refresh(), 150);
      }
    };
    const unsubscribe = bridge.onProgress(setFiles);
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [bridge]);
  async function recover(choice: RecoveryChoice) {
    if (!bridge) return;
    setBusy(true);
    setError("");
    try {
      const result = await bridge.recover(choice);
      if (!result.ok) setError(explain(result.code));
      setView(await bridge.status());
    } catch {
      setError(explain("location-error"));
    } finally {
      setBusy(false);
    }
  }
  if (
    !bridge ||
    (view.state !== "starting" && view.state !== "moving" && view.state !== "unavailable")
  ) {
    return (
      <>
        {view.failure && !dismissed && (
          <div
            role="alert"
            className="fixed right-4 bottom-4 z-50 flex max-w-sm items-start gap-2 rounded-card border border-line bg-canvas p-4 text-ink"
          >
            <p>数据目录未更改。{explain(view.failure)}</p>
            <Button variant="ghost" size="sm" onClick={() => setDismissed(true)}>
              知道了
            </Button>
          </div>
        )}
        {children}
      </>
    );
  }
  return (
    <div className="ah-frame flex h-full flex-col p-2 text-ink">
      <div className="app-drag h-9 shrink-0" />
      <main className="flex-1 overflow-auto rounded-card border border-line bg-canvas px-8 py-12">
        <div className="mx-auto max-w-[760px]">
          {view.state === "starting" ? (
            <h1 className="font-semibold text-xl">正在启动 AgentHerd</h1>
          ) : view.state === "moving" ? (
            <>
              <h1 className="font-semibold text-xl">正在处理数据目录</h1>
              <p role="status" className="mt-2 text-ink-muted">
                请稍候，完成后将打开 AgentHerd。{files > 0 && `已复制 ${files} 个文件。`}
              </p>
            </>
          ) : (
            <>
              <h1 className="font-semibold text-xl">无法打开数据目录</h1>
              <p className="mt-2 text-ink-muted">
                请重新连接磁盘后重试，或选择现有的 AgentHerd 数据目录。
              </p>
              {view.home && (
                <p className="selectable mt-2 break-all font-mono text-ink-muted">{view.home}</p>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <Button disabled={busy} onClick={() => void recover("retry")}>
                  重试
                </Button>
                {view.previous && (
                  <Button disabled={busy} onClick={() => void recover("previous")}>
                    返回上一个目录
                  </Button>
                )}
                <Button disabled={busy} onClick={() => void recover("pick")}>
                  选择现有目录
                </Button>
              </div>
              {error && (
                <p role="alert" className="mt-2 text-ink-muted">
                  {error}
                </p>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

export function DataDirectorySettings({ home }: { home: string }) {
  const bridge = window.agentherd.dataDirectory;
  const [view, setView] = useState<DataDirectoryView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (bridge) void bridge.status().then(setView, () => setError(explain("location-error")));
  }, [bridge]);
  async function change() {
    if (!bridge) return;
    setBusy(true);
    setError("");
    try {
      const result = await bridge.change();
      if (!result.ok) setError(explain(result.code));
    } catch {
      setError(explain("location-error"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex max-w-[420px] min-w-0 flex-col items-end gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="selectable min-w-0 break-all font-mono text-ink-muted text-sm">
          {view?.home ?? home}
        </span>
        {view && view.state !== "override" && (
          <Button disabled={busy} onClick={() => void change()}>
            更改
          </Button>
        )}
      </div>
      {view?.state === "override" && (
        <p className="text-ink-muted text-sm">{explain("env-override")}</p>
      )}
      {error && (
        <p role="alert" className="text-ink-muted text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
