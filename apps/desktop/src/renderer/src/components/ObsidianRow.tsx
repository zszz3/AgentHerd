// 应用连接 › 账号 › Obsidian (ADR 0059): the vault folder on this Mac where agents keep notes.

import { Check, Loader2, NotebookPen } from "lucide-react";
import { useEffect, useState } from "react";
import { errorText, host, useApp } from "../store";
import { ConnectionRow } from "./ConnectionRow";
import { Badge, Button, IconTile, inputClass } from "./ui";

export function ObsidianRow() {
  const saved = useApp((s) => s.status?.obsidianVault) ?? "";
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [done, setDone] = useState(false);

  // Shows a change made elsewhere (for example by the Herder).
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

  const set = saved !== "";
  return (
    <ConnectionRow
      icon={
        <IconTile tone={set ? "green" : "gray"}>
          <NotebookPen size={14} />
        </IconTile>
      }
      name="Obsidian"
      badge={set ? <Badge tone="green">已设置</Badge> : <Badge>未设置</Badge>}
      subtitle={set ? <span title={saved}>{saved}</span> : "Agent 写的笔记放进你的笔记库"}
      action={
        set ? undefined : (
          <Button size="sm" onClick={() => setOpen(true)}>
            设置
          </Button>
        )
      }
      open={open}
      onOpenChange={setOpen}
    >
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input
          className={`${inputClass} min-w-0 flex-1`}
          value={path}
          placeholder="笔记库文件夹，如 /Users/你/Documents/我的笔记库"
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
      {problem !== undefined && <div className="text-danger-text text-sm">{problem}</div>}
      {done && problem === undefined && (
        <div className="flex items-center gap-1 text-green-600 text-sm">
          <Check size={12} />
          {set ? "已保存" : "已清除"}
        </div>
      )}
    </ConnectionRow>
  );
}
