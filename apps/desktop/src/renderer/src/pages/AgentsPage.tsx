// Agent: the coding agents AgentHerd picks from (ADR 0031: Codex for GPT models, Pi for the rest). The app
// downloads each one's latest release (digest checked); 验证 starts it once to prove it works.

import type { AgentCheck, AgentView } from "@agentherd/host/api";
import {
  CircleAlert,
  CircleCheck,
  Download,
  Loader2,
  RefreshCw,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import { Badge, Button, Group, IconTile, Section } from "../components/ui";
import { call, useApp } from "../store";

const DESCRIPTIONS: Record<string, string> = {
  dsh: "DeepSeek 的编程 Agent，用它自己的模型设置。只有你点名要它时才用。",
  pi: "轻量的开源编程 Agent。GPT 以外的模型都用它跑。",
  codex: "OpenAI 的 Codex。模型列表里有 GPT 模型时自动下载，GPT 模型用它跑；跑不起来就换 Pi。",
};

/** How to sign in, for agents that use their own account. */
const LOGIN: Record<string, string> = {};

const SOURCES: Record<NonNullable<AgentView["source"]>, string> = {
  managed: "AgentHerd 下载的",
  system: "你电脑上装的",
  app: "随 DeepSeek Harness 安装",
  config: "config.json 里配置的",
};

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function StateBadge({ agent }: { agent: AgentView }) {
  switch (agent.state) {
    case "ready":
      return <Badge tone="green">可以用</Badge>;
    case "installing":
      return <Badge tone="blue">正在下载</Badge>;
    case "unsupported":
      return <Badge tone="gray">这台电脑不支持</Badge>;
    case "missing":
      return <Badge tone="amber">{agent.canInstall ? "未下载" : "未安装"}</Badge>;
  }
}

function Progress({ agent }: { agent: AgentView }) {
  const p = agent.progress;
  const percent = p !== undefined && p.total > 0 ? Math.round((p.received / p.total) * 100) : 0;
  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-control-hover">
        <div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      <span className="text-ink-muted text-sm">
        {p === undefined || p.total === 0
          ? "正在下载和安装…"
          : `${megabytes(p.received)} / ${megabytes(p.total)}（${percent}%）`}
      </span>
    </div>
  );
}

function Actions({ agent }: { agent: AgentView }) {
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<AgentView[] | undefined>) => {
    setBusy(true);
    const agents = await fn();
    if (agents !== undefined) useApp.setState({ agents });
    setBusy(false);
  };
  if (agent.state === "installing") {
    return (
      <Button onClick={() => void act(() => call((h) => h.cancelInstall(agent.id)))}>
        <X size={13} />
        取消
      </Button>
    );
  }
  const ready = agent.state === "ready";
  return (
    <>
      {agent.canInstall && (
        <Button
          variant={ready ? "secondary" : "primary"}
          disabled={busy}
          title={ready ? "下载最新版本替换现在这份" : undefined}
          onClick={() => void act(() => call((h) => h.installAgent(agent.id)))}
        >
          {busy ? (
            <Loader2 size={13} className="animate-spin" />
          ) : ready ? (
            <RefreshCw size={13} />
          ) : (
            <Download size={13} />
          )}
          {ready ? "更新" : agent.error === undefined ? "下载" : "重新下载"}
        </Button>
      )}
      {agent.canRemove && (
        <Button
          disabled={busy}
          onClick={() => {
            if (window.confirm(`移除下载的 ${agent.name}？正在跑的任务不受影响，以后可以再下载。`))
              void act(() => call((h) => h.removeAgent(agent.id)));
          }}
        >
          <Trash2 size={13} />
          移除
        </Button>
      )}
    </>
  );
}

function detail(agent: AgentView): string {
  if (agent.state === "missing" && agent.canInstall) {
    return agent.id === "dsh"
      ? "从 DeepSeek 官方更新源下载最新版（约 350 MB）；装了桌面版就直接用它"
      : "下载官方最新版";
  }
  if (agent.state === "ready" && agent.source !== undefined) {
    return `${SOURCES[agent.source]}${agent.source === "managed" ? `，版本 ${agent.version ?? ""}` : ""}`;
  }
  return "";
}

function CheckButton({ agent, onResult }: { agent: AgentView; onResult: (c: AgentCheck) => void }) {
  const [busy, setBusy] = useState(false);
  if (agent.state !== "ready") return null;
  return (
    <Button
      disabled={busy}
      title="在空目录里启动一次，看它能不能正常工作"
      onClick={async () => {
        setBusy(true);
        const check = await call((h) => h.verifyAgent(agent.id));
        setBusy(false);
        if (check !== undefined) onResult(check);
      }}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
      {busy ? "验证中" : "验证"}
    </Button>
  );
}

function CheckResult({ check, agent }: { check: AgentCheck; agent: AgentView }) {
  const seconds = (check.ms / 1000).toFixed(1);
  if (check.ok) {
    const version = check.agentVersion === undefined ? "" : ` ${check.agentVersion}`;
    return (
      <div className="mt-1 flex items-center gap-1.5 text-sm text-success-text">
        <CircleCheck size={13} />
        能用：{check.agentName ?? agent.name}
        {version} 已启动并建好会话（{seconds} 秒）
      </div>
    );
  }
  const killed = check.error?.includes("SIGKILL") ?? false;
  return (
    <div className="mt-1 flex flex-col gap-0.5 text-danger-text text-sm">
      <div className="flex items-center gap-1.5">
        <CircleAlert size={13} />
        {check.needsLogin
          ? `需要先登录。${LOGIN[agent.id] ?? ""}`
          : killed
            ? "进程被系统杀掉了（SIGKILL），可能是安全软件拦截了这个程序"
            : "没能启动"}
      </div>
      {check.error !== undefined && check.error !== "" && (
        <div className="selectable ml-5 line-clamp-3 whitespace-pre-wrap font-mono text-ink-muted text-xs">
          {check.error}
        </div>
      )}
    </div>
  );
}

function AgentRow({ agent }: { agent: AgentView }) {
  const description = DESCRIPTIONS[agent.id];
  const [check, setCheck] = useState<AgentCheck | undefined>();
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-start gap-3">
        <IconTile tone={agent.state === "ready" ? "green" : "gray"}>
          <SquareTerminal size={15} strokeWidth={1.75} />
        </IconTile>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-medium text-ink text-md">
            {agent.name}
            <span className="font-mono font-normal text-ink-muted text-sm">/run {agent.id}</span>
            <StateBadge agent={agent} />
          </div>
          {description !== undefined && (
            <div className="mt-0.5 text-ink-2 text-sm">{description}</div>
          )}
          <div className="mt-0.5 text-ink-muted text-sm">{detail(agent)}</div>
          {agent.state === "ready" && agent.path !== undefined && agent.source !== "managed" && (
            <div className="selectable mt-0.5 truncate font-mono text-ink-muted text-xs">
              {agent.path}
            </div>
          )}
          {LOGIN[agent.id] !== undefined && agent.state === "ready" && check === undefined && (
            <div className="mt-0.5 text-ink-muted text-sm">{LOGIN[agent.id]}</div>
          )}
          {agent.state === "installing" && <Progress agent={agent} />}
          {check !== undefined && agent.state === "ready" && (
            <CheckResult check={check} agent={agent} />
          )}
          {agent.error !== undefined && agent.state !== "installing" && (
            <div className="mt-1 flex items-center gap-1.5 text-danger-text text-sm">
              <CircleAlert size={13} />
              下载失败：{agent.error}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <CheckButton agent={agent} onResult={setCheck} />
          <Actions agent={agent} />
        </div>
      </div>
    </div>
  );
}

export function AgentsPage() {
  const agents = useApp((s) => s.agents);
  const ready = agents.filter((a) => a.state === "ready").length;
  return (
    <div className="flex flex-col gap-7">
      <Section
        title="编程 Agent"
        hint={
          ready === 0
            ? "不用选 Agent：AgentHerd 按任务的模型自动挑，GPT 模型用 Codex，其余用 Pi。"
            : `${ready} 个可以用。不用选：GPT 模型用 Codex，其余用 Pi。`
        }
      >
        <Group>
          {agents.map((a) => (
            <AgentRow key={a.id} agent={a} />
          ))}
        </Group>
      </Section>
    </div>
  );
}
