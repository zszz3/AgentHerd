export type DataHomePath = Readonly<{
  relative: string;
  kind: "persistent" | "transient" | "sqlite";
}>;

export const coreDataPaths = {
  database: { relative: "herd.db", kind: "sqlite" },
  tasks: { relative: "tasks", kind: "persistent" },
  worktrees: { relative: "worktrees", kind: "persistent" },
} as const satisfies Record<string, DataHomePath>;
