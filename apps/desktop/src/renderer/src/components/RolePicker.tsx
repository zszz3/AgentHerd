// Choosing a model from the list for a role (ADR 0021): the select itself, and the rows of the
// 模型 page for the Herder and Pi, each with a 试一下 button.

import type { ModelTest } from "@agentherd/host/api";
import { Check, CircleAlert, Loader2 } from "lucide-react";
import { useState } from "react";
import { applyModels, call, type ModelRef, type ModelRole, useApp } from "../store";
import { Button, Group, inputClass, Row } from "./ui";

const NONE = "";

function encode(ref: ModelRef): string {
  return JSON.stringify([ref.serviceId, ref.model]);
}

function decode(value: string): ModelRef | null {
  if (value === NONE) return null;
  const parsed: unknown = JSON.parse(value);
  if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
    return { serviceId: parsed[0], model: parsed[1] };
  }
  return null;
}

/** A select over every listed model; picking one saves it for the role right away. */
export function RoleSelect({
  modelRole,
  label,
  className = "w-60",
  onChosen,
}: {
  modelRole: ModelRole;
  label: string;
  className?: string;
  /** Called after a choice was saved, with the new model (null for 不选). */
  onChosen?: (ref: ModelRef | null) => void;
}) {
  const models = useApp((s) => s.models);
  const [busy, setBusy] = useState(false);
  const services = models?.services ?? [];
  const ref = models?.roles[modelRole];
  const current = ref === undefined ? NONE : encode(ref);
  const listed = services.some((s) => s.id === ref?.serviceId && s.models.includes(ref.model));

  const choose = async (value: string) => {
    const next = decode(value);
    setBusy(true);
    const view = await call((h) => h.chooseModel(modelRole, next));
    setBusy(false);
    if (view === undefined) return;
    applyModels(view);
    onChosen?.(next);
  };

  return (
    <span className="relative block">
      <select
        aria-label={label}
        className={`${inputClass} ${className} ${current === NONE ? "text-ink-muted" : ""}`}
        value={current}
        disabled={busy || models === undefined}
        onChange={(e) => void choose(e.target.value)}
      >
        <option value={NONE}>不选</option>
        {ref !== undefined && !listed && (
          <option value={current}>
            {ref.serviceId} / {ref.model}
          </option>
        )}
        {services.map((s) => (
          <optgroup key={s.id} label={s.name}>
            {s.models.map((m) => (
              <option key={m} value={encode({ serviceId: s.id, model: m })}>
                {s.name} / {m}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {busy && (
        <Loader2
          size={12}
          className="-left-5 absolute top-1/2 -translate-y-1/2 animate-spin text-ink-muted"
        />
      )}
    </span>
  );
}

/** What trying a model found: a short reply, or why it failed. */
function TestResult({ testing, result }: { testing: boolean; result: ModelTest | null }) {
  if (!testing && result === null) return null;
  return (
    <div className="flex items-start gap-1.5 px-4 pb-3 pl-4 text-sm">
      {testing && (
        <>
          <Loader2 size={13} className="mt-[3px] shrink-0 animate-spin text-ink-muted" />
          <span className="text-ink-muted">正在试一下…</span>
        </>
      )}
      {result?.ok === true && (
        <>
          <Check size={13} className="mt-[3px] shrink-0 text-success-text" />
          <span className="selectable min-w-0 break-words text-ink-2">{result.reply}</span>
        </>
      )}
      {result?.ok === false && (
        <>
          <CircleAlert size={13} className="mt-[3px] shrink-0 text-danger-text" />
          <span className="selectable min-w-0 break-words text-danger-text">{result.message}</span>
        </>
      )}
    </div>
  );
}

/** One role: its select, a 试一下 button, and what the try found. */
function RoleRow({
  modelRole,
  title,
  description,
}: {
  modelRole: ModelRole;
  title: string;
  description: string;
}) {
  const ref = useApp((s) => s.models?.roles[modelRole]);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ModelTest | null>(null);
  const test = async (target: ModelRef) => {
    setTesting(true);
    setResult(null);
    const outcome = await call((h) => h.testModel(target));
    setTesting(false);
    if (outcome !== undefined) setResult(outcome);
  };
  return (
    <div>
      <Row
        className="min-h-14"
        title={title}
        description={description}
        trailing={
          <>
            <RoleSelect
              modelRole={modelRole}
              label={`${title}的模型`}
              className="w-56"
              onChosen={(next) => {
                setResult(null);
                if (next !== null) void test(next);
              }}
            />
            <Button
              disabled={ref === undefined || testing}
              onClick={() => {
                if (ref !== undefined) void test(ref);
              }}
            >
              试一下
            </Button>
          </>
        }
      />
      <TestResult testing={testing} result={result} />
    </div>
  );
}

/** The "谁用哪个模型" group of the 模型 page: the Herder and Pi. */
export function RolePicker() {
  const count = useApp((s) => s.models?.services.length ?? 0);
  return (
    <Group>
      <RoleRow
        modelRole="herder"
        title="主管"
        description="在飞书里跟你说话、开任务；用快一点、便宜一点的就够"
      />
      <RoleRow
        modelRole="pi"
        title="Pi"
        description="Pi 干活时默认用的模型；不选就用 Pi 自己的登录和设置"
      />
      {count === 0 && (
        <div className="bg-warning-soft/40 px-4 py-2.5 text-sm text-warning-text">
          还没有模型服务。先在下面添加一个服务，再回来选模型。
        </div>
      )}
    </Group>
  );
}
