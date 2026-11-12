// 应用连接 › 账号 (ADR 0058): 小红书 and 知乎 with the owner's own account. 连接 shows the
// account-risk notice the first time, then a QR code scanned with the platform's app.

import type { SocialKind, SocialPlatform, SocialView } from "@agentherd/host/api";
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
import { Badge, Button, IconTile, Switch } from "./ui";

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

function stateBadge(social: SocialView) {
  if (!social.available) return <Badge>即将支持</Badge>;
  switch (social.state) {
    case "ready":
      return (
        <Badge tone="green">
          已连接{social.account !== undefined ? ` · ${social.account}` : ""}
        </Badge>
      );
    case "starting":
      return <Badge tone="blue">准备中</Badge>;
    case "failed":
      return <Badge tone="red">出错</Badge>;
    case "signed-out":
      return social.enabled ? <Badge tone="amber">登录失效</Badge> : <Badge>未连接</Badge>;
    case "off":
      return <Badge>未连接</Badge>;
  }
}

/** One platform as a folded row: 连接 or 测试连接 on the row, the rest when opened. */
function PlatformRow({ social }: { social: SocialView }) {
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState<Tested | undefined>();
  const [connecting, setConnecting] = useState(false);
  const close = useCallback(() => setConnecting(false), []);
  const ready = social.state === "ready";

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setTested(undefined);
    await action();
    setBusy(false);
  };
  const disconnect = () =>
    run(async () => {
      await call((h) => h.socialLogout(social.platform));
      const next = await call((h) => h.disableSocial(social.platform));
      if (next !== undefined) useApp.setState({ socials: next });
    });
  /** 测试连接: asks the platform now whether the account is still signed in. */
  const test = () =>
    run(async () => {
      const result = await call((h) => h.testSocial(social.platform));
      if (result === undefined) return;
      useApp.setState({ socials: result.socials });
      setTested({ ok: result.ok, message: result.message });
    });
  /** 重连: forgets the old sign-in and scans again. */
  const reconnect = () =>
    run(async () => {
      await call((h) => h.socialLogout(social.platform));
      setConnecting(true);
    });

  const action =
    !social.available || social.state === "starting" ? undefined : ready ? (
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
      icon={<IconTile tone={ready ? "green" : "gray"}>{social.name.slice(0, 1)}</IconTile>}
      name={social.name}
      badge={stateBadge(social)}
      subtitle={subtitle(social.state === "failed" ? social.problem : undefined, tested)}
      action={action}
      alert={social.state === "failed"}
      dialog={connecting && <ConnectDialog social={social} onClose={close} />}
    >
      <Abilities abilities={ABILITIES[social.platform]} />
      {ready &&
        KINDS.map((kind) => (
          <div key={kind} className="flex items-center justify-between gap-3">
            <span className="text-ink-2 text-md">告诉我{KIND_LABELS[social.platform][kind]}</span>
            <Switch
              label={`${social.name}${KIND_LABELS[social.platform][kind]}`}
              checked={social.watch[kind]}
              onChange={(value) =>
                void call((h) => h.setSocialWatch(social.platform, kind, value)).then(
                  (next) => next && useApp.setState({ socials: next }),
                )
              }
            />
          </div>
        ))}
      {social.available && social.enabled && (
        <RowActions>
          {ready && (
            <Button size="sm" disabled={busy} onClick={() => void reconnect()}>
              <RefreshCw size={12} />
              重连
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void disconnect()}>
            <LogOut size={12} />
            断开
          </Button>
        </RowActions>
      )}
    </ConnectionRow>
  );
}

/** 小红书 and 知乎, one folded row each, for the 账号 group. */
export function SocialRows() {
  const socials = useApp((s) => s.socials);
  return (
    <>
      {socials?.map((s) => (
        <PlatformRow key={s.platform} social={s} />
      ))}
    </>
  );
}
