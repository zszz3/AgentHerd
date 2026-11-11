// 主管 › 说话风格: whether the Herder is working, its model (with 试一下), and how it talks
// (ADR 0053).

import type { SettingsPatch } from "@agentherd/host/api";
import { Bot, Check, MessageCircle } from "lucide-react";
import { useState } from "react";
import { herderReasonLabel } from "../components/labels";
import { RoleRow } from "../components/RolePicker";
import { Button, Dot, Group, IconTile, Row, Section } from "../components/ui";
import { HERDER_STYLE_LABELS } from "../herder-styles";
import { call, useApp } from "../store";

export function HerdersPage() {
  const status = useApp((s) => s.status);
  const setPage = useApp((s) => s.setPage);
  const serviceCount = useApp((s) => s.models?.services.length ?? 0);
  const [busy, setBusy] = useState(false);
  if (status === undefined) return null;
  const herder = status.herder;

  const update = async (patch: SettingsPatch) => {
    setBusy(true);
    const next = await call((h) => h.updateSettings(patch));
    if (next !== undefined) useApp.setState({ status: next });
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-7">
      <Group>
        <RoleRow
          modelRole="herder"
          icon={
            <IconTile tone={herder.on ? "green" : "gray"}>
              <Bot size={15} strokeWidth={1.75} />
            </IconTile>
          }
          title={
            <span className="flex items-center gap-2">
              主管
              <Dot tone={herder.on ? "green" : "gray"} />
              <span className="font-normal text-ink-muted text-sm">
                {herder.on ? "工作中" : "已关闭"}
              </span>
            </span>
          }
          description={
            herder.on
              ? "在飞书里跟你说话、开任务；用快一点、便宜一点的模型就够"
              : herderReasonLabel(herder.reason)
          }
        />
        {serviceCount === 0 && (
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 text-ink-muted text-sm">
            还没有模型服务，先添加一个才能选模型。
            <Button size="sm" onClick={() => setPage("models")}>
              去添加
            </Button>
          </div>
        )}
      </Group>

      <Section title="说话风格" hint="随时可以换，也可以直接在飞书里跟主管说">
        <Group>
          {HERDER_STYLE_LABELS.map(({ style, title, hint, sample }) => {
            const active = status.herderStyle === style;
            return (
              <label key={style} className="block cursor-pointer hover:bg-hover">
                <input
                  type="radio"
                  name="herderStyle"
                  className="peer sr-only"
                  checked={active}
                  disabled={busy}
                  onChange={() => void update({ herderStyle: style })}
                />
                <Row
                  className="peer-focus-visible:bg-hover"
                  icon={
                    <IconTile tone={active ? "blue" : "gray"}>
                      <MessageCircle size={15} strokeWidth={1.75} />
                    </IconTile>
                  }
                  title={title}
                  description={
                    <>
                      {hint}
                      <span className="mt-1 block text-ink-dim">例：{sample}</span>
                    </>
                  }
                  trailing={active ? <Check size={16} className="text-accent-text" /> : undefined}
                />
              </label>
            );
          })}
        </Group>
      </Section>
    </div>
  );
}
