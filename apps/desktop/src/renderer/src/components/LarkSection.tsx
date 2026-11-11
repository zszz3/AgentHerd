// 应用连接 › 飞书 (ADR 0059): agents read and write the owner's 飞书 docs, calendar and tables
// through lark-cli. It is 飞书's own tool, so there is no risk notice: 连接 installs lark-cli if
// needed, then shows a QR code scanned with the 飞书 app.

import type { LarkView } from "@agentherd/host/api";
import { Activity, Link2, Loader2, LogOut, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { call, useApp } from "../store";
import { Modal } from "./Modal";
import { Abilities, type AbilityList } from "./SocialSection";
import { Badge, Button, Group, IconTile, Row, Section } from "./ui";

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
      return <Badge tone="amber">未登录</Badge>;
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
            <p className="text-ink-muted text-sm">第一次要先装好飞书的命令行工具，可能要一分钟</p>
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

export function LarkSection() {
  const lark = useApp((s) => s.lark);
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState<{ ok: boolean; message: string } | undefined>();
  const close = () => setConnecting(false);

  /** 测试连接: asks 飞书 now whether the sign-in still works. */
  const test = async () => {
    setBusy(true);
    setTested(undefined);
    const result = await call((h) => h.testLark());
    setBusy(false);
    if (result === undefined) return;
    useApp.setState({ lark: result.lark });
    setTested({ ok: result.ok, message: result.message });
  };
  const logout = async () => {
    setBusy(true);
    setTested(undefined);
    const next = await call((h) => h.logoutLark());
    setBusy(false);
    if (next !== undefined) useApp.setState({ lark: next });
    return next !== undefined;
  };
  /** 重连: forgets the old sign-in and scans again. */
  const reconnect = async () => {
    if (await logout()) setConnecting(true);
  };

  const ready = lark?.state === "ready";
  const trailing =
    lark === undefined ? (
      <Loader2 size={14} className="animate-spin text-ink-muted" />
    ) : lark.state === "installing" ? undefined : ready ? (
      <>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void test()}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Activity size={12} />}
          测试连接
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void reconnect()}>
          <RefreshCw size={12} />
          重连
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void logout()}>
          <LogOut size={12} />
          断开
        </Button>
      </>
    ) : (
      <Button size="sm" onClick={() => setConnecting(true)}>
        <Link2 size={12} />
        连接
      </Button>
    );

  const description =
    tested !== undefined
      ? tested.message
      : lark?.state === "failed"
        ? lark.problem
        : lark?.state === "missing"
          ? "连接时会先自动安装飞书的命令行工具 lark-cli"
          : undefined;

  return (
    <Section title="飞书" hint="飞书官方的命令行工具，用你自己的飞书账号读写文档、日程和表格">
      <Group>
        <Row
          icon={<IconTile tone={ready ? "green" : "blue"}>飞</IconTile>}
          title={
            <span className="flex items-center gap-2">
              飞书
              {lark !== undefined && stateBadge(lark)}
            </span>
          }
          description={
            description === undefined ? undefined : (
              <span className={tested?.ok === true ? "text-green-600" : undefined}>
                {description}
              </span>
            )
          }
          trailing={trailing}
        />
        <Abilities abilities={ABILITIES} ready={ready} />
      </Group>
      {connecting && lark !== undefined && <ConnectDialog lark={lark} onClose={close} />}
    </Section>
  );
}
