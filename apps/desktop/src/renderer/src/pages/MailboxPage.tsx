// 信箱 (ADR 0099, 0100): what comes in from outside before the Herder sees it, and what it does at
// set times. Each source is looked at by code on its own clock; only new letters reach the Herder,
// which tells the owner, keeps them for the morning digest, or just notes them — or, when the owner
// chose so, each one is offered as a task or started. Timers bring their words to the Herder at
// their time. Sources are added by telling the Herder, or here. The pull requests tasks opened are
// listed below; they belong to their tasks.

import type {
  Letter,
  MailboxActChoice,
  MailboxDraft,
  MailboxKind,
  MailboxLetterView,
  MailboxSourceView,
  MailboxView,
  ScheduleWhen,
  SocialPlatform,
} from "@agentherd/host/api";
import {
  AlarmClock,
  Briefcase,
  ExternalLink,
  Flame,
  FlaskConical,
  GitBranch,
  Inbox,
  type LucideIcon,
  Mail,
  MessageCircle,
  Pencil,
  Plus,
  RefreshCw,
  Rss,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal } from "../components/Modal";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Group,
  IconTile,
  inputClass,
  Section,
  Segmented,
  Switch,
} from "../components/ui";
import { PrWatches } from "../components/WatchesSection";
import {
  ACT_CHOICES,
  actText,
  draftOf,
  draftProblem,
  editPatch,
  everyText,
  fateCounts,
  fateOf,
  filterLetters,
  KIND_HINTS,
  KIND_LABELS,
  KIND_ORDER,
  LETTER_FILTERS,
  type LetterFilter,
  PLATFORM_LABELS,
  sourceLine,
  sourceState,
  startsOver,
  suggestedName,
  whatText,
  whenText,
} from "../mailbox";
import { momentText } from "../schedule-text";
import { call, useApp } from "../store";

const ICONS: Record<MailboxKind, LucideIcon> = {
  github: GitBranch,
  work: Briefcase,
  mail: Mail,
  social: MessageCircle,
  rss: Rss,
  hn: Flame,
  script: SquareTerminal,
  timer: AlarmClock,
};

const DAY_NAMES = ["一", "二", "三", "四", "五", "六", "日"];

/** Letters arrive on the host's clock; look again now and then besides the events. */
const REFRESH_MS = 30_000;

function SourceRow({
  source,
  selected,
  onSelect,
  onView,
  onEdit,
}: {
  source: MailboxSourceView;
  selected: boolean;
  onSelect: () => void;
  onView: (v: MailboxView) => void;
  onEdit: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const Icon = ICONS[source.kind];
  const state = sourceState(source);
  const act = actText(source);
  const timer = source.kind === "timer";
  const run = async (action: () => Promise<MailboxView | undefined>) => {
    setBusy(true);
    const v = await action();
    setBusy(false);
    if (v !== undefined) onView(v);
  };
  const remove = () => {
    if (!window.confirm(`删掉来源「${source.name}」？它的信也一起删掉，主管不会再看这里。`)) return;
    void run(() => call((h) => h.mailboxRemove(source.id)));
  };
  return (
    <div className={`flex items-start gap-3 px-4 py-3 ${selected ? "bg-accent-soft/40" : ""}`}>
      <IconTile tone={state.tone === "red" ? "red" : source.paused ? "gray" : "blue"}>
        <Icon size={14} />
      </IconTile>
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onSelect}>
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-ink">{source.name}</span>
          <Badge tone={state.tone}>{state.label}</Badge>
          {act !== undefined && (
            <Badge tone={source.act === "trial" ? "amber" : "blue"}>{act}</Badge>
          )}
        </div>
        <div className="mt-0.5 truncate text-ink-muted text-sm" title={whatText(source)}>
          {KIND_LABELS[source.kind]} · {whatText(source)}
        </div>
        {source.note !== "" && (
          <div className="mt-0.5 truncate text-ink-2 text-sm" title={source.note}>
            {timer ? "到点做：" : "给主管的话："}
            {source.note}
          </div>
        )}
        <div className="mt-0.5 text-ink-dim text-xs">{sourceLine(source)}</div>
        {source.lastError !== undefined && source.fails > 0 && (
          <div className="mt-1 text-danger-text text-sm">{source.lastError}</div>
        )}
      </button>
      <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
        <Button
          variant="ghost"
          size="sm"
          aria-label={timer ? "现在做一次" : "现在看一次"}
          title={timer ? "现在做一次（下次的时间不变）" : "现在看一次"}
          disabled={busy || source.paused}
          onClick={() => void run(() => call((h) => h.mailboxRun(source.id)))}
        >
          <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
        </Button>
        <Switch
          label={source.paused ? "恢复" : "停下"}
          checked={!source.paused}
          disabled={busy}
          onChange={(on) => void run(() => call((h) => h.mailboxSet(source.id, { paused: !on })))}
        />
        <Button
          variant="ghost"
          size="sm"
          aria-label="改"
          title="改这个来源"
          disabled={busy}
          onClick={onEdit}
        >
          <Pencil size={13} />
        </Button>
        <Button variant="ghost" size="sm" aria-label="删除" disabled={busy} onClick={remove}>
          <Trash2 size={13} />
        </Button>
      </div>
    </div>
  );
}

function LetterRow({ letter }: { letter: MailboxLetterView }) {
  const fate = fateOf(letter);
  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {letter.link === undefined ? (
            <span className="truncate font-medium text-ink">{letter.title}</span>
          ) : (
            <a
              href={letter.link}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-w-0 items-center gap-1 truncate font-medium text-ink hover:underline"
              title={letter.link}
            >
              <span className="truncate">{letter.title}</span>
              <ExternalLink size={11} className="shrink-0 text-ink-dim" />
            </a>
          )}
        </div>
        <div className="mt-0.5 text-ink-muted text-sm">
          {letter.source} · {whenText(letter.at)}
        </div>
        {letter.why !== undefined && letter.why !== "" && (
          <div className="mt-0.5 text-ink-2 text-sm">主管：{letter.why}</div>
        )}
      </div>
      <Badge tone={fate.tone}>{fate.label}</Badge>
    </div>
  );
}

const EMPTY_DRAFT: MailboxDraft = {
  kind: "github",
  name: "",
  note: "",
  what: ["issues", "releases"],
};

/** What a kind starts with when it is picked. */
function draftFor(kind: MailboxKind): Partial<MailboxDraft> {
  if (kind === "github") return { what: ["issues", "releases"], act: "sort" };
  if (kind === "work") return { what: ["assigned"], act: "offer" };
  if (kind === "social") return { platform: "xiaohongshu", act: "sort" };
  if (kind === "timer") return { when: { kind: "daily", at: "09:00" }, act: undefined };
  return { act: "sort" };
}

function WhenEditor({
  when,
  onChange,
}: {
  when: ScheduleWhen;
  onChange: (when: ScheduleWhen) => void;
}) {
  const days = when.kind === "daily" ? (when.days ?? [1, 2, 3, 4, 5, 6, 7]) : [];
  const toggleDay = (d: number) => {
    if (when.kind !== "daily") return;
    const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort();
    onChange({ kind: "daily", at: when.at, ...(next.length === 7 ? {} : { days: next }) });
  };
  const [date, clock] = when.kind === "once" ? when.at.split(" ") : ["", ""];
  return (
    <div className="flex flex-col gap-3">
      <Segmented
        label="什么时候"
        options={[
          { value: "daily", label: "每天定时" },
          { value: "every", label: "每隔几小时" },
          { value: "once", label: "只一次" },
        ]}
        value={when.kind}
        onChange={(kind) =>
          onChange(
            kind === "every"
              ? { kind: "every", hours: 3 }
              : kind === "once"
                ? { kind: "once", at: `${tomorrow()} 09:00` }
                : { kind: "daily", at: "09:00" },
          )
        }
      />
      {when.kind === "daily" && (
        <div className="flex flex-wrap items-center gap-4 text-md">
          <input
            className={`${inputClass} w-28`}
            type="time"
            aria-label="几点"
            value={when.at}
            onChange={(e) => onChange({ ...when, at: e.target.value })}
          />
          {DAY_NAMES.map((name, i) => (
            <label key={name} className="flex items-center gap-1 text-ink-2">
              <input
                type="checkbox"
                checked={days.includes(i + 1)}
                onChange={() => toggleDay(i + 1)}
              />
              周{name}
            </label>
          ))}
        </div>
      )}
      {when.kind === "every" && (
        <Field label="每隔几小时" hint="1 到 168 小时；从加上的时候开始算">
          <input
            className={`${inputClass} w-28`}
            type="number"
            min={1}
            max={168}
            value={when.hours}
            onChange={(e) => onChange({ kind: "every", hours: Number(e.target.value) })}
          />
        </Field>
      )}
      {when.kind === "once" && (
        <div className="flex items-center gap-3">
          <input
            className={`${inputClass} w-40`}
            type="date"
            aria-label="哪天"
            value={date}
            onChange={(e) => onChange({ kind: "once", at: `${e.target.value} ${clock}` })}
          />
          <input
            className={`${inputClass} w-28`}
            type="time"
            aria-label="几点"
            value={clock}
            onChange={(e) => onChange({ kind: "once", at: `${date} ${e.target.value}` })}
          />
        </div>
      )}
    </div>
  );
}

/** 「时间没问题，第一次在 11月23日 09:00」 from a timer's try. */
function firstRunText(letter: Letter | undefined): string {
  const next = /next (\S+)$/.exec(letter?.body ?? "")?.[1];
  return next === undefined ? "时间没问题" : `时间没问题，第一次在 ${momentText(next)}`;
}

function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function SourceDialog({
  view,
  source,
  onClose,
  onView,
}: {
  view: MailboxView;
  /** The source to change; none to add a new one. */
  source?: MailboxSourceView;
  onClose: () => void;
  onView: (v: MailboxView) => void;
}) {
  const editing = source !== undefined;
  const [draft, setDraft] = useState<MailboxDraft>(() =>
    source === undefined ? EMPTY_DRAFT : draftOf(source),
  );
  const [named, setNamed] = useState(editing);
  const [busy, setBusy] = useState<"try" | "add" | undefined>();
  const [tried, setTried] = useState<Letter[] | undefined>();
  const set = (patch: Partial<MailboxDraft>) => {
    setTried(undefined);
    setDraft((d) => {
      const next = { ...d, ...patch };
      return named ? next : { ...next, name: suggestedName(next) };
    });
  };
  const problem = draftProblem(draft, view);
  const every = view.every[draft.kind];
  const tryIt = async () => {
    setBusy("try");
    const letters = await call((h) => h.mailboxTry(draft));
    setBusy(undefined);
    if (letters !== undefined) setTried(letters);
  };
  const patch = source === undefined ? undefined : editPatch(source, draft);
  const unchanged = patch !== undefined && Object.keys(patch).length === 0;
  const over = patch !== undefined && source !== undefined && startsOver(patch, source.kind);
  const add = async () => {
    setBusy("add");
    const v =
      source === undefined || patch === undefined
        ? await call((h) => h.mailboxAdd(draft))
        : await call((h) => h.mailboxSet(source.id, patch));
    setBusy(undefined);
    if (v !== undefined) {
      onView(v);
      onClose();
    }
  };
  const what = draft.what ?? [];
  const toggleWhat = (w: "issues" | "prs" | "releases" | "assigned" | "reviews") =>
    set({ what: what.includes(w) ? what.filter((x) => x !== w) : [...what, w] });
  const timer = draft.kind === "timer";
  return (
    <Modal
      title={editing ? `改来源「${source.name}」` : "加一个来源"}
      description={
        editing
          ? over
            ? "看的地方变了：保存后会重新记一遍现在有的，之后来的才交给主管"
            : "改名字、给主管的话或多久看一次，不会重看"
          : timer
            ? "到点把你写的话交给主管去做"
            : "代码按时去看，只有新东西才交给主管"
      }
      onClose={onClose}
      wide
      footer={
        <div className="flex w-full items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-ink-muted text-sm">
            {problem ?? (unchanged ? "还没改什么" : "")}
          </span>
          <Button
            disabled={problem !== undefined || busy !== undefined}
            onClick={() => void tryIt()}
          >
            <FlaskConical size={13} />
            {busy === "try" ? "在看…" : timer ? "看看什么时候跑" : "先试一次"}
          </Button>
          <Button
            variant="primary"
            disabled={problem !== undefined || busy !== undefined || unchanged}
            onClick={() => void add()}
          >
            {busy === "add" ? (editing ? "在存…" : "在加…") : editing ? "保存" : "添加"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className={`grid grid-cols-4 gap-1.5 ${editing ? "hidden" : ""}`}>
          {KIND_ORDER.map((k) => {
            const Icon = ICONS[k];
            return (
              <button
                key={k}
                type="button"
                aria-pressed={draft.kind === k}
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-left text-md ${
                  draft.kind === k
                    ? "border-accent bg-accent-soft/50 text-ink"
                    : "border-line text-ink-2 hover:bg-control-hover"
                }`}
                onClick={() => set({ kind: k, ...draftFor(k) })}
              >
                <Icon size={13} className="shrink-0" />
                <span className="truncate">{KIND_LABELS[k]}</span>
              </button>
            );
          })}
        </div>
        <p className={`${editing ? "" : "-mt-2 "}text-ink-muted text-sm`}>
          {KIND_HINTS[draft.kind]}
        </p>
        {draft.kind === "github" && (
          <>
            <Field label="仓库" hint="owner/name，或者仓库的网址">
              <input
                className={inputClass}
                placeholder="openai/codex"
                value={draft.repo ?? ""}
                onChange={(e) => set({ repo: e.target.value })}
              />
            </Field>
            <div className="flex items-center gap-4 text-md">
              {(
                [
                  ["issues", "新 issue"],
                  ["prs", "新 PR"],
                  ["releases", "发布"],
                ] as const
              ).map(([w, label]) => (
                <label key={w} className="flex items-center gap-1.5 text-ink-2">
                  <input
                    type="checkbox"
                    checked={what.includes(w)}
                    onChange={() => toggleWhat(w)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </>
        )}
        {draft.kind === "work" && (
          <>
            <div className="flex items-center gap-4 text-md">
              {(
                [
                  ["assigned", "派给你的 issue"],
                  ["reviews", "请你评审的 PR"],
                ] as const
              ).map(([w, label]) => (
                <label key={w} className="flex items-center gap-1.5 text-ink-2">
                  <input
                    type="checkbox"
                    checked={what.includes(w)}
                    onChange={() => toggleWhat(w)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="只看这个仓库（可以不填）">
                <input
                  className={inputClass}
                  placeholder="openai/codex"
                  value={draft.repo ?? ""}
                  onChange={(e) => set({ repo: e.target.value })}
                />
              </Field>
              <Field label="只看这个标签（可以不填）">
                <input
                  className={inputClass}
                  placeholder="good first issue"
                  value={draft.label ?? ""}
                  onChange={(e) => set({ label: e.target.value })}
                />
              </Field>
            </div>
          </>
        )}
        {draft.kind === "mail" && (
          <Field label="Gmail 搜索条件" hint="和 Gmail 搜索框里写法一样；只看加上以后来的信">
            <input
              className={inputClass}
              placeholder="from:li@uni.edu"
              value={draft.query ?? ""}
              onChange={(e) => set({ query: e.target.value })}
            />
          </Field>
        )}
        {draft.kind === "social" && (
          <Segmented
            label="哪个平台"
            options={(["xiaohongshu", "zhihu"] as const).map((p) => ({
              value: p,
              label: PLATFORM_LABELS[p] ?? p,
            }))}
            value={draft.platform ?? "xiaohongshu"}
            onChange={(platform: SocialPlatform) => set({ platform })}
          />
        )}
        {timer && (
          <WhenEditor
            when={draft.when ?? { kind: "daily", at: "09:00" }}
            onChange={(when) => set({ when })}
          />
        )}
        {draft.kind === "rss" && (
          <Field label="订阅地址">
            <input
              className={inputClass}
              placeholder="https://example.com/feed.xml"
              value={draft.url ?? ""}
              onChange={(e) => set({ url: e.target.value })}
            />
          </Field>
        )}
        {(draft.kind === "github" || draft.kind === "rss" || draft.kind === "hn") && (
          <Field
            label={draft.kind === "hn" ? "要搜的词" : "只要带这些词的（可以不填）"}
            hint={draft.kind === "hn" ? undefined : "用逗号隔开，带其中一个就算"}
          >
            <input
              className={inputClass}
              placeholder={draft.kind === "hn" ? "agent memory" : "crash, macOS"}
              value={draft.words ?? ""}
              onChange={(e) => set({ words: e.target.value })}
            />
          </Field>
        )}
        {draft.kind === "hn" && (
          <Field label="至少多少分（可以不填）">
            <input
              className={inputClass}
              type="number"
              min={0}
              value={draft.points ?? ""}
              onChange={(e) =>
                set({ points: e.target.value === "" ? undefined : Number(e.target.value) })
              }
            />
          </Field>
        )}
        {draft.kind === "script" && (
          <>
            <Field
              label="命令"
              hint='从标准输入读 {"state": 上次留下的}，打印 {"letters":[{"id","title","body","link"}],"state":…}；没有新东西就打印空列表'
            >
              <input
                className={`${inputClass} font-mono`}
                placeholder="python3 ~/bin/check-prices.py"
                value={draft.command ?? ""}
                onChange={(e) => set({ command: e.target.value })}
              />
            </Field>
            <Field label="在哪个文件夹运行（可以不填）">
              <input
                className={inputClass}
                placeholder="~"
                value={draft.cwd ?? ""}
                onChange={(e) => set({ cwd: e.target.value === "" ? undefined : e.target.value })}
              />
            </Field>
          </>
        )}
        <Field
          label={timer ? "到点要主管做什么" : "给主管的话"}
          hint={
            timer
              ? "主管每次都会照这句话去做，每次都会用一次模型"
              : "你在意这里的什么，主管每封信都会拿这句话来判断"
          }
        >
          <textarea
            className={`${inputClass} min-h-16`}
            placeholder={
              timer ? "看看昨晚的任务有没有卡住的" : "macOS 上崩溃的问题马上告诉我，其他的早上汇总"
            }
            value={draft.note ?? ""}
            onChange={(e) => set({ note: e.target.value })}
          />
        </Field>
        {!timer && (
          <Segmented
            label="新信怎么处理"
            options={ACT_CHOICES.map((a) => ({ value: a.value, label: a.label }))}
            value={draft.act ?? (draft.kind === "work" ? "offer" : "sort")}
            onChange={(act: MailboxActChoice) => set({ act })}
          />
        )}
        {!timer && (
          <p className="-mt-2 text-ink-muted text-sm">
            {
              ACT_CHOICES.find(
                (a) => a.value === (draft.act ?? (draft.kind === "work" ? "offer" : "sort")),
              )?.hint
            }
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="名字">
            <input
              className={inputClass}
              value={draft.name}
              onChange={(e) => {
                setNamed(true);
                setDraft((d) => ({ ...d, name: e.target.value }));
              }}
            />
          </Field>
          {!timer && (
            <Field
              label="多久看一次（分钟）"
              hint={`最快${everyText(every.min)}，默认${everyText(every.default)}`}
            >
              <input
                className={inputClass}
                type="number"
                min={every.min}
                placeholder={String(every.default)}
                value={draft.everyMinutes ?? ""}
                onChange={(e) =>
                  set({ everyMinutes: e.target.value === "" ? undefined : Number(e.target.value) })
                }
              />
            </Field>
          )}
        </div>
        {tried !== undefined && (
          <div className="rounded-md bg-control-hover px-3 py-2.5 text-sm">
            {timer ? (
              <span className="text-ink-2">{firstRunText(tried[0])}</span>
            ) : tried.length === 0 ? (
              <span className="text-ink-2">能看到，现在没有东西。</span>
            ) : (
              <>
                <div className="mb-1 text-ink-2">
                  能看到，现在有 {tried.length} 条。
                  {editing && !over
                    ? "保存不会重看，以后新来的才交给主管："
                    : "保存以后第一次只记下这些，之后来的才会交给主管："}
                </div>
                <ul className="flex flex-col gap-0.5 text-ink-muted">
                  {tried.slice(0, 6).map((l) => (
                    <li key={l.id} className="truncate">
                      · {l.title}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

export function MailboxPage() {
  const view = useApp((s) => s.mailbox);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<LetterFilter>("all");
  const [sourceId, setSourceId] = useState<string | undefined>();
  const [editingId, setEditingId] = useState<string | undefined>();
  const setView = useCallback((v: MailboxView) => useApp.setState({ mailbox: v }), []);
  useEffect(() => {
    const load = () => void call((h) => h.mailbox()).then((v) => v !== undefined && setView(v));
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [setView]);
  const shown = useMemo(
    () => filterLetters(view?.letters ?? [], filter, sourceId),
    [view, filter, sourceId],
  );
  const counts = useMemo(
    () => fateCounts(filterLetters(view?.letters ?? [], "all", sourceId)),
    [view, sourceId],
  );
  if (view === undefined) return null;
  if (!view.on) {
    return (
      <Group>
        <EmptyState
          icon={<Inbox size={18} />}
          text="连上飞书、AgentHerd 开始工作后，就能在这里加来源，看主管怎么处理每一封信。"
        />
      </Group>
    );
  }
  const selected = view.sources.find((s) => s.id === sourceId);
  const editing = view.sources.find((s) => s.id === editingId);
  return (
    <div className="flex flex-col gap-7">
      <Section
        title="来源"
        hint={`代码按时去看，第一次只记下已有的，之后只把新的交给主管。主管觉得要紧的马上告诉你，其余的每天 ${view.digestHour} 点汇总一次。定时的事到点交给主管去做。`}
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus size={13} />
            加一个来源
          </Button>
        }
      >
        <Group>
          {view.sources.length === 0 ? (
            <EmptyState
              icon={<Inbox size={18} />}
              text="还没有来源。跟主管说「帮我盯一下 openai/codex 的新 issue」「每天早上 9 点看看有没有新 issue」，或者点「加一个来源」。"
            />
          ) : (
            view.sources.map((s) => (
              <SourceRow
                key={s.id}
                source={s}
                selected={s.id === sourceId}
                onSelect={() => setSourceId(s.id === sourceId ? undefined : s.id)}
                onView={setView}
                onEdit={() => setEditingId(s.id)}
              />
            ))
          )}
        </Group>
      </Section>
      <Section
        title={selected === undefined ? "信" : `信 · ${selected.name}`}
        hint="每封信主管怎么处理的、为什么"
        actions={
          selected === undefined ? undefined : (
            <Button variant="ghost" size="sm" onClick={() => setSourceId(undefined)}>
              看全部来源
            </Button>
          )
        }
      >
        <Segmented
          label="按处理结果看"
          options={LETTER_FILTERS.map((f) => ({
            value: f.value,
            label: `${f.label} ${counts[f.value]}`,
          }))}
          value={filter}
          onChange={setFilter}
        />
        <Group>
          {shown.length === 0 ? (
            <EmptyState
              icon={<Inbox size={18} />}
              text={
                view.letters.length === 0
                  ? "还没有信。来源第一次只记下已有的，之后来了新的才会出现在这里。"
                  : "这一类还没有信。"
              }
            />
          ) : (
            shown.map((l) => <LetterRow key={l.id} letter={l} />)
          )}
        </Group>
      </Section>
      <PrWatches />
      {adding && <SourceDialog view={view} onClose={() => setAdding(false)} onView={setView} />}
      {editing !== undefined && (
        <SourceDialog
          key={editing.id}
          view={view}
          source={editing}
          onClose={() => setEditingId(undefined)}
          onView={setView}
        />
      )}
    </div>
  );
}
