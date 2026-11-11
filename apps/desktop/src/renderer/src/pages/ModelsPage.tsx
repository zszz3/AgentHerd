// 模型 › 模型: every model choice in one place — the Herder's model, Pi's model and the tiers
// tasks pick from (ADR 0028) — and the list of model services with their keys (ADR 0021).

import { Boxes, Plus } from "lucide-react";
import { useState } from "react";
import { AddServiceDialog } from "../components/AddServiceDialog";
import { ModelTiers } from "../components/ModelTiers";
import { RolePicker } from "../components/RolePicker";
import { ServiceCard } from "../components/ServiceCard";
import { Button, EmptyState, Group, Section } from "../components/ui";
import { devOpen } from "../dev-bridge";
import { useApp } from "../store";

/** The dialog a dev preview asks for (`?open=` with the fake bridge); none in the app. */
function previewAdd(): { provider?: string; models?: string[] } | null {
  const open = devOpen();
  if (open === "add-service") return {};
  if (open === "add-custom") return { provider: "custom" };
  if (open === "add-builtin")
    return {
      provider: "openrouter",
      models: [
        "anthropic/claude-sonnet-4.5",
        "openai/gpt-5",
        "qwen/qwen3-coder",
        "my-private-model",
      ],
    };
  return null;
}

/** The service list with an "添加服务" button; also used inside onboarding. */
export function ServiceList() {
  const services = useApp((s) => s.models?.services);
  const [preview] = useState(previewAdd);
  const [adding, setAdding] = useState(preview !== null);
  const list = [...(services ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const add = (
    <Button variant={list.length === 0 ? "primary" : "secondary"} onClick={() => setAdding(true)}>
      <Plus size={14} /> 添加服务
    </Button>
  );
  return (
    <Section
      title="模型服务"
      hint="Key 只保存在本机，保存后不再显示"
      actions={list.length > 0 ? add : undefined}
    >
      {list.length === 0 ? (
        <Group>
          <EmptyState
            icon={<Boxes size={18} strokeWidth={1.75} />}
            title="还没有模型服务"
            text="添加一个服务商（比如 DeepSeek），或一个自定义服务（OpenAI 或 Anthropic 格式）。"
            action={add}
          />
        </Group>
      ) : (
        <div className="flex flex-col gap-3">
          {list.map((s) => (
            <ServiceCard key={s.id} service={s} />
          ))}
        </div>
      )}
      {adding && (
        <AddServiceDialog
          onClose={() => setAdding(false)}
          initialProvider={preview?.provider}
          initialModels={preview?.models}
        />
      )}
    </Section>
  );
}

export function ModelsPage() {
  return (
    <div className="flex flex-col gap-7">
      <Section title="谁用哪个模型" hint="选了就生效；选完会顺手试一下能不能用">
        <RolePicker />
      </Section>
      <ModelTiers />
      <ServiceList />
    </div>
  );
}
