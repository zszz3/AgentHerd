// Which notices ring the owner's phone and which only go on the task board (ADR 0061).

import type { Store } from "./store.ts";

/**
 * `push`: a message to the owner now. `board`: only the task's row on the pinned task board
 * changes; the phone stays quiet. `off`: neither, only the audit log.
 */
export const NOTICE_LEVELS = ["push", "board", "off"] as const;
export type NoticeLevel = (typeof NOTICE_LEVELS)[number];

/**
 * Informational notices: the owner can change how each reaches them through the Herder.
 * Everything else is pushed and cannot be turned down: results the owner asked for, questions,
 * approvals, a task that needs the owner, is stuck or failed, watchdog alarms, and the mail and
 * platform notices the owner chose to watch.
 */
export const NOTICE_KINDS = [
  "pr-approved",
  "pr-merged",
  "pr-closed",
  "pr-reopened",
  "pr-follow-up",
  "task-ack",
  "model-switched",
] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

export const DEFAULT_NOTICE_LEVELS: Readonly<Record<NoticeKind, NoticeLevel>> = {
  "pr-approved": "board",
  "pr-merged": "board",
  "pr-closed": "board",
  "pr-reopened": "board",
  "pr-follow-up": "board",
  "task-ack": "board",
  "model-switched": "board",
};

/** What each kind is, for the Herder. */
export const NOTICE_ABOUT: Readonly<Record<NoticeKind, string>> = {
  "pr-approved": "someone approved a task's pull request without a comment",
  "pr-merged": "a task's pull request was merged",
  "pr-closed": "a task's pull request was closed without merging",
  "pr-reopened": "a task's pull request was reopened",
  "pr-follow-up":
    "the result of a task's turn that its pull request woke (new comments, failed checks), when the task handled it on its own",
  "task-ack":
    "the one line a task says when it starts a turn the owner did not ask for directly (the Herder started it, or its pull request woke it)",
  "model-switched": "a task moved to another model before it did anything",
};

const STATE_KEY = "notice.levels";

function isKind(value: string): value is NoticeKind {
  return (NOTICE_KINDS as readonly string[]).includes(value);
}

function isLevel(value: unknown): value is NoticeLevel {
  return typeof value === "string" && (NOTICE_LEVELS as readonly string[]).includes(value);
}

function saved(store: Store): Record<string, unknown> {
  const value = store.getState<Record<string, unknown>>(STATE_KEY);
  return value !== null && typeof value === "object" ? value : {};
}

/** Every kind's level: the owner's choice where there is one, the default otherwise. */
export function noticeLevels(store: Store): Record<NoticeKind, NoticeLevel> {
  const levels = { ...DEFAULT_NOTICE_LEVELS };
  for (const [kind, level] of Object.entries(saved(store))) {
    if (isKind(kind) && isLevel(level)) levels[kind] = level;
  }
  return levels;
}

export function noticeLevel(store: Store, kind: NoticeKind): NoticeLevel {
  return noticeLevels(store)[kind];
}

/** Kinds the owner set to something other than the default. */
export function changedNoticeLevels(store: Store): { kind: NoticeKind; level: NoticeLevel }[] {
  const levels = noticeLevels(store);
  return NOTICE_KINDS.filter((k) => levels[k] !== DEFAULT_NOTICE_LEVELS[k]).map((kind) => ({
    kind,
    level: levels[kind],
  }));
}

/** Saves the owner's choice; going back to the default forgets it. */
export function setNoticeLevel(store: Store, kind: string, level: string): void {
  if (!isKind(kind)) {
    throw new Error(`unknown notice kind "${kind}"; known: ${NOTICE_KINDS.join(", ")}`);
  }
  if (!isLevel(level)) {
    throw new Error(`unknown level "${level}"; known: ${NOTICE_LEVELS.join(", ")}`);
  }
  const next = { ...saved(store) };
  if (level === DEFAULT_NOTICE_LEVELS[kind]) delete next[kind];
  else next[kind] = level;
  store.setState(STATE_KEY, next);
  store.audit("notice.level", { kind, level });
}
