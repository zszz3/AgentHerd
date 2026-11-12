// 应用连接 › 账号 › Notion and 更多应用 (docs/spec/09-agent-tools.md §3): the owner's own Composio
// API key, and the apps (Notion, Gmail, GitHub, …) agents may use through it. The key is never
// shown again after saving.

import type { AppsView, AppView } from "@agentherd/host/api";
import { Blocks, KeyRound, Link2, LogOut, Search, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { call, useApp } from "../store";
import { Abilities, type AbilityList, ConnectionRow, RowActions } from "./ConnectionRow";
import { Badge, Button, Group, IconTile, inputClass, Row } from "./ui";

const COMPOSIO_KEYS = "https://platform.composio.dev/";
/** Reveal app rows in small batches, including search results. */
const SHOWN = 5;

function AppLogo({ app }: { app: AppView }) {
  const [broken, setBroken] = useState(false);
  if (app.logo === undefined || broken) {
    return <IconTile tone={app.connected ? "green" : "gray"}>{app.name.slice(0, 1)}</IconTile>;
  }
  return (
    <img
      src={app.logo}
      alt=""
      className="h-7 w-7 shrink-0 rounded-md bg-white object-contain p-1"
      onError={() => setBroken(true)}
    />
  );
}

function KeyForm({ hasKey, onDone }: { hasKey: boolean; onDone: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (value: string) => {
    setBusy(true);
    const view = await call((h) => h.setComposioKey(value));
    setBusy(false);
    if (view === undefined) return;
    useApp.setState({ apps: view });
    if (view.problem === undefined) {
      setKey("");
      onDone();
    }
  };
  return (
    <Row
      icon={
        <IconTile tone={hasKey ? "green" : "gray"}>
          <KeyRound size={15} strokeWidth={1.75} />
        </IconTile>
      }
    >
      <form
        className="flex min-w-0 flex-1 items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (key.trim() !== "") void save(key);
        }}
      >
        <input
          className={`${inputClass} min-w-0 flex-1`}
          type="password"
          // Chromium must neither remember the key nor offer it in another field.
          autoComplete="new-password"
          name="composio-key"
          spellCheck={false}
          placeholder={hasKey ? "粘贴新的 Composio API Key 替换" : "粘贴你的 Composio API Key"}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          disabled={busy}
        />
        <Button variant="primary" type="submit" disabled={busy || key.trim() === ""}>
          {busy ? "检查中…" : "保存"}
        </Button>
        {hasKey && (
          <Button variant="ghost" disabled={busy} onClick={() => void save("")}>
            删除
          </Button>
        )}
      </form>
    </Row>
  );
}

function AppRow({ app }: { app: AppView }) {
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    setBusy(true);
    const link = await call((h) => h.connectApp(app.slug));
    setBusy(false);
    if (link !== undefined) window.open(link.url, "_blank");
  };
  const disconnect = async () => {
    setBusy(true);
    const view = await call((h) => h.disconnectApp(app.slug));
    setBusy(false);
    if (view !== undefined) useApp.setState({ apps: view });
  };
  return (
    <Row
      icon={<AppLogo app={app} />}
      title={app.name}
      description={app.connecting ? "在浏览器里登录后会自动连上…" : app.slug}
      trailing={
        app.connected ? (
          <>
            <Badge tone="green">已连接</Badge>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void disconnect()}>
              断开
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={busy || app.connecting} onClick={() => void connect()}>
            <Link2 size={12} />
            {app.connecting ? "等待登录" : "连接"}
          </Button>
        )
      }
    />
  );
}

/** The Composio key, search and app list, shown when 更多应用 is opened. */
export function AppsPanel() {
  const apps = useApp((s) => s.apps);
  const [search, setSearch] = useState("");
  const [visible, setVisible] = useState(SHOWN);
  const [editingKey, setEditingKey] = useState(false);
  // Search results must not replace the default list needed when the field is cleared.
  const [results, setResults] = useState<{ query: string; view: AppsView }>();

  useEffect(() => {
    const q = search.trim();
    let active = true;
    const timer = setTimeout(
      async () => {
        const view = await call((h) => h.apps(q === "" ? undefined : q));
        if (!active || view === undefined) return;
        if (q === "") useApp.setState({ apps: view });
        else setResults({ query: q.toLowerCase(), view });
      },
      q === "" ? 0 : 300,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [search]);

  const q = search.trim().toLowerCase();
  const found = apps?.hasKey === true && results?.query === q ? results.view : undefined;
  const view: AppsView | undefined = found ?? apps;
  const hasKey = apps?.hasKey === true;
  // Default rows carry the latest connection state; remote search can add more apps.
  const list = [
    ...new Map([...(found?.apps ?? []), ...(apps?.apps ?? [])].map((a) => [a.slug, a])).values(),
  ];
  // Keep the current query in force while a request is pending or an app event arrives.
  const matching = list
    .filter((a) => a.name.toLowerCase().includes(q) || a.slug.toLowerCase().includes(q))
    .sort((a, b) => Number(b.connected) - Number(a.connected));
  const shown = matching.slice(0, visible);

  return (
    <>
      <Group>
        {/* Until the host answers, nothing is known: do not ask for a key it may already have. */}
        {view === undefined && <Row description="正在读取…" />}
        {view !== undefined && (!hasKey || editingKey) && (
          <>
            {!hasKey && (
              <Row
                icon={
                  <IconTile tone="blue">
                    <Blocks size={15} strokeWidth={1.75} />
                  </IconTile>
                }
                title="还没有 Composio API Key"
                description={
                  <>
                    在{" "}
                    <a
                      className="text-accent-text hover:underline"
                      href={COMPOSIO_KEYS}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Composio
                    </a>{" "}
                    免费注册，在 Settings → API Keys 复制一个 Key 粘贴到下面
                  </>
                }
              />
            )}
            <KeyForm
              hasKey={hasKey}
              onDone={() => {
                setEditingKey(false);
                setSearch("");
              }}
            />
          </>
        )}
        {view?.problem !== undefined && (
          <Row
            icon={
              <IconTile tone="red">
                <TriangleAlert size={15} strokeWidth={1.75} />
              </IconTile>
            }
            description={<span className="selectable text-danger-text">{view.problem}</span>}
          />
        )}
        {hasKey && (
          <Row
            icon={
              <IconTile>
                <Search size={15} strokeWidth={1.75} />
              </IconTile>
            }
          >
            <input
              className={`${inputClass} min-w-0 flex-1`}
              type="search"
              // Without this Chromium took the field next to the key for a user name and filled
              // the saved key into it after saving.
              autoComplete="off"
              name="app-search"
              spellCheck={false}
              placeholder="搜索应用，如 gmail、github、notion"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setVisible(SHOWN);
              }}
            />
          </Row>
        )}
        {hasKey && shown.map((app) => <AppRow key={app.slug} app={app} />)}
        {hasKey && matching.length > visible && (
          <Row>
            <Button variant="ghost" size="sm" onClick={() => setVisible((n) => n + SHOWN)}>
              显示更多
            </Button>
          </Row>
        )}
        {hasKey && view !== undefined && shown.length === 0 && view.problem === undefined && (
          <Row description="没有找到应用" />
        )}
      </Group>
      {hasKey && !editingKey && (
        <RowActions>
          <Button variant="ghost" size="sm" onClick={() => setEditingKey(true)}>
            <KeyRound size={12} />
            更换 Key
          </Button>
        </RowActions>
      )}
    </>
  );
}

const NOTION = "notion";
const NOTION_ABILITIES: AbilityList = {
  reads: ["搜页面", "读页面和数据库"],
  writes: ["新建页面", "改页面", "写数据库"],
  example: "「把今天的会议要点记到 Notion」",
};

/**
 * Notion through Composio. It is not always in the default app list, so the row asks for it by
 * name when it is missing, and again whenever the list changes.
 */
export function NotionRow({ onNeedKey }: { onNeedKey: () => void }) {
  const apps = useApp((s) => s.apps);
  const [found, setFound] = useState<AppView | undefined>();
  const [busy, setBusy] = useState(false);
  const listed = apps?.apps.find((a) => a.slug === NOTION);
  const hasKey = apps?.hasKey === true;

  useEffect(() => {
    if (!hasKey || listed !== undefined) return;
    let active = true;
    void call((h) => h.apps(NOTION)).then((view) => {
      if (active) setFound(view?.apps.find((a) => a.slug === NOTION));
    });
    return () => {
      active = false;
    };
  }, [hasKey, listed]);

  if (apps === undefined) return null;
  const notion = listed ?? found;
  const connected = notion?.connected === true;

  const connect = async () => {
    if (!hasKey) {
      onNeedKey();
      return;
    }
    setBusy(true);
    const link = await call((h) => h.connectApp(NOTION));
    setBusy(false);
    if (link !== undefined) window.open(link.url, "_blank");
  };
  const disconnect = async () => {
    setBusy(true);
    const view = await call((h) => h.disconnectApp(NOTION));
    setBusy(false);
    if (view !== undefined) useApp.setState({ apps: view });
    setFound(undefined);
  };

  return (
    <ConnectionRow
      icon={<IconTile tone={connected ? "green" : "gray"}>N</IconTile>}
      name="Notion"
      badge={
        connected ? (
          <Badge tone="green">已连接</Badge>
        ) : notion?.connecting ? (
          <Badge tone="blue">等待登录</Badge>
        ) : (
          <Badge>未连接</Badge>
        )
      }
      subtitle={hasKey ? undefined : "先在下面「更多应用」里填 Composio Key"}
      action={
        connected ? undefined : (
          <Button size="sm" disabled={busy || notion?.connecting} onClick={() => void connect()}>
            <Link2 size={12} />
            连接
          </Button>
        )
      }
    >
      <Abilities abilities={NOTION_ABILITIES} />
      {connected && (
        <RowActions>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void disconnect()}>
            <LogOut size={12} />
            断开
          </Button>
        </RowActions>
      )}
    </ConnectionRow>
  );
}

/** 更多应用: every other Composio app. Folded it shows how many are connected. */
export function MoreAppsRow({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const apps = useApp((s) => s.apps);
  const connected = apps?.apps.filter((a) => a.connected && a.slug !== NOTION).length ?? 0;
  return (
    <ConnectionRow
      icon={
        <IconTile>
          <Blocks size={15} strokeWidth={1.75} />
        </IconTile>
      }
      name="更多应用"
      subtitle={
        apps === undefined
          ? undefined
          : apps.hasKey
            ? `Composio · ${connected} 个已连接`
            : "Composio · 还没填 Key"
      }
      open={open}
      onOpenChange={onOpenChange}
    >
      <AppsPanel />
    </ConnectionRow>
  );
}
