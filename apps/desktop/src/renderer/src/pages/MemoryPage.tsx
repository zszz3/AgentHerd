// 记忆: what the Herder remembers (ADR 0038), by kind. The owner can change the text of an entry,
// forget it, or bring a forgotten one back. The same as /记忆 /忘掉 /恢复 in Feishu. The owner's
// profile card comes first and shows every field, filled or not (ADR 0091).

import type { MemoryView } from "@agentherd/host/api";
import { Brain, Pencil, RotateCcw, Trash2, UserRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, EmptyState, Group, Section } from "../components/ui";
import { pathLeaf } from "../platform";
import { PROFILE_LABELS, type ProfileRow, profileRows } from "../profile";
import { call } from "../store";

type Entry = MemoryView["entries"][number];

const KINDS: readonly { kind: Entry["kind"]; label: string; hint: string }[] = [
  { kind: "owner", label: "关于你", hint: "你说过要一直这样的事，主管每次都会看" },
  {
    kind: "decision",
    label: "定了的事",
    hint: "你拍过板的事和定了不做的事，带着原话；主管和每个新任务都会照做，不再问你",
  },
  { kind: "note", label: "主管笔记", hint: "主管自己记下的环境和做法，相关时会参考" },
  { kind: "person", label: "人", hint: "你提到的人和他们负责什么" },
  { kind: "project", label: "项目", hint: "项目是什么、谁负责；路径只当线索" },
  { kind: "experience", label: "经验", hint: "从做过的任务里总结的做法，开新任务时会参考" },
  { kind: "case", label: "案例", hint: "旧版本留下的任务记录，不再新增" },
];

const SOURCE: Record<Entry["source"], string> = {
  said: "你说的",
  noticed: "主管记的",
  task: "任务总结",
  review: "回顾对话",
  owner_edit: "你改过",
};

function day(iso: string): string {
  return iso.slice(5, 10).replace("-", "/");
}

function projectName(scope: string): string | undefined {
  if (!scope.startsWith("project:")) return undefined;
  return pathLeaf(scope.slice("project:".length));
}

function ProfileField({ row, onChange }: { row: ProfileRow; onChange: (v: MemoryView) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(row.value);
  const { label, empty } = PROFILE_LABELS[row.field];
  const save = async (value: string) => {
    const saved = await call((h) => h.setProfile(row.field, value));
    if (saved === undefined) return;
    const v = await call((h) => h.memories());
    if (v !== undefined) onChange(v);
    setEditing(false);
  };
  return (
    <div className="flex flex-col gap-1 px-4 py-2.5">
      <div className="flex items-center gap-3">
        <span className="w-[88px] shrink-0 text-ink-muted text-sm">{label}</span>
        {editing ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void save(text);
            }}
          >
            <input
              className="ah-input h-8 min-w-0 flex-1"
              value={text}
              maxLength={60}
              aria-label={label}
              autoFocus
              onChange={(e) => setText(e.target.value)}
            />
            <Button variant="primary" size="sm" type="submit">
              保存
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setText(row.value);
                setEditing(false);
              }}
            >
              取消
            </Button>
          </form>
        ) : (
          <>
            <span
              className={`min-w-0 flex-1 text-md ${row.value === "" ? "text-ink-dim" : "text-ink"}`}
            >
              {row.value === "" ? empty : row.value}
            </span>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                aria-label={`修改${label}`}
                onClick={() => {
                  setText(row.value);
                  setEditing(true);
                }}
              >
                <Pencil size={13} />
              </Button>
              {row.value !== "" && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`清空${label}`}
                  onClick={() => void save("")}
                >
                  <Trash2 size={13} />
                </Button>
              )}
            </div>
          </>
        )}
      </div>
      {row.entry !== undefined && !editing && (
        <div className="flex flex-wrap items-center gap-1.5 pl-[100px] text-ink-muted text-xs">
          <Badge>{SOURCE[row.entry.source]}</Badge>
          <span>{day(row.entry.updatedAt)}</span>
          {row.entry.evidence !== undefined && (
            <span className="min-w-0 truncate">· 依据：「{row.entry.evidence}」</span>
          )}
        </div>
      )}
    </div>
  );
}

function EntryRow({ entry, onChange }: { entry: Entry; onChange: (v: MemoryView) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(entry.abstract);
  const [open, setOpen] = useState(false);
  const project = projectName(entry.scope);
  const save = async () => {
    const v = await call((h) => h.editMemory(entry.id, text));
    if (v !== undefined) {
      onChange(v);
      setEditing(false);
    }
  };
  const forget = async () => {
    const v = await call((h) => h.forgetMemory(entry.id));
    if (v !== undefined) onChange(v);
  };
  return (
    <div className="flex flex-col gap-1.5 px-4 py-2.5">
      {editing ? (
        <div className="flex items-start gap-2">
          <textarea
            className="min-h-16 flex-1 resize-y rounded-md border border-line-strong bg-control px-2 py-1.5 text-ink text-md outline-none focus:border-accent"
            value={text}
            maxLength={200}
            aria-label="记忆内容"
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex flex-col gap-1.5">
            <Button variant="primary" size="sm" onClick={() => void save()}>
              保存
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setText(entry.abstract);
                setEditing(false);
              }}
            >
              取消
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <button
            type="button"
            className="min-w-0 flex-1 text-left text-ink text-md"
            disabled={entry.body === "" && entry.evidence === undefined}
            onClick={() => setOpen(!open)}
            title={entry.body === "" ? undefined : "展开详情"}
          >
            {entry.abstract}
          </button>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="sm" aria-label="修改" onClick={() => setEditing(true)}>
              <Pencil size={13} />
            </Button>
            <Button variant="ghost" size="sm" aria-label="忘掉" onClick={() => void forget()}>
              <Trash2 size={13} />
            </Button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-ink-muted text-xs">
        <Badge>{SOURCE[entry.source]}</Badge>
        {project !== undefined && <Badge tone="blue">{project}</Badge>}
        {entry.scope === "global" && (entry.kind === "experience" || entry.kind === "case") && (
          <Badge tone="green">通用</Badge>
        )}
        {entry.until !== undefined && <Badge tone="amber">到 {entry.until}</Badge>}
        <span>{day(entry.createdAt)}</span>
        {entry.accessCount > 0 && <span>· 用过 {entry.accessCount} 次</span>}
      </div>
      {open && (
        <div className="whitespace-pre-wrap rounded-md bg-control-hover px-3 py-2 text-ink-2 text-sm">
          {entry.evidence !== undefined && <div>依据：「{entry.evidence}」</div>}
          {entry.body}
        </div>
      )}
    </div>
  );
}

export function MemoryPage() {
  const [view, setView] = useState<MemoryView | undefined>();
  const load = useCallback(async () => {
    const v = await call((h) => h.memories());
    if (v !== undefined) setView(v);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (view === undefined) return null;
  if (!view.ready) {
    return (
      <Group>
        <EmptyState
          icon={<Brain size={18} />}
          text="连上飞书、AgentHerd 开始工作后，这里会显示主管记住的东西。"
        />
      </Group>
    );
  }
  const others = view.entries.filter((e) => e.kind !== "profile");
  return (
    <div className="flex flex-col gap-6">
      <Section
        title="你的画像"
        hint="主管从聊天里看出来的你：怎么称呼、在做什么、习惯和喜好。每次都会看，不对就改"
        actions={
          <span className="flex items-center gap-1 text-ink-muted text-xs">
            <UserRound size={12} />
            {view.used.profile}/{view.caps.profile} 字
          </span>
        }
      >
        <Group>
          {profileRows(view.entries).map((row) => (
            <ProfileField
              key={`${row.field}-${row.entry?.id ?? ""}`}
              row={row}
              onChange={setView}
            />
          ))}
        </Group>
      </Section>
      {others.length === 0 && view.deleted.length === 0 && (
        <Group>
          <EmptyState
            icon={<Brain size={18} />}
            title="主管还没记住别的"
            text="你在飞书里说「以后都…」「记住…」，或者任务做完后，主管会把值得长期记住的写在这里。"
          />
        </Group>
      )}
      {KINDS.map(({ kind, label, hint }) => {
        const rows = view.entries.filter((e) => e.kind === kind);
        if (rows.length === 0) return null;
        const cap =
          kind === "owner" || kind === "decision" || kind === "note" ? view.caps[kind] : undefined;
        return (
          <Section
            key={kind}
            title={label}
            hint={hint}
            actions={
              cap === undefined ? undefined : (
                <span className="text-ink-muted text-xs">
                  {view.used[kind as keyof MemoryView["used"]]}/{cap} 字
                </span>
              )
            }
          >
            <Group>
              {rows.map((e) => (
                <EntryRow key={`${e.id}-${e.rev}`} entry={e} onChange={setView} />
              ))}
            </Group>
          </Section>
        );
      })}
      {view.deleted.length > 0 && (
        <Section title="最近忘掉的" hint="点恢复就能找回">
          <Group>
            {view.deleted.map((e) => (
              <div key={e.id} className="flex items-center gap-3 px-4 py-2">
                <span className="min-w-0 flex-1 truncate text-ink-muted text-md line-through">
                  {e.abstract}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void call((h) => h.restoreMemory(e.id)).then((v) => v && setView(v))
                  }
                >
                  <RotateCcw size={13} />
                  恢复
                </Button>
              </div>
            ))}
          </Group>
        </Section>
      )}
    </div>
  );
}
