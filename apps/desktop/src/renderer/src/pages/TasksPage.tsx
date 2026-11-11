// 任务: tasks only, grouped by what the owner should do about them. An open request shows inside
// its task; a request whose task the board does not have goes to 其他请求 at the top.

import { AlertTriangle, ChevronRight, ListTodo } from "lucide-react";
import { type ReactNode, useState } from "react";
import { hhmm, RISK_LABEL, STAGE_LABEL, STAGE_ORDER } from "../components/labels";
import { TaskTranscript } from "../components/TaskTranscript";
import { Badge, Dot, EmptyState, Group, Section, Segmented, type Tone } from "../components/ui";
import { devOpen } from "../dev-bridge";
import { plainText } from "../markdown";
import { type ItemSummary, type Task, useApp } from "../store";

type Filter = "all" | "owner" | "active";

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "owner", label: "等你处理" },
  { value: "active", label: "进行中" },
];

const FILTER_EMPTY: Record<Filter, string> = {
  all: "",
  owner: "现在没有等你处理的任务。",
  active: "现在没有进行中的任务。",
};

function projectOf(cwd: string): string {
  return cwd.split("/").filter(Boolean).at(-1) ?? cwd;
}

/** A dot, a title with the time on the right, one line of details, and open requests below. */
function BoardRow({
  dot,
  pulse = false,
  title,
  badge,
  time,
  details,
  items,
  onOpen,
}: {
  dot: Tone;
  pulse?: boolean;
  title: string;
  badge?: ReactNode;
  time: string;
  details: readonly string[];
  items: readonly ItemSummary[];
  /** Opens the task's conversation; rows without one are not clickable. */
  onOpen?: () => void;
}) {
  const line = details.filter((d) => d !== "");
  const body = (
    <>
      <span className="flex h-[18px] items-center">
        <Dot tone={dot} pulse={pulse} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-ink" title={title}>
            {title}
          </span>
          {badge}
          <span className="ml-auto shrink-0 text-ink-muted text-sm tabular-nums" title={time}>
            {hhmm(time)}
          </span>
        </div>
        <div className="selectable mt-0.5 truncate text-ink-muted text-sm" title={line.join(" · ")}>
          {line.join(" · ")}
        </div>
        {items.length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            {items.map((item) => (
              <RequestLine key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>
    </>
  );
  if (onOpen === undefined) return <div className="flex items-start gap-3 px-4 py-2.5">{body}</div>;
  return (
    <button
      type="button"
      onClick={onOpen}
      title="查看对话"
      className="flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-hover"
    >
      {body}
    </button>
  );
}

function RequestLine({ item }: { item: ItemSummary }) {
  const risk = RISK_LABEL[item.risk];
  return (
    <div className="flex min-h-7 items-center gap-2 rounded-md bg-inset py-1 pr-2.5 pl-1.5">
      <Badge tone={risk.tone}>{risk.text}</Badge>
      <span
        className="selectable min-w-0 flex-1 truncate font-mono text-ink-2 text-sm"
        title={`${item.title}\n${item.body}`}
      >
        {item.body === "" ? item.title : item.body}
      </span>
    </div>
  );
}

function TaskRow({
  task,
  items,
  onOpen,
}: {
  task: Task;
  items: readonly ItemSummary[];
  onOpen: (task: Task) => void;
}) {
  const stage = STAGE_LABEL[task.stage];
  // The group already says the stage; a badge only tells apart stages that share a group.
  const badge =
    task.stage === "queued" || task.stage === "failed" ? (
      <Badge tone={stage.tone}>{stage.text}</Badge>
    ) : undefined;
  return (
    <BoardRow
      dot={items.length > 0 ? "amber" : stage.tone}
      pulse={task.stage === "working"}
      title={task.title}
      badge={badge}
      time={task.updatedAt}
      details={[task.project, task.agent, plainText(task.lastReport)]}
      items={items}
      onOpen={() => onOpen(task)}
    />
  );
}

function CountTitle({ title, count }: { title: string; count: number }) {
  return (
    <span className="flex items-center gap-1.5">
      {title}
      <span className="font-normal text-ink-muted text-sm tabular-nums">{count}</span>
    </span>
  );
}

export function TasksPage() {
  const view = useApp((s) => s.tasks);
  const noAgent = useApp((s) => s.status?.profiles.length === 0);
  const [filter, setFilter] = useState<Filter>("all");
  const [showEnded, setShowEnded] = useState(false);
  const [openId, setOpenId] = useState<string | undefined>(() => devOpen()?.replace(/^task-/, ""));

  const tasks = view?.tasks ?? [];
  const items = view?.items ?? [];
  const known = new Set(tasks.map((t) => t.id));
  const itemsOf = (task: Task) => items.filter((i) => i.sessionId === task.id);
  const others = items.filter((i) => !known.has(i.sessionId));

  const recent = (a: Task, b: Task) => b.updatedAt.localeCompare(a.updatedAt);
  const byStage = (a: Task, b: Task) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] || recent(a, b);
  // A task with an open request waits for the owner whatever its stage says.
  const waiting = (t: Task) => t.stage === "needs-owner" || itemsOf(t).length > 0;
  const owner = tasks.filter(waiting).sort(recent);
  const rest = tasks.filter((t) => !waiting(t));
  const active = rest.filter((t) => t.stage === "working" || t.stage === "queued").sort(byStage);
  const stuck = rest.filter((t) => t.stage === "stuck").sort(recent);
  const ended = rest.filter((t) => t.stage === "done" || t.stage === "failed").sort(recent);

  const warning = noAgent && (
    <div className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-ink-2 text-md">
      <AlertTriangle size={14} className="shrink-0 text-warning-text" />
      没有可用的 Agent：请安装 DeepSeek Harness
    </div>
  );

  if (tasks.length === 0 && items.length === 0) {
    return (
      <div className="flex flex-1 flex-col gap-3">
        {warning}
        <div className="flex flex-1 items-center justify-center pb-14">
          <EmptyState
            icon={<ListTodo size={18} strokeWidth={1.75} />}
            title="还没有任务"
            text="在飞书里跟主管说要做什么，它会替你开任务。"
          />
        </div>
      </div>
    );
  }

  const taskGroup = (title: string, list: readonly Task[], hint?: string) =>
    list.length > 0 && (
      <Section title={<CountTitle title={title} count={list.length} />} hint={hint}>
        <Group>
          {list.map((t) => (
            <TaskRow key={t.id} task={t} items={itemsOf(t)} onOpen={(x) => setOpenId(x.id)} />
          ))}
        </Group>
      </Section>
    );

  const opened = tasks.find((t) => t.id === openId);
  const showOwner = filter !== "active";
  const showActive = filter !== "owner";
  const showRest = filter === "all";
  const nothing =
    (filter === "owner" && owner.length === 0 && others.length === 0) ||
    (filter === "active" && active.length === 0);

  return (
    <div className="flex flex-col gap-6">
      {opened !== undefined && (
        <TaskTranscript task={opened} onClose={() => setOpenId(undefined)} />
      )}
      {warning}
      <Segmented label="筛选任务" options={FILTERS} value={filter} onChange={setFilter} />
      {nothing && <p className="px-0.5 text-ink-muted text-md">{FILTER_EMPTY[filter]}</p>}

      {showOwner && taskGroup("等你处理", owner, "在飞书里批准或拒绝")}
      {showOwner && others.length > 0 && (
        <Section
          title={<CountTitle title="其他请求" count={others.length} />}
          hint="不属于哪个任务的请求，也在飞书里批准或拒绝"
        >
          <Group>
            {others.map((item) => (
              <BoardRow
                key={item.id}
                dot="amber"
                title={item.taskTitle ?? item.title}
                time={item.createdAt}
                details={[projectOf(item.cwd), item.profileId]}
                items={[item]}
              />
            ))}
          </Group>
        </Section>
      )}
      {showActive && taskGroup("进行中", active)}
      {showRest && taskGroup("卡住", stuck)}
      {showRest && ended.length > 0 && (
        <Section
          title={
            <button
              type="button"
              aria-expanded={showEnded}
              onClick={() => setShowEnded(!showEnded)}
              className="-ml-1 flex items-center gap-1 rounded-sm pr-1 hover:text-ink"
            >
              <ChevronRight
                size={14}
                className={`text-ink-muted transition-transform duration-150 ${
                  showEnded ? "rotate-90" : ""
                }`}
              />
              <CountTitle title="已结束" count={ended.length} />
            </button>
          }
        >
          {showEnded && (
            <Group>
              {ended.map((t) => (
                <TaskRow key={t.id} task={t} items={[]} onOpen={(x) => setOpenId(x.id)} />
              ))}
            </Group>
          )}
        </Section>
      )}
    </div>
  );
}
