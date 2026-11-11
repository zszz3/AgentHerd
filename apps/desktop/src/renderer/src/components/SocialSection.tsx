// 应用连接 › 平台 (ADR 0058): 小红书 and 知乎 with the owner's own account. Each has one 连接
// button: the account-risk notice the first time, then a QR code scanned with the platform's app.

import type { SocialKind, SocialPlatform, SocialView } from "@agentherd/host/api";
import { Activity, Link2, Loader2, LogOut, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { call, useApp } from "../store";
import { Modal } from "./Modal";
import { Badge, Button, Group, IconTile, Row, Section, Switch } from "./ui";

/** What each watch kind is called on each platform. */
const KIND_LABELS: Record<SocialPlatform, Record<SocialKind, string>> = {
  xiaohongshu: { mentions: "评论和@", likes: "赞和收藏", follows: "新增关注" },
  zhihu: { mentions: "评论、回答和@", likes: "赞同和喜欢", follows: "新增关注" },
};
// Likes, saves and new followers are never told (ADR 0058).
const KINDS: readonly SocialKind[] = ["mentions"];

/**
 * What agents can do with each account (the XIAOHONGSHU_ / ZHIHU_ tools, ADR 0058). Writes show
 * under the owner's name, so each one asks first (ADR 0056).
 */
const ABILITIES: Record<SocialPlatform, AbilityList> = {
  xiaohongshu: {
    reads: ["搜索笔记", "首页推荐", "看笔记和评论", "看博主主页", "看我的主页", "看通知"],
    writes: ["发图文笔记", "发视频笔记", "评论", "回复评论", "点赞", "收藏"],
    example: "「在小红书搜一下 AI Agent 的笔记，挑三篇说说」",
  },
  zhihu: {
    reads: ["搜索", "看热榜", "看问题和回答", "看专栏文章", "看评论", "看我的主页", "看通知"],
    writes: ["评论", "回复评论", "赞同回答"],
    example: "「看看知乎上怎么评价 Claude Code，总结一下」",
  },
};

/** What agents can do with one connection: done directly, asked first, and a sample request. */
export interface AbilityList {
  reads: readonly string[];
  writes: readonly string[];
  example: string;
}

/** The chips listing what agents can do with a connection; shown connected or not. */
export function Abilities({ abilities: a, ready }: { abilities: AbilityList; ready: boolean }) {
  return (
    <div className={`space-y-2 py-2.5 pr-4 pl-14 ${ready ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-ink-muted text-xs">直接做</span>
        {a.reads.map((r) => (
          <Badge key={r}>{r}</Badge>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-ink-muted text-xs">先问你</span>
        {a.writes.map((w) => (
          <Badge key={w} tone="amber">
            {w}
          </Badge>
        ))}
      </div>
      <div className="text-ink-muted text-xs">
        {ready ? `跟主管说就行，比如${a.example}` : "连接后，跟主管说就能用"}
      </div>
    </div>
  );
}

/**
 * Connecting a platform, in one dialog: the account-risk notice the first time, then AgentHerd
 * gets ready, then the QR code. It closes by itself once the account is signed in.
 */
function ConnectDialog({ social, onClose }: { social: SocialView; onClose: () => void }) {
  const [phase, setPhase] = useState<"notice" | "preparing" | "code" | "failed">(
    social.accepted ? "preparing" : "notice",
  );
  const [ticked, setTicked] = useState(false);
  const [image, setImage] = useState("");
  const [problem, setProblem] = useState<string | undefined>();
  const started = useRef(false);

  const connect = useCallback(async () => {
    setPhase("preparing");
    if (!social.enabled || social.state === "failed") {
      const next = await call((h) => h.enableSocial(social.platform, true));
      if (next === undefined) {
        setPhase("failed");
        return;
      }
      useApp.setState({ socials: next });
      const now = next.find((s) => s.platform === social.platform);
      if (now?.state === "failed") {
        setProblem(now.problem);
        setPhase("failed");
        return;
      }
      if (now?.state === "ready") return;
    }
    const result = await call((h) => h.socialLoginCode(social.platform));
    if (result === undefined) {
      setPhase("failed");
      return;
    }
    if (result.signedIn) {
      const next = await call((h) => h.socials());
      if (next !== undefined) useApp.setState({ socials: next });
      return;
    }
    setImage(result.image);
    setPhase("code");
  }, [social.enabled, social.state, social.platform]);

  // Already accepted: go straight on.
  useEffect(() => {
    if (phase === "preparing" && !started.current) {
      started.current = true;
      void connect();
    }
  }, [phase, connect]);

  useEffect(() => {
    if (social.state === "ready" && phase !== "notice") onClose();
  }, [social.state, phase, onClose]);

  if (phase === "notice") {
    return (
      <Modal
        title={`连接${social.name}`}
        onClose={onClose}
        footer={
          <>
            <Button onClick={onClose}>取消</Button>
            <Button
              variant="primary"
              disabled={!ticked}
              onClick={() => {
                started.current = true;
                void connect();
              }}
            >
              继续连接
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-ink-2 text-md leading-6">
            AgentHerd 通过模拟浏览器操作，用你自己的账号访问{social.name}。
            这不是平台的官方接口：平台可能认为是自动化行为，导致限流、要求验证甚至封号，后果由你自己承担。
            AgentHerd 会尽量降低频率（每 20
            分钟左右看一次通知），发帖、评论、回复、点赞每次都会先问你，除非你开任务时说过可以。
            登录信息只保存在这台 Mac 上。担心的话建议先用小号。
          </p>
          <label className="flex cursor-pointer items-center gap-2 text-ink text-md">
            <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
            我已了解风险
          </label>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={`连接${social.name}`} onClose={onClose}>
      <div className="flex min-h-64 flex-col items-center justify-center gap-3 pb-2">
        {phase === "preparing" && (
          <>
            <Loader2 size={20} className="animate-spin text-ink-muted" />
            <p className="text-ink-muted text-md">正在打开{social.name}登录，第一次要多等一会…</p>
          </>
        )}
        {phase === "code" && (
          <>
            <img
              src={image}
              alt={`${social.name}登录二维码`}
              className="h-52 w-52 rounded-lg border border-line bg-white object-contain p-2"
            />
            <p className="text-ink-muted text-md">用{social.name} App 扫一扫，扫完这里会自己关掉</p>
          </>
        )}
        {phase === "failed" && (
          <>
            <p className="text-ink-2 text-md">没连上{problem ? `：${problem}` : ""}</p>
            <Button
              onClick={() => {
                started.current = true;
                void connect();
              }}
            >
              再试一次
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}

/**
 * A platform row, and its watch switches while it is connected. The dialog lives in
 * `SocialSection`: a Group draws a line above each child, so it must not be its child.
 */
function PlatformRows({ social, onConnect }: { social: SocialView; onConnect: () => void }) {
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState<{ ok: boolean; message: string } | undefined>();
  const ready = social.state === "ready";

  const disconnect = async () => {
    setBusy(true);
    setTested(undefined);
    await call((h) => h.socialLogout(social.platform));
    const next = await call((h) => h.disableSocial(social.platform));
    setBusy(false);
    if (next !== undefined) useApp.setState({ socials: next });
  };
  /** 测试连接: asks the platform now whether the account is still signed in. */
  const test = async () => {
    setBusy(true);
    setTested(undefined);
    const result = await call((h) => h.testSocial(social.platform));
    setBusy(false);
    if (result === undefined) return;
    useApp.setState({ socials: result.socials });
    setTested({ ok: result.ok, message: result.message });
  };
  /** 重连: forgets the old sign-in and scans again. */
  const reconnect = async () => {
    setBusy(true);
    setTested(undefined);
    if (ready) await call((h) => h.socialLogout(social.platform));
    setBusy(false);
    onConnect();
  };

  const trailing = !social.available ? (
    <Badge>即将支持</Badge>
  ) : social.state === "starting" ? (
    <Badge tone="blue">准备中</Badge>
  ) : social.enabled ? (
    <>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void test()}>
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Activity size={12} />}
        测试连接
      </Button>
      <Button size="sm" disabled={busy} onClick={() => void reconnect()}>
        <RefreshCw size={12} />
        重连
      </Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void disconnect()}>
        <LogOut size={12} />
        断开
      </Button>
    </>
  ) : (
    <Button size="sm" onClick={onConnect}>
      <Link2 size={12} />
      连接
    </Button>
  );

  const description = !social.available
    ? undefined
    : tested !== undefined
      ? tested.message
      : social.state === "failed"
        ? social.problem
        : social.state === "signed-out" && social.enabled
          ? "登录已失效，点「重连」扫码"
          : undefined;

  return (
    <>
      <Row
        icon={<IconTile tone={ready ? "green" : "gray"}>{social.name.slice(0, 1)}</IconTile>}
        title={
          <span className="flex items-center gap-2">
            {social.name}
            {ready && (
              <Badge tone="green">
                已连接{social.account !== undefined ? ` · ${social.account}` : ""}
              </Badge>
            )}
            {social.state === "failed" && <Badge tone="red">出错</Badge>}
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
      {social.available && <Abilities abilities={ABILITIES[social.platform]} ready={ready} />}
      {ready &&
        KINDS.map((kind) => (
          <Row
            key={kind}
            className="min-h-10! py-1.5 pl-14"
            title={
              <span className="font-normal text-ink-2 text-md">
                告诉我{KIND_LABELS[social.platform][kind]}
              </span>
            }
            trailing={
              <Switch
                label={`${social.name}${KIND_LABELS[social.platform][kind]}`}
                checked={social.watch[kind]}
                onChange={(value) =>
                  void call((h) => h.setSocialWatch(social.platform, kind, value)).then(
                    (next) => next && useApp.setState({ socials: next }),
                  )
                }
              />
            }
          />
        ))}
    </>
  );
}

export function SocialSection() {
  const socials = useApp((s) => s.socials);
  const [connecting, setConnecting] = useState<SocialPlatform | undefined>();
  const close = useCallback(() => setConnecting(undefined), []);
  const current = socials?.find((s) => s.platform === connecting);
  return (
    <Section
      title="平台"
      hint="用你自己的账号让 Agent 读写小红书、知乎，并盯着新通知；跟主管说一句也能开关"
    >
      <Group>
        {socials === undefined ? (
          <div className="flex items-center gap-2 px-4 py-3 text-ink-muted text-md">
            <Loader2 size={14} className="animate-spin" />
            正在加载…
          </div>
        ) : (
          socials.map((s) => (
            <PlatformRows key={s.platform} social={s} onConnect={() => setConnecting(s.platform)} />
          ))
        )}
      </Group>
      {current !== undefined && <ConnectDialog social={current} onClose={close} />}
    </Section>
  );
}
