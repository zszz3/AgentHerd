// Mass delete: the one kind of agent request that still goes to the owner (ADR 0029). Everything
// else is approved by AgentHerd. "Mass" means the target is the project folder itself, a folder
// above it, the home folder, `/`, anything outside the project, everything in a folder (`*`), or
// targets nobody can know before the command runs (a variable, `xargs`, `find -delete`).
// It is coarse on purpose: a false hit costs one tap, a miss can cost a project. The one place it
// never asks about is a temporary folder (/tmp and the system's own): nothing there is the owner's.

import { tmpdir } from "node:os";
import type { ToolCallInfo } from "@agentherd/protocol";
import type { GuardResult } from "./guard.ts";
import { isInside, type PathContext, pathModFor, resolveWord, sameResolvedPath } from "./paths.ts";
import { basename, programWords, splitCommand, UnparsedCommandError } from "./shell.ts";

export const MASS_DELETE = { id: "mass-delete", reason: "Deletes a lot at once" } as const;

const MISS: GuardResult = { hit: false };
const HIT: GuardResult = { hit: true, ...MASS_DELETE };
const CMD_DELETE_SWITCH = /^\/(?:s|q|f|p|a(?::[A-Za-z-]+)?)$/i;
const DELETE_PROGRAMS = new Set(["rm", "rmdir", "rd", "del", "erase", "remove-item", "ri"]);
const CMD_STYLE_DELETERS = new Set(["rmdir", "rd", "del", "erase"]);
const CD_PROGRAMS = new Set(["cd", "chdir", "set-location"]);

/**
 * The temporary folders: whatever is in them may go without asking ("删tmp里的东西都无所谓",
 * the owner, 2026-11-23). `/tmp` is `/private/tmp` on macOS, and `os.tmpdir()` is the per-user
 * folder under `/var/folders`; both spellings are listed because paths are not followed.
 */
export const TEMP_DIRS: readonly string[] = [
  ...new Set(
    ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", tmpdir()].flatMap((d) =>
      d.startsWith("/var/") ? [d, `/private${d}`] : [d],
    ),
  ),
];

/** True when `target` is inside a temporary folder (or is one, when only its contents go). */
function inTemp(target: string, wholeFolder: boolean): boolean {
  return TEMP_DIRS.some(
    (dir) => isInside(target, dir) && (!sameResolvedPath(target, dir) || !wholeFolder),
  );
}

/** True when deleting `word` would remove more than files the agent can name one by one. */
function isWide(word: string, ctx: PathContext, here: string = ctx.cwd): boolean {
  // `src/*.log` is narrow; `*`, `*.*`, `./*`, `dir/*`, `dir\*.*` or `.*` empties a folder.
  const base = pathModFor(word, here, ctx.cwd).basename(word);
  const emptiesFolder = base === "*" || base === ".*" || base === "*.*";
  const stripped = word.replace(/[\\/](?:\*|\.\*|\*\.\*)$/, "");
  const target = stripped === "" ? "/" : /^[A-Za-z]:$/.test(stripped) ? `${stripped}\\` : stripped;
  const resolved = resolveWord(target, { ...ctx, cwd: here });
  // Anything inside a temporary folder, even all of it, is fine; the folder itself is not, and
  // neither is the project or a folder holding it when the project itself lives in one.
  if (
    resolved !== null &&
    !isInside(ctx.cwd, resolved) &&
    inTemp(resolved, !emptiesFolder || stripped === word)
  ) {
    return false;
  }
  if (emptiesFolder) return true;
  if (resolved === null) return true;
  if (!isInside(resolved, ctx.cwd)) return true;
  if (sameResolvedPath(resolved, ctx.cwd)) return true;
  return false;
}

function rmTargets(args: readonly string[], allowCmdSwitches: boolean): string[] {
  const targets: string[] = [];
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as string;
    if (!endOfOptions && word === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && /^\d*(>>?|<|&>>?)&?$/.test(word)) {
      i += 1;
      continue;
    }
    if (!endOfOptions && allowCmdSwitches && CMD_DELETE_SWITCH.test(word)) continue;
    const psPath = !endOfOptions ? /^-(?:Literal)?Path[:=](.+)$/i.exec(word) : null;
    if (psPath !== null) {
      targets.push(psPath[1] as string);
      continue;
    }
    if (!endOfOptions && word.startsWith("-") && word !== "-") continue;
    targets.push(word);
  }
  return targets;
}

/** Whether an agent request deletes a lot at once. */
export function massDeleteCheck(call: ToolCallInfo, ctx: PathContext): GuardResult {
  if (call.kind === "delete" && call.paths.some((p) => isWide(p, ctx))) return HIT;
  if (call.command === undefined || call.command.trim() === "") return MISS;
  let segments: ReturnType<typeof splitCommand>;
  try {
    segments = splitCommand(call.command);
  } catch (error) {
    // A command we cannot read may delete anything; only ask when it mentions a delete.
    if (error instanceof UnparsedCommandError) {
      return /\b(?:rm|rmdir|rd|del|erase|remove-item|ri)\b|-delete\b/i.test(call.command)
        ? HIT
        : MISS;
    }
    throw error;
  }
  // `cd somewhere && rm -r x` deletes relative to where it went.
  let here: string | null = ctx.cwd;
  for (const segment of segments) {
    const words = programWords(segment.words);
    const program = basename(words[0] ?? "");
    const args = words.slice(1);
    if (CD_PROGRAMS.has(program)) {
      const dirArg = /^\/d$/i.test(args[0] ?? "") ? args[1] : args[0];
      here = here === null ? null : resolveWord(dirArg ?? "~", { ...ctx, cwd: here });
      continue;
    }
    if (DELETE_PROGRAMS.has(program) || program === "trash") {
      const targets = rmTargets(args, CMD_STYLE_DELETERS.has(program));
      if (targets.length > 0 && here === null) return HIT;
      if (here !== null && targets.some((t) => isWide(t, ctx, here as string))) return HIT;
    }
    if (program === "xargs") {
      const inner = programWords(args.filter((w) => !w.startsWith("-")));
      if (DELETE_PROGRAMS.has(basename(inner[0] ?? ""))) return HIT;
    }
    if (program === "find") {
      // `find . -name '*.tmp' -delete` picks files by name; without a filter it empties a folder.
      const filtered = args.some((w) => /^-i?(name|path|regex|wholename)$/.test(w));
      const deletes =
        !filtered &&
        (args.includes("-delete") ||
          args.some(
            (w, i) =>
              (w === "-exec" || w === "-execdir") &&
              DELETE_PROGRAMS.has(basename(args[i + 1] ?? "")),
          ));
      if (deletes) return HIT;
    }
  }
  return MISS;
}
