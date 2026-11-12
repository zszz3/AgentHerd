// One connection on the 应用连接 page (小红书, 飞书, Notion, …): a folded row with its status and
// one main button; clicking the rest of the row opens what is under it.

import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Badge } from "./ui";

/** What agents can do with one connection: done directly, asked first, and a sample request. */
export interface AbilityList {
  reads: readonly string[];
  writes: readonly string[];
  example: string;
}

/** The chips listing what agents can do with a connection, and the sample request. */
export function Abilities({ abilities: a }: { abilities: AbilityList }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-ink-muted text-xs">直接做</span>
        {a.reads.map((r) => (
          <Badge key={r}>{r}</Badge>
        ))}
      </div>
      {a.writes.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-ink-muted text-xs">先问你</span>
          {a.writes.map((w) => (
            <Badge key={w} tone="amber">
              {w}
            </Badge>
          ))}
        </div>
      )}
      <div className="text-ink-muted text-xs">跟主管说就行，比如{a.example}</div>
    </div>
  );
}

/** The result of 测试连接, shown as the row's subtitle until the next action. */
export interface Tested {
  ok: boolean;
  message: string;
}

/** A row's subtitle: the 测试连接 result when there is one (green when it passed), else `text`. */
export function subtitle(text: string | undefined, tested: Tested | undefined): ReactNode {
  if (tested === undefined) return text;
  return (
    <span className={tested.ok ? "text-green-600" : "text-danger-text"}>{tested.message}</span>
  );
}

/**
 * The folded row. `alert` opens it (a connection in error starts open, and opens again when it
 * fails later). `dialog` sits outside the header so a Group's divider never lands on it.
 */
export function ConnectionRow({
  icon,
  name,
  badge,
  subtitle,
  action,
  alert = false,
  children,
  dialog,
  open: forced,
  onOpenChange,
}: {
  icon: ReactNode;
  name: string;
  badge?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  alert?: boolean;
  children?: ReactNode;
  dialog?: ReactNode;
  /** Set when the parent controls opening (更多应用 opens from the Notion row). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [own, setOwn] = useState(alert);
  const open = forced ?? own;
  const setOpen = onOpenChange ?? setOwn;
  useEffect(() => {
    if (alert) setOwn(true);
  }, [alert]);
  const foldable = children !== undefined;

  return (
    <div>
      <div className="flex min-h-12 items-center gap-3 pr-4">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 text-left disabled:cursor-default"
          aria-expanded={foldable ? open : undefined}
          disabled={!foldable}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight
            size={14}
            className={`shrink-0 text-ink-muted transition-transform duration-150 ${
              open ? "rotate-90" : ""
            } ${foldable ? "" : "invisible"}`}
          />
          {icon}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium text-ink">{name}</span>
              {badge}
            </div>
            {subtitle !== undefined && (
              <div className="mt-0.5 truncate text-ink-muted text-sm">{subtitle}</div>
            )}
          </div>
        </button>
        {action !== undefined && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      {open && foldable && <div className="space-y-3 pr-4 pb-3 pl-[82px]">{children}</div>}
      {dialog}
    </div>
  );
}

/** The buttons under an opened connection (重连, 断开, …), on one line. */
export function RowActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}
