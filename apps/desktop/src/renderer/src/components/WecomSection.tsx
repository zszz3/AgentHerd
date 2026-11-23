import type { RemoteHost, WecomView } from "@agentherd/host/api";
import { MessageSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { host } from "../store";
import { ConnectionRow } from "./ConnectionRow";
import { Badge, Button, Group, IconTile, Row } from "./ui";

const LOGOUT_FAILED = "无法清除本地企业微信登录，请重试断开。";

const STATE_LABELS = {
  disconnected: "未连接",
  connecting: "等待授权",
  connected: "已连接",
  failed: "连接失败",
};

export function WecomRow({
  view,
  onView,
}: {
  view: WecomView | undefined;
  onView: (view: WecomView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refreshNeeded, setRefreshNeeded] = useState(false);
  const [expanded, setExpanded] = useState<boolean>();
  const revision = useRef(0);
  const state = view?.state;
  const connecting = state === "connecting";
  const connected = state === "connected";
  const failed = state === "failed";
  const logoutFailed = failed && view?.error === LOGOUT_FAILED;
  const tone = connected ? "green" : failed ? "amber" : "gray";

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const next = await host().wecom();
        if (active) onView(next);
      } catch {
        if (active) setError("无法读取企业微信连接，请重试。");
      }
    })();
    return () => {
      active = false;
      revision.current++;
    };
  }, [onView]);

  useEffect(() => {
    if (!connecting || busy || refreshNeeded) return;
    let active = true;
    const started = revision.current;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await host().wecom();
        if (!active || started !== revision.current) return;
        onView(next);
        if (next.state === "connecting") timer = setTimeout(poll, 1000);
      } catch {
        if (!active || started !== revision.current) return;
        setRefreshNeeded(true);
        onView({ state: "connecting", capabilities: [] });
        setError("无法读取登录状态，请重新检查或取消登录。");
      }
    };
    timer = setTimeout(poll, 1000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [busy, connecting, onView, refreshNeeded]);

  async function update(request: (host: RemoteHost) => Promise<WecomView>, message: string) {
    const started = ++revision.current;
    setBusy(true);
    setError("");
    setExpanded(true);
    try {
      const next = await request(host());
      if (started !== revision.current) return;
      onView(next);
      setRefreshNeeded(false);
    } catch {
      if (started === revision.current) setError(message);
    } finally {
      if (started === revision.current) setBusy(false);
    }
  }

  const action =
    connected || logoutFailed ? (
      <Button
        size="sm"
        disabled={busy}
        onClick={() => void update((h) => h.disconnectWecom(), "无法断开企业微信连接，请重试。")}
      >
        {logoutFailed ? "重试断开" : "断开连接"}
      </Button>
    ) : connecting ? (
      <Button
        size="sm"
        disabled={busy}
        onClick={() => void update((h) => h.cancelWecomLogin(), "无法取消企业微信登录，请重试。")}
      >
        取消登录
      </Button>
    ) : state !== undefined ? (
      <Button
        size="sm"
        variant="primary"
        disabled={busy}
        onClick={() => void update((h) => h.startWecomLogin(), "无法发起企业微信登录，请重试。")}
      >
        {busy ? "正在连接…" : failed ? "重新扫码" : "扫码登录"}
      </Button>
    ) : undefined;
  const qr = view?.state === "connecting" && !busy ? view.qr : undefined;

  return (
    <ConnectionRow
      icon={
        <IconTile tone={tone}>
          <MessageSquare size={14} />
        </IconTile>
      }
      name="企业微信"
      badge={
        <Badge tone={tone === "gray" ? undefined : tone}>
          {state === undefined ? (error ? "未能读取" : "读取中…") : STATE_LABELS[state]}
        </Badge>
      }
      subtitle="连接企业账号，使用文档、日程、待办等已授权能力"
      action={action}
      open={expanded ?? (connecting || failed || error !== "")}
      onOpenChange={setExpanded}
    >
      <p className="text-ink-muted text-sm">
        Agent 只能使用你在企业微信授权的工具，不读取聊天记录。企业微信不能控制
        AgentHerd，写入操作须在飞书审批。
      </p>
      {error !== "" && (
        <p role="alert" className="text-danger-text text-sm">
          {error}
        </p>
      )}
      {failed && error === "" && (
        <p role="status" className="text-ink-muted text-sm">
          {logoutFailed ? LOGOUT_FAILED : "无法连接企业微信，请检查网络后重新扫码。"}
        </p>
      )}
      {(refreshNeeded || (state === undefined && error !== "")) && (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => void update((h) => h.wecom(), "无法读取企业微信连接，请重试。")}
        >
          检查状态
        </Button>
      )}
      {connecting && !refreshNeeded && (
        <div className="space-y-2">
          <p role="status" className="text-ink-muted text-sm">
            {busy
              ? "正在取消登录…"
              : qr === undefined
                ? "正在等待企业微信响应…"
                : "请用企业微信扫描二维码，并在手机上确认授权。"}
          </p>
          {qr !== undefined && (
            <img
              className="h-auto max-w-full rounded-md bg-white p-2"
              src={qr}
              alt="企业微信登录二维码"
              width={192}
              height={192}
              draggable={false}
            />
          )}
        </div>
      )}
      {view?.state === "connected" &&
        (view.capabilities.length > 0 ? (
          <>
            <p className="text-ink-muted text-sm">
              下方是支持的工具，实际能否使用取决于企业微信授权。
            </p>
            <Group>
              {view.capabilities.map(({ id, name, toolCount }) => (
                <Row key={id} title={name} description={`支持 ${toolCount} 个工具`} />
              ))}
            </Group>
          </>
        ) : (
          <p className="text-ink-muted text-sm">没有可用工具。请在企业微信中检查已授予的权限。</p>
        ))}
    </ConnectionRow>
  );
}
