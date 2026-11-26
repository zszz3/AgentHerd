import type { MijiaDevice, MijiaView, RemoteHost } from "@agentherd/host/api";
import { House, Link2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { host } from "../store";
import { ConnectionRow } from "./ConnectionRow";
import { MijiaControls, MijiaUncertainOutcome } from "./MijiaControls";
import { Badge, Button, IconTile } from "./ui";

const labels = {
  unavailable: "不可用",
  disconnected: "未连接",
  waiting: "等待扫码",
  connected: "已连接",
  error: "连接失败",
  "cleanup-required": "待清理",
};

type Action = "mijia" | "startMijiaLogin" | "cancelMijiaLogin" | "disconnectMijia";

export function MijiaConnection({
  view,
  onView,
}: {
  view: MijiaView | undefined;
  onView: (view: MijiaView) => void;
}) {
  const revision = useRef(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(false);
  const [deviceProblem, setDeviceProblem] = useState(false);
  const [devices, setDevices] = useState<MijiaDevice[]>();
  const state = view?.state;

  useEffect(
    () => () => {
      revision.current++;
    },
    [],
  );

  useEffect(() => {
    if (busy || problem || (state !== undefined && state !== "waiting" && state !== "connected"))
      return;
    const started = revision.current;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const waiting = state === "waiting";
    const read = async () => {
      try {
        const next = await (waiting ? host().pollMijiaLogin() : host().mijia());
        if (!active || started !== revision.current) return;
        if (state === "connected" && next.state !== "connected") {
          setDevices(undefined);
          setDeviceProblem(false);
        }
        if (state !== "connected" || next.state !== "connected") onView(next);
        if (state === next.state) timer = setTimeout(read, waiting ? 1000 : 3000);
      } catch {
        if (active && started === revision.current) setProblem(true);
      }
    };
    if (waiting) timer = setTimeout(read, 1000);
    else void read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [state, busy, problem, onView]);

  useEffect(() => {
    if (state !== "connected" || busy || problem) return;
    let active = true;
    const started = revision.current;
    const read = async () => {
      try {
        const list = await host().mijiaDevices();
        if (active && started === revision.current) setDevices(list);
      } catch {
        if (active && started === revision.current) setDeviceProblem(true);
      }
    };
    void read();
    return () => {
      active = false;
    };
  }, [state, busy, problem]);

  async function update(action: Action) {
    const started = ++revision.current;
    setBusy(true);
    setProblem(false);
    setDeviceProblem(false);
    setDevices(undefined);
    try {
      const remote: RemoteHost = host();
      const next = await remote[action]();
      if (started === revision.current) onView(next);
    } catch {
      if (started === revision.current) setProblem(true);
    } finally {
      if (started === revision.current) setBusy(false);
    }
  }

  return (
    <MijiaRow
      view={view}
      busy={busy}
      problem={problem}
      deviceProblem={deviceProblem}
      devices={devices}
      controls={
        state === "connected" && !busy ? (
          <MijiaControls bridge={window.agentherd} showOutcome={false} />
        ) : undefined
      }
      onAction={(action) => void update(action)}
    />
  );
}

export function MijiaRow({
  view,
  busy,
  problem,
  deviceProblem,
  devices,
  controls,
  onAction,
}: {
  view: MijiaView | undefined;
  busy?: boolean;
  problem?: boolean;
  deviceProblem?: boolean;
  devices?: MijiaDevice[];
  controls?: ReactNode;
  onAction?: (action: Action) => void;
}) {
  const state = view?.state;
  const [open, setOpen] = useState<boolean>();
  const error = state === "error";
  const cleanup = state === "cleanup-required";
  const tone = error || cleanup || problem ? "amber" : state === "connected" ? "green" : "gray";
  const qr =
    view?.state === "waiting" &&
    !busy &&
    !problem &&
    /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/u.test(view.qrDataUrl ?? "")
      ? view.qrDataUrl
      : undefined;
  const action =
    state === "waiting" ? (
      <Button size="sm" disabled={busy} onClick={() => onAction?.("cancelMijiaLogin")}>
        取消扫码
      </Button>
    ) : state === "connected" ? (
      <Button size="sm" disabled={busy} onClick={() => onAction?.("disconnectMijia")}>
        断开连接
      </Button>
    ) : cleanup ? (
      <Button size="sm" disabled={busy} onClick={() => onAction?.("disconnectMijia")}>
        重试清理
      </Button>
    ) : (state === "disconnected" || error) && !problem ? (
      <Button
        size="sm"
        disabled={busy}
        onClick={() => {
          setOpen(true);
          onAction?.("startMijiaLogin");
        }}
      >
        <Link2 size={12} />
        连接
      </Button>
    ) : undefined;

  return (
    <ConnectionRow
      icon={
        <IconTile tone={tone}>
          <House size={14} />
        </IconTile>
      }
      name="米家"
      badge={<Badge tone={tone}>{problem ? "未能读取" : state ? labels[state] : "读取中…"}</Badge>}
      subtitle={
        controls ? "查看米家设备列表和桌面控制状态" : "实验性只读 · 查看米家设备列表，不控制设备"
      }
      action={action}
      dialog={<MijiaUncertainOutcome />}
      open={open ?? (busy || problem || (state !== undefined && state !== "disconnected"))}
      onOpenChange={setOpen}
    >
      {state === "unavailable" && (
        <p className="text-ink-muted text-sm">未安装 Do1e 外部运行时，暂时无法连接米家。</p>
      )}
      {state === "waiting" && !problem && (
        <div className="space-y-2">
          <p role="status" className="text-ink-muted text-sm">
            {qr ? "请使用米家 App 扫码，完成登录。" : "正在等待米家登录二维码…"}
          </p>
          {qr && (
            <img
              className="h-52 w-52 max-w-full rounded-lg border border-line bg-white object-contain p-2"
              src={qr}
              alt="米家登录二维码"
            />
          )}
        </div>
      )}
      {cleanup && (
        <p role="alert" className="text-danger-text text-sm">
          未能清理米家登录文件，请重试清理。清理前无法重新连接。
        </p>
      )}
      {error && !problem && (
        <p role="alert" className="text-danger-text text-sm">
          米家连接未完成，请重试。
        </p>
      )}
      {problem && (
        <div className="space-y-2">
          <p role="alert" className="text-danger-text text-sm">
            无法确认米家连接状态，请重新检查。
          </p>
          <Button size="sm" disabled={busy} onClick={() => onAction?.("mijia")}>
            检查状态
          </Button>
        </div>
      )}
      {state === "connected" && !problem && (
        <div className="space-y-2">
          <h3 className="font-medium text-ink text-sm">设备列表</h3>
          {deviceProblem ? (
            <p role="alert" className="text-danger-text text-sm">
              无法读取米家设备。重新打开应用连接后可重试。
            </p>
          ) : devices === undefined ? (
            <p role="status" className="text-ink-muted text-sm">
              正在读取设备列表…
            </p>
          ) : devices.length === 0 ? (
            <p className="text-ink-muted text-sm">没有可显示的设备。</p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {devices.map(({ id, name, home, room, online }) => {
                const location = [home, room].filter(Boolean).join(" · ");
                return (
                  <li
                    key={id}
                    className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium text-ink">{name}</p>
                      {location && <p className="truncate text-ink-muted">{location}</p>}
                    </div>
                    {online !== undefined && (
                      <Badge tone={online ? "green" : "gray"}>{online ? "在线" : "离线"}</Badge>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      {state === "connected" && !problem && open !== false && controls}
    </ConnectionRow>
  );
}
