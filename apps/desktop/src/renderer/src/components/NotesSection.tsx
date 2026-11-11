// 应用连接 › 笔记 (ADR 0059): where agents keep notes. Obsidian is a folder on this Mac; Notion goes
// through Composio in the 应用 section above.

import { Check, Loader2, NotebookPen } from "lucide-react";
import { useEffect, useState } from "react";
import { errorText, host, useApp } from "../store";
import { Button, Group, IconTile, inputClass, Row, Section } from "./ui";

/** The id of the 应用 section on this page, so the Notion row can scroll to it. */
export const APPS_ANCHOR = "connections-apps";

function ObsidianRow() {
  const saved = useApp((s) => s.status?.obsidianVault) ?? "";
  const [path, setPath] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [done, setDone] = useState(false);

  // Shows a change made elsewhere (for example by the Herder) unless the owner is typing.
  useEffect(() => setPath(saved), [saved]);

  const save = async () => {
    setBusy(true);
    setProblem(undefined);
    setDone(false);
    try {
      // Not `call`: the error belongs next to the field, not in a toast.
      const status = await host().updateSettings({ obsidianVault: path.trim() });
      useApp.setState({ status });
      setDone(true);
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      <IconTile tone={saved === "" ? "gray" : "green"}>
        <NotebookPen size={14} />
      </IconTile>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-ink">Obsidian</div>
        <div className="mt-0.5 text-ink-muted text-sm">
          填你的笔记库文件夹，Agent 写笔记时会放在这里
        </div>
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            className={`${inputClass} flex-1`}
            value={path}
            placeholder="/Users/你/Documents/我的笔记库"
            spellCheck={false}
            onChange={(e) => {
              setPath(e.target.value);
              setDone(false);
            }}
          />
          <Button type="submit" variant="primary" disabled={busy || path.trim() === saved}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            保存
          </Button>
        </form>
        {problem !== undefined && <div className="mt-1.5 text-red-600 text-sm">{problem}</div>}
        {done && problem === undefined && (
          <div className="mt-1.5 flex items-center gap-1 text-green-600 text-sm">
            <Check size={12} />
            {saved === "" ? "已清除" : "已保存"}
          </div>
        )}
      </div>
    </div>
  );
}

export function NotesSection() {
  const toApps = () =>
    document.getElementById(APPS_ANCHOR)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <Section title="笔记">
      <Group>
        <ObsidianRow />
        <Row
          icon={<IconTile>N</IconTile>}
          title="Notion"
          description="通过上面「应用」里的 Composio 连接 Notion，连上后 Agent 能读写你的 Notion 页面"
          trailing={
            <Button size="sm" onClick={toApps}>
              去连接
            </Button>
          }
        />
      </Group>
    </Section>
  );
}
