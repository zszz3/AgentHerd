// The conversation of one task: what AgentHerd sent the agent, its replies and its tool calls.
// Polls the host while open, so a running task updates on its own.

import { Check, ChevronRight, Loader2, Terminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { host, type Task, type TranscriptView } from "../store";
import { hhmm, STAGE_LABEL } from "./labels";
import { Markdown } from "./Markdown";
import { Modal } from "./Modal";
import { Badge } from "./ui";

/** How often an open transcript asks for new lines. */
const POLL_MS = 1500;

function ToolStatus({ status }: { status?: string }) {
  if (status === "completed") return <Check size={13} className="shrink-0 text-success-text" />;
  if (status === "failed") return <X size={13} className="shrink-0 text-danger-text" />;
  return <Loader2 size={13} className="shrink-0 animate-spin text-ink-muted" />;
}

/** A command without a leading `cd <folder> &&`: the task's folder says nothing new. */
export function shortCommand(text: string): string {
  return text.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/, "");
}

/** A tool call: one line; a click shows the whole command. */
function ToolEntry({ text, status }: { text: string; status?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => setOpen(!open)}
      className="flex w-full items-start gap-2 rounded-md bg-inset px-2.5 py-1.5 text-left hover:bg-control-hover"
    >
      <ChevronRight
        size={13}
        className={`mt-[3px] shrink-0 text-ink-muted transition-transform duration-150 ${open ? "rotate-90" : ""}`}
      />
      <Terminal size={13} className="mt-[3px] shrink-0 text-ink-muted" />
      <span
        className={`selectable min-w-0 flex-1 font-mono text-ink-2 text-sm ${
          open ? "whitespace-pre-wrap break-all" : "truncate"
        }`}
      >
        {open ? text : shortCommand(text).split("\n")[0]}
      </span>
      <span className="mt-[3px]">
        <ToolStatus status={status} />
      </span>
    </button>
  );
}

/** The labelled parts AgentHerd puts in what it sends an agent, and how the app names them. */
const PROMPT_PARTS: readonly { label: string; name: string; main: boolean }[] = [
  { label: "[Owner's message]", name: "你说的", main: true },
  { label: "[Message from the Herder, not from the owner]", name: "主管转达", main: true },
  { label: "[Context added by the Herder, for reference]", name: "主管补充的背景", main: false },
];

interface PromptPart {
  name: string;
  main: boolean;
  text: string;
}

/** Splits a prompt at its label lines; text without a label is shown as it is. */
export function promptParts(text: string): PromptPart[] {
  const parts: PromptPart[] = [];
  let current: PromptPart | undefined;
  for (const line of text.split("\n")) {
    const known = PROMPT_PARTS.find((p) => line.trim() === p.label);
    const hint = line.startsWith("[AgentHerd] ");
    if (known !== undefined || hint) {
      current = known
        ? { name: known.name, main: known.main, text: "" }
        : { name: "AgentHerd 的说明", main: false, text: line.slice("[AgentHerd] ".length) };
      parts.push(current);
      continue;
    }
    if (current === undefined) {
      current = { name: "", main: true, text: "" };
      parts.push(current);
    }
    current.text = current.text === "" ? line : `${current.text}\n${line}`;
  }
  return parts.map((p) => ({ ...p, text: p.text.trim() })).filter((p) => p.text !== "");
}

/** What AgentHerd sent the agent: the owner's or Herder's words, with the added context folded. */
function PromptEntry({ text, at }: { text: string; at: string }) {
  const parts = promptParts(text);
  const main = parts.filter((p) => p.main);
  const extra = parts.filter((p) => !p.main);
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col items-end gap-1">
      <span className="text-ink-muted text-xs">发给 Agent · {hhmm(at)}</span>
      <div className="selectable max-w-[85%] break-words rounded-lg bg-accent-soft px-3 py-2 text-ink text-md">
        {main.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder
          <div key={i} className={i > 0 ? "mt-2" : undefined}>
            {p.name !== "" && main.length + extra.length > 1 && (
              <div className="text-ink-muted text-xs">{p.name}</div>
            )}
            <div className="whitespace-pre-wrap">{p.text}</div>
          </div>
        ))}
        {extra.length > 0 && (
          <>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className="mt-1.5 flex items-center gap-1 text-accent-text text-sm hover:underline"
            >
              <ChevronRight
                size={13}
                className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`}
              />
              {extra.map((p) => p.name).join("、")}
            </button>
            {open &&
              extra.map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder
                <div key={i} className="mt-1.5 whitespace-pre-wrap text-ink-2 text-sm">
                  {extra.length > 1 && <div className="text-ink-muted text-xs">{p.name}</div>}
                  {p.text}
                </div>
              ))}
          </>
        )}
      </div>
    </div>
  );
}

type TranscriptEntry = TranscriptView["entries"][number];

/** Runs of at least this many tool calls in a row fold into one line. */
const TOOL_RUN_FOLD = 3;

/** Several tool calls in a row: one line with the count; a click lists them. */
function ToolRun({ entries }: { entries: readonly TranscriptEntry[] }) {
  const [open, setOpen] = useState(false);
  const last = entries[entries.length - 1];
  const failed = entries.filter((e) => e.status === "failed").length;
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-ink-muted text-sm hover:text-ink"
      >
        <ChevronRight
          size={13}
          className={`shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
        <Terminal size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          执行了 {entries.length} 个操作
          {failed > 0 && <span className="text-danger-text">，{failed} 个失败</span>}
          {!open && last !== undefined && (
            <span className="font-mono text-ink-dim">
              {" "}
              · {shortCommand(last.text).split("\n")[0]}
            </span>
          )}
        </span>
        <ToolStatus status={last?.status} />
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 border-line border-l pl-3">
          {entries.map((e) => (
            <ToolEntry key={e.id} text={e.text} status={e.status} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The transcript as rows: runs of tool calls grouped, the rest one by one. */
function rows(entries: readonly TranscriptEntry[]): (TranscriptEntry | TranscriptEntry[])[] {
  const out: (TranscriptEntry | TranscriptEntry[])[] = [];
  let run: TranscriptEntry[] = [];
  const flush = () => {
    if (run.length >= TOOL_RUN_FOLD) out.push(run);
    else out.push(...run);
    run = [];
  };
  for (const e of entries) {
    if (e.role === "tool") run.push(e);
    else {
      flush();
      out.push(e);
    }
  }
  flush();
  return out;
}

function Entry({ entry }: { entry: TranscriptEntry }) {
  switch (entry.role) {
    case "prompt":
      return <PromptEntry text={entry.text} at={entry.at} />;
    case "agent":
      return <Markdown text={entry.text} className="text-ink text-md leading-relaxed" />;
    case "tool":
      return <ToolEntry text={entry.text} status={entry.status} />;
    default:
      return <div className="selectable text-center text-ink-muted text-sm">{entry.text}</div>;
  }
}

export function TaskTranscript({ task, onClose }: { task: Task; onClose: () => void }) {
  const [view, setView] = useState<TranscriptView | undefined>();
  const [failed, setFailed] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const next = await host().transcript(task.id);
        if (!stopped) {
          setView(next);
          setFailed(false);
        }
      } catch {
        if (!stopped) setFailed(true);
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [task.id]);

  // Follow new lines while the owner is at the bottom; leave them alone when they scrolled up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever the transcript changes
  useEffect(() => {
    const el = scroller.current;
    if (el !== null && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [view]);

  const stage = STAGE_LABEL[task.stage];
  const entries = view?.entries ?? [];
  const live = view?.live ?? "";
  return (
    <Modal
      size="large"
      title={task.title}
      description={
        <span className="flex items-center gap-2">
          <Badge tone={stage.tone}>{stage.text}</Badge>
          {task.project} · {task.agent}
        </span>
      }
      onClose={onClose}
    >
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1 pb-2"
      >
        {view === undefined && !failed && <p className="text-ink-muted text-md">加载中…</p>}
        {failed && <p className="text-ink-muted text-md">读不到对话，稍后再试。</p>}
        {view !== undefined && entries.length === 0 && live === "" && (
          <p className="text-ink-muted text-md">
            还没有对话记录。这个功能上线前开始的任务没有记录。
          </p>
        )}
        {rows(entries).map((r) =>
          Array.isArray(r) ? (
            <ToolRun key={r[0]?.id} entries={r} />
          ) : (
            <Entry key={r.id} entry={r} />
          ),
        )}
        {live !== "" && (
          <div>
            <Markdown text={live} className="text-ink text-md leading-relaxed" />
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-ink-muted align-middle" />
          </div>
        )}
      </div>
    </Modal>
  );
}
