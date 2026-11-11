// 应用连接 › 平台 (ADR 0058): 小红书 and 知乎 with the owner's own account. Turning one on needs the
// owner to accept the account-risk notice; signing in is a QR code scanned with the platform's app.

import type { SocialKind, SocialPlatform, SocialView } from "@agentherd/host/api";
import { Loader2, LogOut, QrCode } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { call, useApp } from "../store";
import { Modal } from "./Modal";
import { Badge, Button, Group, IconTile, Row, Section, Switch } from "./ui";

/** What each watch kind is called on each platform. */
const KIND_LABELS: Record<SocialPlatform, Record<SocialKind, string>> = {
  xiaohongshu: { mentions: "评论和@", likes: "赞和收藏", follows: "新增关注" },
  zhihu: { mentions: "评论、回答和@", likes: "赞同和喜欢", follows: "新增关注" },
};
const KINDS: readonly SocialKind[] = ["mentions", "likes", "follows"];

function stateBadge(social: SocialView): ReactNode {
  switch (social.state) {
    case "off":
      return <Badge>未开启</Badge>;
    case "starting":
      return <Badge tone="blue">准备中</Badge>;
    case "signed-out":
      return <Badge tone="amber">未登录</Badge>;
    case "ready":
      return (
        <Badge tone="green">
          已连接{social.account !== undefined ? ` · ${social.account}` : ""}
        </Badge>
      );
    case "failed":
      return <Badge tone="red">出错</Badge>;
  }
}

/** The account-risk notice; the platform turns on only after the owner ticks the box. */
function RiskNotice({ social, onClose }: { social: SocialView; onClose: () => void }) {
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const enable = async () => {
    setBusy(true);
    const next = await call((h) => h.enableSocial(social.platform, true));
    setBusy(false);
    if (next === undefined) return;
    useApp.setState({ socials: next });
    onClose();
  };
  return (
    <Modal
      title={`开启${social.name}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={!accepted || busy} onClick={() => void enable()}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            开启
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
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
          />
          我已了解风险
        </label>
      </div>
    </Modal>
  );
}

/** The sign-in QR code. It closes by itself when a "socials" event says the account is in. */
function LoginCode({
  social,
  image,
  onClose,
}: {
  social: SocialView;
  image: string;
  onClose: () => void;
}) {
  useEffect(() => {
    if (social.state === "ready") onClose();
  }, [social.state, onClose]);
  return (
    <Modal title={`登录${social.name}`} onClose={onClose}>
      <div className="flex flex-col items-center gap-3 pb-2">
        <img
          src={image}
          alt={`${social.name}登录二维码`}
          className="h-52 w-52 rounded-lg border border-line bg-white object-contain p-2"
        />
        <p className="text-ink-muted text-md">用{social.name} App 扫一扫</p>
      </div>
    </Modal>
  );
}

/**
 * A platform row, and its watch switches while it is on. The dialogs live in `SocialSection`: a
 * Group draws a line above each child, so they must not be its children.
 */
function PlatformRows({
  social,
  onEnable,
  onCode,
}: {
  social: SocialView;
  onEnable: () => void;
  onCode: (image: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const on = social.state !== "off";

  const apply = async (action: () => Promise<SocialView[] | undefined>) => {
    setBusy(true);
    const next = await action();
    setBusy(false);
    if (next !== undefined) useApp.setState({ socials: next });
  };
  const toggle = (value: boolean) => {
    if (value) onEnable();
    else void apply(() => call((h) => h.disableSocial(social.platform)));
  };
  const login = async () => {
    setBusy(true);
    const result = await call((h) => h.socialLoginCode(social.platform));
    setBusy(false);
    if (result === undefined) return;
    if (result.signedIn) {
      const next = await call((h) => h.socials());
      if (next !== undefined) useApp.setState({ socials: next });
      return;
    }
    onCode(result.image);
  };

  const action =
    social.state === "signed-out" ? (
      <Button size="sm" disabled={busy} onClick={() => void login()}>
        <QrCode size={12} />
        扫码登录
      </Button>
    ) : social.state === "ready" ? (
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => void apply(() => call((h) => h.socialLogout(social.platform)))}
      >
        <LogOut size={12} />
        退出登录
      </Button>
    ) : undefined;

  return (
    <>
      <Row
        icon={
          <IconTile tone={social.state === "ready" ? "green" : "gray"}>
            {social.name.slice(0, 1)}
          </IconTile>
        }
        title={
          <span className="flex items-center gap-2">
            {social.name}
            {stateBadge(social)}
          </span>
        }
        description={social.problem}
        trailing={
          <>
            {action}
            <Switch label={`开启${social.name}`} checked={on} disabled={busy} onChange={toggle} />
          </>
        }
      />
      {on &&
        KINDS.map((kind) => (
          <Row
            key={kind}
            className="min-h-10! py-1.5 pl-14"
            title={
              <span className="font-normal text-ink-2 text-md">
                {KIND_LABELS[social.platform][kind]}
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
  const [notice, setNotice] = useState<SocialPlatform | undefined>();
  const [code, setCode] = useState<{ platform: SocialPlatform; image: string } | undefined>();
  const closeCode = useCallback(() => setCode(undefined), []);
  const noticed = socials?.find((s) => s.platform === notice);
  const scanning = socials?.find((s) => s.platform === code?.platform);
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
            <PlatformRows
              key={s.platform}
              social={s}
              onEnable={() => setNotice(s.platform)}
              onCode={(image) => setCode({ platform: s.platform, image })}
            />
          ))
        )}
      </Group>
      {noticed !== undefined && (
        <RiskNotice social={noticed} onClose={() => setNotice(undefined)} />
      )}
      {code !== undefined && scanning !== undefined && (
        <LoginCode social={scanning} image={code.image} onClose={closeCode} />
      )}
    </Section>
  );
}
