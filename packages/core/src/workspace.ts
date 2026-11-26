// Where a task's agent works (ADR 0043). A task in a git project gets a copy of its own: a git
// worktree of the owner's repository holding the owner's files as they are (also uncommitted and
// untracked ones). Each turn starts with the owner's newer changes copied in and ends with the
// task's changes copied back into the project folder as uncommitted edits. The owner never sees
// the copy, its folder or any branch: its commits live under refs/agentherd/, not refs/heads/.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { coreDataPaths } from "./data-home-paths.ts";

/**
 * - `copy`: a git worktree of the project, synced every turn.
 * - `inplace`: the agent works in the folder itself (not a git project, or a one-off CLI run).
 * - `scratch`: no project; an empty folder of the task's own.
 */
export type WorkspaceKind = "copy" | "inplace" | "scratch";

export interface TaskWorkspace {
  kind: WorkspaceKind;
  /** Where the agent runs. */
  cwd: string;
  /** The owner's folder the task was started in (`copy` and `inplace`). */
  project?: string;
  /** `copy`: top of the owner's repository. */
  top?: string;
  /** `copy`: the worktree. */
  root?: string;
  /** `copy`: the commit both sides agreed on at the last sync. */
  base?: string;
  /** `copy`: dependency folders linked from the project, relative to the top, `/`-separated. */
  links?: string[];
  /** Files the task changed that the owner had changed too; the project kept the owner's. */
  conflicts?: string[];
  /** The commit holding the task's version of `conflicts`. */
  conflictFrom?: string;
}

/** What the end of a turn copied back. */
export interface SyncResult {
  applied: string[];
  conflicts: string[];
}

export type GitRun = (
  args: string[],
  options: { cwd: string; env?: Record<string, string>; input?: string },
) => Promise<string>;

/** Dependency folders a copy links to instead of installing them again. */
export const LINKED_DIRS = new Set(["node_modules", ".venv", "venv"]);
/** Ignored files copied into a copy: local settings an agent needs to run things. */
const COPIED_FILE = /^\.env(\..+)?$/;

const IDENTITY = {
  GIT_AUTHOR_NAME: "AgentHerd",
  GIT_AUTHOR_EMAIL: "agentherd@localhost",
  GIT_COMMITTER_NAME: "AgentHerd",
  GIT_COMMITTER_EMAIL: "agentherd@localhost",
};

export const runGit: GitRun = (args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["-c", "core.quotepath=false", "-c", "core.longpaths=true", ...args],
      {
        cwd: options.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else {
        const message = Buffer.concat(err).toString("utf8").trim();
        reject(new Error(`git ${args[0]} failed: ${message || `exit ${code}`}`));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });

/** A path that differs between two commits: deleted, or written. */
interface Change {
  path: string;
  deleted: boolean;
}

export class Workspaces {
  private readonly home: string;
  private readonly git: GitRun;
  /** One sync at a time per repository. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(home: string, git: GitRun = runGit) {
    this.home = home;
    this.git = git;
  }

  /**
   * The workspace of a new task, or of an ended one started again (`previous`). `dir` undefined:
   * a scratch folder. A folder outside git, or `inplace`, runs in the folder itself. A copy an
   * earlier run left is used again, with its changes not yet copied back.
   */
  async create(
    taskId: string,
    dir: string | undefined,
    options: { inplace?: boolean; previous?: TaskWorkspace } = {},
  ): Promise<TaskWorkspace> {
    const { previous } = options;
    if (previous?.kind === "scratch" || (dir === undefined && previous === undefined)) {
      const cwd =
        previous?.cwd ?? join(this.home, coreDataPaths.tasks.relative, taskId.slice(0, 8));
      mkdirSync(cwd, { recursive: true });
      return { kind: "scratch", cwd };
    }
    const project = dir ?? previous?.project;
    if (project === undefined) throw new Error("no project folder");
    if (options.inplace === true || previous?.kind === "inplace") {
      return { kind: "inplace", cwd: project, project };
    }
    let top: string;
    try {
      top = join((await this.git(["rev-parse", "--show-toplevel"], { cwd: project })).trim());
      // A repository without a commit has nothing to start a worktree from.
      await this.git(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: project });
    } catch {
      return { kind: "inplace", cwd: project, project };
    }
    const root = this.rootFor(top, taskId);
    const cwd = join(root, relative(top, project));
    return this.locked(top, async () => {
      if (existsSync(join(root, ".git")) && previous?.base !== undefined) {
        const links = await this.linkDeps(top, root);
        return { ...previous, kind: "copy", cwd, project, top, root, links };
      }
      const base = await this.snapshot(top);
      mkdirSync(dirname(root), { recursive: true });
      if (existsSync(root)) await this.dropCopy(top, root, previous?.links ?? []);
      await this.git(["worktree", "add", "--detach", "--force", root, base], { cwd: top });
      await this.git(["update-ref", refOf(taskId), base], { cwd: top });
      const links = await this.linkDeps(top, root);
      return { kind: "copy", cwd, project, top, root, base, links };
    });
  }

  /** The copy's folder: the same every time, so an agent can load its session again. */
  rootFor(top: string, taskId: string): string {
    const hash = createHash("sha1").update(top.toLowerCase()).digest("hex").slice(0, 6);
    return join(
      this.home,
      coreDataPaths.worktrees.relative,
      `${safe(basename(top))}-${hash}`,
      taskId.slice(0, 8),
    );
  }

  /** Before a turn: what the owner changed since the last sync goes into the copy. */
  async beforeTurn(ws: TaskWorkspace): Promise<void> {
    const { top, root } = ws;
    if (ws.kind !== "copy" || top === undefined || root === undefined) return;
    await this.locked(top, async () => {
      const project = await this.snapshot(top);
      const copy = await this.commitCopy(root, ws.links ?? []);
      const base = ws.base ?? copy;
      const ours = new Set((await this.changes(top, base, copy)).map((c) => c.path));
      const theirs = await this.changes(top, base, project);
      // A file the task changed and has not handed back yet keeps the task's version.
      await this.write(
        root,
        project,
        theirs.filter((c) => !ours.has(c.path)),
      );
      if (ours.size === 0) ws.base = project;
    });
  }

  /**
   * After a turn: the task's changes go into the project folder. A file the owner changed too
   * keeps the owner's version and is listed in `conflicts`. The copy then matches the project.
   */
  async afterTurn(ws: TaskWorkspace, taskId: string): Promise<SyncResult> {
    const { top, root } = ws;
    if (ws.kind !== "copy" || top === undefined || root === undefined) {
      return { applied: [], conflicts: [] };
    }
    return this.locked(top, async () => {
      const copy = await this.commitCopy(root, ws.links ?? []);
      await this.git(["update-ref", refOf(taskId), copy], { cwd: top });
      const project = await this.snapshot(top);
      const base = ws.base ?? project;
      const ours = await this.changes(top, base, copy);
      const theirs = new Set((await this.changes(top, base, project)).map((c) => c.path));
      const apply: Change[] = [];
      const conflicts: string[] = [];
      for (const c of ours) {
        if (!theirs.has(c.path) || (await this.same(top, project, copy, c.path))) apply.push(c);
        else conflicts.push(c.path);
      }
      await this.write(top, copy, apply);
      const after = apply.length === 0 ? project : await this.snapshot(top);
      await this.write(root, after, await this.changes(top, copy, after));
      ws.base = after;
      if (conflicts.length > 0) {
        ws.conflicts = conflicts;
        ws.conflictFrom = copy;
      }
      return { applied: apply.map((c) => c.path), conflicts };
    });
  }

  /** Puts the task's version of its conflicting files into the project folder. */
  async takeTask(ws: TaskWorkspace): Promise<string[]> {
    const files = ws.conflicts ?? [];
    const from = ws.conflictFrom;
    const { top } = ws;
    if (top === undefined || from === undefined || files.length === 0) return [];
    await this.locked(top, async () => {
      const present = new Set(await this.present(top, from, files));
      await this.write(
        top,
        from,
        files.map((path) => ({ path, deleted: !present.has(path) })),
      );
    });
    delete ws.conflicts;
    delete ws.conflictFrom;
    return files;
  }

  /** Removes a task's copy. Its commits stay under refs/agentherd/ for `takeTask`. */
  async remove(ws: TaskWorkspace): Promise<void> {
    const { top, root } = ws;
    if (ws.kind !== "copy" || top === undefined || root === undefined) return;
    await this.locked(top, () => this.dropCopy(top, root, ws.links ?? []));
  }

  private async dropCopy(top: string, root: string, links: string[]): Promise<void> {
    // Unlink first: removing the folder must never go through a link into the project.
    for (const link of links) unlinkDir(join(root, link));
    try {
      await this.git(["worktree", "remove", "--force", root], { cwd: top });
    } catch {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      await this.git(["worktree", "prune"], { cwd: top }).catch(() => "");
    }
    // The project's folder of copies goes with its last copy.
    try {
      rmdirSync(dirname(root));
    } catch {
      // Other tasks of the project still have copies there.
    }
  }

  private locked<T>(key: string, run: () => Promise<T>): Promise<T> {
    const k = key.toLowerCase();
    const next = (this.locks.get(k) ?? Promise.resolve()).then(run, run);
    this.locks.set(
      k,
      next.catch(() => {}),
    );
    return next;
  }

  /**
   * A commit of the owner's folder as it is: tracked and untracked files, not ignored ones. A
   * scratch index keeps the owner's staged changes as they are. Its parent is HEAD.
   */
  private async snapshot(top: string): Promise<string> {
    return this.withIndex(async (env) => {
      const real = (
        await this.git(["rev-parse", "--path-format=absolute", "--git-path", "index"], {
          cwd: top,
        })
      ).trim();
      // Starting from the real index lets git skip files whose stat did not change.
      if (existsSync(real)) copyFileSync(real, env.GIT_INDEX_FILE);
      await this.git(["add", "-A", "--", "."], { cwd: top, env });
      const tree = (await this.git(["write-tree"], { cwd: top, env })).trim();
      return this.commit(top, tree);
    });
  }

  /** A commit of the copy as it is, without its links. */
  private async commitCopy(root: string, links: string[]): Promise<string> {
    return this.withIndex(async (env) => {
      await this.git(["read-tree", "HEAD"], { cwd: root, env });
      await this.git(["add", "-A", "--", "."], { cwd: root, env });
      if (links.length > 0) {
        await this.git(["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...links], {
          cwd: root,
          env: { ...env, GIT_LITERAL_PATHSPECS: "1" },
        });
      }
      const tree = (await this.git(["write-tree"], { cwd: root, env })).trim();
      return this.commit(root, tree);
    });
  }

  private async withIndex<T>(run: (env: { GIT_INDEX_FILE: string }) => Promise<T>): Promise<T> {
    const tmp = mkdtempSync(join(tmpdir(), "agentherd-index-"));
    try {
      return await run({ GIT_INDEX_FILE: join(tmp, "index") });
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }

  private async commit(cwd: string, tree: string): Promise<string> {
    const head = (await this.git(["rev-parse", "HEAD"], { cwd })).trim();
    const out = await this.git(["commit-tree", tree, "-p", head, "-m", "agentherd"], {
      cwd,
      env: IDENTITY,
    });
    return out.trim();
  }

  /** Paths that differ between two commits. */
  private async changes(cwd: string, a: string, b: string): Promise<Change[]> {
    if (a === b) return [];
    const out = await this.git(["diff", "--name-status", "-z", "--no-renames", a, b], { cwd });
    const parts = out.split("\0");
    const list: Change[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i] ?? "";
      const path = parts[i + 1] ?? "";
      if (status === "" || path === "") continue;
      list.push({ path, deleted: status.startsWith("D") });
    }
    return list;
  }

  /** The ones of `paths` that exist in `commit`. */
  private async present(cwd: string, commit: string, paths: string[]): Promise<string[]> {
    const out = await this.git(["ls-tree", "-r", "-z", "--name-only", commit, "--", ...paths], {
      cwd,
      env: { GIT_LITERAL_PATHSPECS: "1" },
    });
    return out.split("\0").filter((p) => p !== "");
  }

  private async same(cwd: string, a: string, b: string, path: string): Promise<boolean> {
    const blob = (c: string) =>
      this.git(["rev-parse", "--verify", "--quiet", `${c}:${path}`], { cwd }).then(
        (s) => s.trim(),
        () => "",
      );
    return (await blob(a)) === (await blob(b));
  }

  /** Writes `changes` from `commit` into the folder `dir`, leaving its index alone. */
  private async write(dir: string, commit: string, changes: Change[]): Promise<void> {
    for (const c of changes) {
      if (c.deleted) {
        rmSync(join(dir, c.path), {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 50,
        });
      }
    }
    const written = changes.filter((c) => !c.deleted).map((c) => c.path);
    if (written.length === 0) return;
    await this.withIndex((env) =>
      this.git(["checkout", commit, "--pathspec-from-file=-", "--pathspec-file-nul"], {
        cwd: dir,
        env: { ...env, GIT_LITERAL_PATHSPECS: "1" },
        input: `${written.join("\0")}\0`,
      }),
    );
  }

  /** Links the project's dependency folders into the copy and copies its .env files. */
  private async linkDeps(top: string, root: string): Promise<string[]> {
    let out: string;
    try {
      out = await this.git(
        ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
        { cwd: top },
      );
    } catch {
      return [];
    }
    const links: string[] = [];
    for (const raw of out.split("\0")) {
      if (raw === "") continue;
      const isDir = raw.endsWith("/");
      const rel = isDir ? raw.slice(0, -1) : raw;
      const name = basename(rel);
      const to = join(root, rel);
      try {
        if (isDir && LINKED_DIRS.has(name)) {
          if (isLink(to)) {
            links.push(rel);
            continue;
          }
          if (existsSync(to)) continue;
          mkdirSync(dirname(to), { recursive: true });
          symlinkSync(join(top, rel), to, process.platform === "win32" ? "junction" : "dir");
          links.push(rel);
        } else if (!isDir && COPIED_FILE.test(name) && !existsSync(to)) {
          mkdirSync(dirname(to), { recursive: true });
          copyFileSync(join(top, rel), to);
        }
      } catch {
        // An agent that needs a dependency that could not be linked installs it.
      }
    }
    return links;
  }
}

function refOf(taskId: string): string {
  return `refs/agentherd/tasks/${taskId}`;
}

function safe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40) || "project";
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function unlinkDir(path: string): void {
  if (!isLink(path)) return;
  try {
    unlinkSync(path);
  } catch {
    try {
      rmdirSync(path);
    } catch {
      // Already gone.
    }
  }
}
