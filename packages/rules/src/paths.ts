import path from "node:path";

export interface PathContext {
  cwd: string;
  home: string;
  protectedPaths?: readonly string[] | undefined;
}

/** True when `s` uses Windows drive, UNC, or backslash syntax. */
export function isWinPath(s: string): boolean {
  return /^[A-Za-z]:|^\\\\|\\/.test(s);
}

/** Pick `path.win32` or `path.posix` consistently from any involved paths. */
export function pathModFor(...paths: string[]): typeof path.posix | typeof path.win32 {
  return paths.some(isWinPath) ? path.win32 : path.posix;
}

/** Strip extended-length `\\?\` prefix before resolving/comparing on Windows. */
function stripExtendedPrefix(p: string): string {
  if (/^\\\\\?\\UNC\\/i.test(p)) return `\\\\${p.slice(8)}`;
  if (/^\\\\\?\\[A-Za-z]:/.test(p)) return p.slice(4);
  return p;
}

/**
 * Resolve a word that may be a path. `~`, `~/`, `~\`, `$HOME` and `${HOME}` expand to `home`;
 * relative paths resolve against `cwd`. Returns `null` when the word holds another variable
 * (`$...` or `%...%`), because its value is unknown.
 */
export function resolveWord(word: string, ctx: PathContext): string | null {
  let w = word;
  if (w === "~" || w.startsWith("~/") || w.startsWith("~\\")) w = ctx.home + w.slice(1);
  w = w.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, ctx.home);
  if (w.includes("$") || /%[^%\s]+%/.test(w)) return null;
  const p = pathModFor(ctx.cwd, ctx.home, w);
  return p === path.win32
    ? p.resolve(stripExtendedPrefix(ctx.cwd), stripExtendedPrefix(w))
    : p.resolve(ctx.cwd, w);
}

/** True when `target` is `dir` or inside it. Both must be absolute. */
export function isInside(target: string, dir: string): boolean {
  const p = pathModFor(target, dir);
  if (p === path.win32) {
    const d = p.resolve(stripExtendedPrefix(dir)).toLowerCase();
    const t = p.resolve(stripExtendedPrefix(target)).toLowerCase();
    const rel = p.relative(d, t);
    return (
      rel === "" ||
      (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !p.isAbsolute(rel))
    );
  }
  const rel = p.relative(p.resolve(dir), p.resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !p.isAbsolute(rel));
}

/** True when two paths resolve to the same location (case-insensitive for Windows paths). */
export function sameResolvedPath(a: string, b: string): boolean {
  const p = pathModFor(a, b);
  if (p === path.win32) {
    return (
      p.resolve(stripExtendedPrefix(a)).toLowerCase() ===
      p.resolve(stripExtendedPrefix(b)).toLowerCase()
    );
  }
  return p.resolve(a) === p.resolve(b);
}

/**
 * Values a word may carry as a path: the word itself, the part after `=` in `--opt=value`, the
 * path after `-Param:` in PowerShell, and the part after a leading `@` (`curl -d @file`).
 */
export function pathCandidates(word: string): string[] {
  let value = word;
  if (word.startsWith("-")) {
    const eq = word.indexOf("=");
    const colonPath = /^--?[A-Za-z][A-Za-z0-9_-]*:(?=[A-Za-z]:|[~.\\/%])/i.exec(word);
    if (eq !== -1 && (colonPath === null || eq < colonPath[0].length)) {
      value = word.slice(eq + 1);
    } else if (colonPath !== null) {
      value = word.slice(colonPath[0].length);
    }
  }
  return value.startsWith("@") && value.length > 1 ? [value, value.slice(1)] : [value];
}
