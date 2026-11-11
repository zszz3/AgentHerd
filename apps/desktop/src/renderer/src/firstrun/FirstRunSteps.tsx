// The bodies of the first-run steps. `FirstRun.tsx` owns the order, the titles and the buttons.

import type { ModelTest } from "@agentherd/host/api";
import {
  Boxes,
  Check,
  CircleAlert,
  CircleCheck,
  Loader2,
  MessageSquare,
  Plus,
  QrCode,
  RotateCcw,
  X,
} from "lucide-react";
import { useState } from "react";
import { type FeishuFlow, FeishuQr, Mark } from "../components/FeishuSetup";
import { Badge, Button, Group, IconTile, Row } from "../components/ui";
import { HERDER_STYLE_LABELS, type HerderStyle } from "../herder-styles";
import { applyModels, call, type ModelRef, useApp } from "../store";

/** The column every step body sits in. */
export const BODY = "w-full max-w-[440px]";

export function FeishuBody({ flow }: { flow: FeishuFlow }) {
  const { setup, channel, phase, busy, running, bound, start, cancel } = flow;
  if (bound) {
    return (
      <Group className={BODY}>
        <Row
          icon={
            <IconTile tone="green">
              <Check size={15} strokeWidth={2.25} />
            </IconTile>
          }
          title="已绑定"
          description={channel?.appId !== undefined ? `应用 ${channel.appId}` : "飞书机器人已就绪"}
          trailing={
            <Button variant="ghost" size="sm" onClick={start} disabled={busy}>
              <RotateCcw size={12} /> 重新绑定
            </Button>
          }
        />
      </Group>
    );
  }
  if (running || busy) {
    return (
      <div className="flex flex-col items-center gap-2">
        <FeishuQr flow={flow} />
        <Button variant="ghost" size="sm" onClick={cancel}>
          取消
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex h-48 w-48 items-center justify-center rounded-lg border border-line bg-surface">
        {phase === "failed" ? (
          <Mark className="bg-danger-soft text-danger-text">
            <X size={22} />
          </Mark>
        ) : (
          <QrCode size={40} strokeWidth={1.25} className="text-ink-dim" />
        )}
      </div>
      {phase === "failed" && (
        <p className="selectable max-w-[360px] text-center text-danger-text text-sm">
          绑定失败{setup?.error !== undefined ? `：${setup.error}` : ""}
        </p>
      )}
      <Button onClick={start}>
        {phase === "failed" ? <RotateCcw size={13} /> : <QrCode size={13} />}
        {phase === "failed" ? "重新获取二维码" : "获取二维码"}
      </Button>
    </div>
  );
}

/** The services already added, and a row to add one more. */
export function ServiceListBody({ onAdd }: { onAdd: () => void }) {
  const services = useApp((s) => s.models?.services ?? []);
  return (
    <Group className={BODY}>
      {services.map((s) => (
        <Row
          key={s.id}
          icon={<IconTile tone="green">{s.name.slice(0, 1)}</IconTile>}
          title={s.name}
          description={`${s.models.length} 个模型${s.hasKey ? "" : " · 没有 Key"}`}
          trailing={<Check size={16} className="text-success-text" />}
        />
      ))}
      <button
        type="button"
        onClick={onAdd}
        className="flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left text-ink-2 hover:bg-hover hover:text-ink"
      >
        <IconTile>
          <Plus size={15} strokeWidth={1.75} />
        </IconTile>
        <span className="font-medium">再添加一个服务</span>
      </button>
    </Group>
  );
}

function sameRef(a: ModelRef | undefined, b: ModelRef): boolean {
  return a !== undefined && a.serviceId === b.serviceId && a.model === b.model;
}

/** Choosing the Herder's model: it is saved at once, then tried with one short request. */
export function useHerderChoice() {
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<ModelRef | null>(null);
  const [result, setResult] = useState<{ ref: ModelRef; test: ModelTest } | null>(null);

  const test = async (ref: ModelRef) => {
    setTesting(ref);
    setResult(null);
    const outcome = await call((h) => h.testModel(ref));
    setTesting(null);
    if (outcome !== undefined) setResult({ ref, test: outcome });
  };

  const choose = async (ref: ModelRef) => {
    setBusy(true);
    const models = await call((h) => h.chooseModel("herder", ref));
    setBusy(false);
    if (models === undefined) return;
    applyModels(models);
    void test(ref);
  };

  return { busy, testing, result, choose, test };
}

export type HerderChoice = ReturnType<typeof useHerderChoice>;

export function HerderBody({ herder }: { herder: HerderChoice }) {
  const models = useApp((s) => s.models);
  const current = models?.roles.herder;
  const options = (models?.services ?? []).flatMap((s) =>
    s.models.map((model) => ({ ref: { serviceId: s.id, model }, service: s })),
  );
  if (options.length === 0) {
    return (
      <Group className={BODY}>
        <div className="flex flex-col items-center gap-1 px-6 py-8 text-center">
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-control-hover text-ink-muted">
            <Boxes size={18} strokeWidth={1.75} />
          </div>
          <div className="font-medium text-ink">还没有模型</div>
          <div className="text-ink-muted text-md">回到上一步添加一个模型服务。</div>
        </div>
      </Group>
    );
  }
  const shown = herder.result !== null && sameRef(current, herder.result.ref);
  return (
    <div className={`${BODY} flex flex-col gap-3`}>
      <Group className="max-h-[max(168px,calc(100vh-372px))] overflow-y-auto">
        {options.map(({ ref, service }) => {
          const selected = sameRef(current, ref);
          return (
            <button
              key={`${ref.serviceId}/${ref.model}`}
              type="button"
              aria-pressed={selected}
              disabled={herder.busy}
              onClick={() => void herder.choose(ref)}
              className={`flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left ${
                selected ? "bg-control-hover" : "hover:bg-hover"
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium font-mono text-ink text-md">
                  {ref.model}
                </span>
                <span className="block truncate text-ink-muted text-sm">{service.name}</span>
              </span>
              {!service.hasKey && service.kind === "builtin" && (
                <Badge tone="amber">没有 Key</Badge>
              )}
              {selected && <Check size={16} className="text-accent-text" />}
            </button>
          );
        })}
      </Group>
      <TestLine herder={herder} current={current} visible={shown} />
    </div>
  );
}

function TestLine({
  herder,
  current,
  visible,
}: {
  herder: HerderChoice;
  current: ModelRef | undefined;
  visible: boolean;
}) {
  if (herder.testing !== null) {
    return (
      <div className="flex min-h-9 items-center gap-2 px-1 text-ink-muted text-md">
        <Loader2 size={14} className="animate-spin" />
        正在试一下 {herder.testing.model}…
      </div>
    );
  }
  const result = visible ? herder.result : null;
  if (result === null) {
    return (
      <div className="flex min-h-9 items-center gap-2 px-1 text-ink-muted text-md">
        {current === undefined ? (
          "选一个模型，AgentHerd 会先发一句话试试它。"
        ) : (
          <>
            <span className="flex-1">已选 {current.model}</span>
            <Button variant="link" size="sm" onClick={() => void herder.test(current)}>
              测试
            </Button>
          </>
        )}
      </div>
    );
  }
  if (result.test.ok) {
    return (
      <div className="flex min-h-9 items-start gap-2 rounded-lg bg-success-soft px-3 py-2 text-md text-success-text">
        <CircleCheck size={15} className="mt-px shrink-0" />
        <span className="selectable min-w-0 flex-1 break-words">
          模型能用。它回复：{result.test.reply}
        </span>
      </div>
    );
  }
  return (
    <div className="flex min-h-9 items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-danger-text text-md">
      <CircleAlert size={15} className="mt-px shrink-0" />
      <span className="selectable min-w-0 flex-1 break-words">
        没有试通：{result.test.message}。换一个模型，或回上一步检查 Key。
      </span>
      <Button variant="link" size="sm" onClick={() => void herder.test(result.ref)}>
        重试
      </Button>
    </div>
  );
}

/** The three ways the Herder can talk, each with a sample message about the same work. */
export function StyleBody({
  style,
  onChoose,
}: {
  style: HerderStyle;
  onChoose: (style: HerderStyle) => void;
}) {
  return (
    <div className={`${BODY} flex flex-col gap-2.5`}>
      {HERDER_STYLE_LABELS.map((s) => {
        const selected = s.style === style;
        const look = selected ? "border-accent bg-control-hover" : "border-line bg-surface";
        return (
          <label
            key={s.style}
            className={`flex w-full cursor-pointer flex-col gap-2 rounded-lg border px-4 py-3 text-left transition-colors hover:bg-hover has-[:focus-visible]:bg-hover ${look}`}
          >
            <input
              type="radio"
              name="herderStyle"
              className="sr-only"
              checked={selected}
              onChange={() => onChoose(s.style)}
            />
            <span className="flex items-center gap-2">
              <span className="font-medium text-ink text-md">{s.title}</span>
              <span className="flex-1 text-ink-dim text-sm">{s.from}</span>
              {selected && <Check size={16} className="text-accent-text" />}
            </span>
            <span className="rounded-md bg-canvas px-3 py-2 text-ink-2 text-sm leading-5">
              {s.sample}
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** What the owner set up, and what is left for later. */
export function DoneBody() {
  const channel = useApp((s) => s.status?.channel);
  const services = useApp((s) => s.models?.services ?? []);
  const herder = useApp((s) => s.models?.roles.herder);
  const style = useApp((s) => s.status?.herderStyle);
  const styleTitle = HERDER_STYLE_LABELS.find((s) => s.style === style)?.title;
  const row = (ok: boolean) => (
    <IconTile tone={ok ? "green" : "gray"}>
      {ok ? <Check size={15} strokeWidth={2.25} /> : <span className="text-ink-dim">—</span>}
    </IconTile>
  );
  return (
    <Group className={BODY}>
      <Row
        icon={row(channel?.bound === true)}
        title="飞书"
        description={
          channel?.bound === true
            ? `已绑定${channel.appId !== undefined ? ` · ${channel.appId}` : ""}`
            : "还没绑定，之后在「设置」里绑定"
        }
        trailing={<MessageSquare size={15} strokeWidth={1.75} className="text-ink-dim" />}
      />
      <Row
        icon={row(services.length > 0)}
        title="模型服务"
        description={
          services.length > 0
            ? services.map((s) => s.name).join("、")
            : "还没添加，之后在「模型」页添加"
        }
      />
      <Row
        icon={row(herder !== undefined)}
        title="主管模型"
        description={
          herder !== undefined
            ? `${herder.serviceId} / ${herder.model}`
            : "还没选，之后在「模型」页选"
        }
      />
      <Row
        icon={row(styleTitle !== undefined)}
        title="主管的说话风格"
        description={styleTitle ?? "之后在「主管」页选"}
      />
    </Group>
  );
}
