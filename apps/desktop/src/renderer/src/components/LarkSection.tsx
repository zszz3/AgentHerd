// 应用连接 › 账号 › 飞书 (ADR 0059): agents read and write the owner's 飞书 docs, calendar and tables
// through lark-cli. It is 飞书's own tool, so there is no risk notice: 连接 installs lark-cli if
// needed, then shows a QR code scanned with the 飞书 app.

import type { LarkView } from "@agentherd/host/api";
import { Activity, Link2, Loader2, LogOut, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { call, useApp } from "../store";
import {
  Abilities,
  type AbilityList,
  ConnectionRow,
  RowActions,
  subtitle,
  type Tested,
} from "./ConnectionRow";
import { Modal } from "./Modal";
import { Badge, Button, IconTile } from "./ui";

const ABILITIES: AbilityList = {
  reads: ["搜文档", "读文档和知识库", "新建文档", "查日程", "看多维表格和表格", "看会议纪要"],
  writes: ["改已有文档", "写表格", "建日程", "发消息"],
  example: "「把这次调研写成飞书文档发我」",
};

function stateBadge(lark: LarkView) {
  switch (lark.state) {
    case "ready":
      return (
        <Badge tone="green">已连接{lark.account !== undefined ? ` · ${lark.account}` : ""}</Badge>
      );
    case "signed-out":
    case "no-app":
      return <Badge>未连接</Badge>;
    case "missing":
      return <Badge>未安装</Badge>;
    case "installing":
      return <Badge tone="blue">安装中</Badge>;
    case "failed":
      return <Badge tone="red">出错</Badge>;
  }
}

/**
 * Connecting 飞书 in one dialog: AgentHerd gets lark-cli ready (this can take a minute the first
 * time), then shows the QR code. It closes by itself once a "lark" event says 飞书 is ready.
 */
function ConnectDialog({ lark, onClose }: { lark: LarkView; onClose: () => void }) {
  const [phase, setPhase] = useState<"preparing" | "code" | "failed">("preparing");
  const [login, setLogin] = useState<{ image: string; url: string } | undefined>();
  const started = useRef(false);

  const connect = async () => {
    setPhase("preparing");
    const result = await call((h) => h.connectLark());
    if (result === undefined) {
      setPhase("failed");
      return;
    }
    setLogin(result);
    setPhase("code");
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void connect();
  });

  useEffect(() => {
    if (lark.state === "ready" && phase === "code") onClose();
  }, [lark.state, phase, onClose]);

  return (
    <Modal title="连接飞书" onClose={onClose}>
      <div className="flex min-h-64 flex-col items-center justify-center gap-3 pb-2">
        {phase === "preparing" && (
          <>
            <Loader2 size={20} className="animate-spin text-ink-muted" />
            <p className="text-ink-muted text-md">正在准备…</p>
          </>
        )}
        {phase === "code" && login !== undefined && (
          <>
            <img
              src={login.image}
              alt="飞书授权二维码"
              className="h-52 w-52 rounded-lg border border-line bg-white object-contain p-2"
            />
            <p className="text-ink-muted text-md">用飞书 App 扫码授权，扫完这里会自己关掉</p>
            <a
              href={login.url}
              target="_blank"
              rel="noreferrer"
              className="text-accent-text text-sm hover:underline"
            >
              或在浏览器打开
            </a>
          </>
        )}
        {phase === "failed" && (
          <>
            <p className="text-ink-2 text-md">没连上{lark.problem ? `：${lark.problem}` : ""}</p>
            <Button onClick={() => void connect()}>再试一次</Button>
          </>
        )}
      </div>
    </Modal>
  );
}

/** 飞书 as a folded row: 连接 or 测试连接 on the row, the rest when opened. */
export function LarkRow() {
  const lark = useApp((s) => s.lark);
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState<Tested | undefined>();
  const close = useCallback(() => setConnecting(false), []);
  if (lark === undefined) return null;
  const ready = lark.state === "ready";

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setTested(undefined);
    await action();
    setBusy(false);
  };
  /** 测试连接: asks 飞书 now whether the sign-in still works. */
  const test = () =>
    run(async () => {
      const result = await call((h) => h.testLark());
      if (result === undefined) return;
      useApp.setState({ lark: result.lark });
      setTested({ ok: result.ok, message: result.message });
    });
  const logout = () =>
    run(async () => {
      const next = await call((h) => h.logoutLark());
      if (next !== undefined) useApp.setState({ lark: next });
    });
  /** 重连: forgets the old sign-in and scans again. */
  const reconnect = () => logout().then(() => setConnecting(true));

  const action =
    lark.state === "installing" ? undefined : ready ? (
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void test()}>
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Activity size={12} />}
        测试连接
      </Button>
    ) : (
      <Button size="sm" disabled={busy} onClick={() => setConnecting(true)}>
        <Link2 size={12} />
        连接
      </Button>
    );

  return (
    <ConnectionRow
      icon={<IconTile tone={ready ? "green" : "gray"}>飞</IconTile>}
      name="飞书"
      badge={stateBadge(lark)}
      subtitle={subtitle(lark.state === "failed" ? lark.problem : undefined, tested)}
      action={action}
      alert={lark.state === "failed"}
      dialog={connecting && <ConnectDialog lark={lark} onClose={close} />}
    >
      <Abilities abilities={ABILITIES} />
      {ready && (
        <RowActions>
          <Button size="sm" disabled={busy} onClick={() => void reconnect()}>
            <RefreshCw size={12} />
            重连
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void logout()}>
            <LogOut size={12} />
            断开
          </Button>
        </RowActions>
      )}
    </ConnectionRow>
  );
}
