// 模型分档 on the 模型 page: the owner's models in three tiers, rearranged by dragging (ADR 0028).
// The Herder picks a tier from what the task is, and prefers models higher in a tier.

import type { ModelTiersView, Tier, TierModelView } from "@agentherd/host/api";
import { GripVertical } from "lucide-react";
import { type DragEvent, useEffect, useState } from "react";
import { call, useApp } from "../store";
import { Button, Section } from "./ui";

const COLUMNS: { tier: Tier; title: string; hint: string }[] = [
  { tier: "strong", title: "最强", hint: "难题、大改动、架构设计、疑难 bug" },
  { tier: "balanced", title: "均衡", hint: "普通功能开发、修 bug、写测试" },
  { tier: "fast", title: "便宜快", hint: "小改动、查资料、改文案、跑命令" },
];

type Board = ModelTiersView["tiers"];

/** Where a dragged model would land: before `index` in `tier`. */
interface DropAt {
  tier: Tier;
  index: number;
}

function move(board: Board, model: string, to: DropAt): Board {
  const next = { strong: [...board.strong], balanced: [...board.balanced], fast: [...board.fast] };
  let item: TierModelView | undefined;
  let index = to.index;
  for (const tier of Object.keys(next) as Tier[]) {
    const at = next[tier].findIndex((m) => m.model === model);
    if (at < 0) continue;
    [item] = next[tier].splice(at, 1);
    if (tier === to.tier && at < index) index -= 1;
  }
  if (item === undefined) return board;
  next[to.tier].splice(index, 0, { ...item, auto: false });
  return next;
}

export function ModelTiers() {
  const models = useApp((s) => s.models);
  const [view, setView] = useState<ModelTiersView | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<DropAt | null>(null);

  // Reload when the model list changes: added models appear in their tier by name.
  useEffect(() => {
    void models;
    void call((h) => h.modelTiers()).then((v) => {
      if (v !== undefined) setView(v);
    });
  }, [models]);

  const save = async (board: Board | null) => {
    const tiers =
      board === null
        ? null
        : {
            strong: board.strong.map((m) => m.model),
            balanced: board.balanced.map((m) => m.model),
            fast: board.fast.map((m) => m.model),
          };
    const v = await call((h) => h.setModelTiers(tiers));
    if (v !== undefined) setView(v);
  };

  if (view === null) return null;
  const total = view.tiers.strong.length + view.tiers.balanced.length + view.tiers.fast.length;

  const drop = (e: DragEvent, at: DropAt) => {
    e.preventDefault();
    const model = e.dataTransfer.getData("text/plain") || dragging;
    setDragging(null);
    setOver(null);
    if (!model) return;
    const board = move(view.tiers, model, at);
    setView({ tiers: board, custom: true });
    void save(board);
  };

  const allowDrop = (e: DragEvent, at: DropAt) => {
    if (dragging === null) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    if (over?.tier !== at.tier || over.index !== at.index) setOver(at);
  };

  return (
    <Section
      title="模型分档"
      hint="主管按任务的难易挑一档，同一档里优先用上面的。拖动模型可以换档、调顺序；新加的模型会按名字自动归档，认不出的放进「均衡」。"
      actions={
        view.custom ? (
          <Button size="sm" variant="ghost" onClick={() => void save(null)}>
            恢复自动分档
          </Button>
        ) : undefined
      }
    >
      {total === 0 ? (
        <p className="rounded-card border border-line border-dashed px-4 py-6 text-center text-ink-muted text-sm">
          添加模型服务后，模型会出现在这里。
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {COLUMNS.map(({ tier, title, hint }) => {
            const list = view.tiers[tier];
            const end = { tier, index: list.length };
            return (
              <section
                key={tier}
                aria-label={title}
                className={`flex min-h-40 flex-col gap-1.5 rounded-card border bg-inset p-2.5 transition-colors ${
                  over?.tier === tier ? "border-accent" : "border-line"
                }`}
                onDragOver={(e) => allowDrop(e, end)}
                onDrop={(e) => drop(e, over?.tier === tier ? over : end)}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
                }}
              >
                <header className="px-1 pb-1">
                  <div className="flex items-center gap-2">
                    <h4 className="font-medium text-ink">{title}</h4>
                    <span className="text-ink-dim text-xs">{list.length}</span>
                  </div>
                  <p className="text-ink-muted text-xs">{hint}</p>
                </header>
                {/* Each tier scrolls on its own so a long list does not stretch the page. */}
                <div className="-mr-1.5 flex max-h-80 flex-col gap-1.5 overflow-y-auto pr-1.5">
                  {list.map((m, index) => (
                    <div key={m.model}>
                      {over?.tier === tier && over.index === index && dragging !== m.model && (
                        <div className="mb-1.5 h-0.5 rounded bg-accent" />
                      )}
                      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drag handle; dragging has no keyboard equivalent here */}
                      <div
                        draggable
                        title={`${m.model}：${m.services.join("、")}`}
                        onDragStart={(e) => {
                          e.dataTransfer.setData("text/plain", m.model);
                          e.dataTransfer.effectAllowed = "move";
                          setDragging(m.model);
                        }}
                        onDragEnd={() => {
                          setDragging(null);
                          setOver(null);
                        }}
                        onDragOver={(e) => {
                          const box = e.currentTarget.getBoundingClientRect();
                          const after = e.clientY > box.top + box.height / 2;
                          allowDrop(e, { tier, index: after ? index + 1 : index });
                        }}
                        className={`flex cursor-grab items-center gap-2 rounded-md bg-surface px-2 py-1.5 ring-1 ring-line active:cursor-grabbing ${
                          dragging === m.model ? "opacity-40" : ""
                        }`}
                      >
                        <GripVertical size={14} className="shrink-0 text-ink-dim" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-mono text-ink text-sm">{m.model}</div>
                          <div className="truncate text-ink-muted text-xs">
                            {m.services.join(" · ")}
                          </div>
                        </div>
                        {m.auto && (
                          <span className="shrink-0 text-ink-dim text-xs" title="按名字自动归档">
                            自动
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                  {over?.tier === tier && over.index === list.length && (
                    <div className="h-0.5 rounded bg-accent" />
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </Section>
  );
}
