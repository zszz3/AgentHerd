// The guard list: built-in matches that always send a request to the owner.
// docs/spec/04-herder.md §3 "Guard list". It is intentionally coarse: a false hit costs one
// tap, a miss can cost data. It never allows anything; it only says "ask the owner".

import type { ToolCallInfo } from "@agentherd/protocol";
import { globMatch } from "./glob.ts";
import {
  isInside,
  isWinPath,
  type PathContext,
  pathCandidates,
  pathModFor,
  protectedPathMatch,
  resolveWord,
} from "./paths.ts";
import {
  basename,
  programWords,
  type Segment,
  splitCommand,
  UnparsedCommandError,
} from "./shell.ts";

export type GuardResult = { hit: true; id: string; reason: string } | { hit: false };

/** An extra entry from configuration. It adds hits; it can never remove a built-in one. */
export interface ExtraGuard {
  id: string;
  reason: string;
  /** Glob (`*` only) against each command segment, words joined by one space. */
  command?: string;
  /** Any path inside this directory (`~` allowed). */
  pathPrefix?: string;
}

export const BUILT_IN_GUARDS = [
  { id: "rm-outside-cwd", reason: "Recursive delete outside the working directory" },
  { id: "force-push", reason: "Force push" },
  { id: "pipe-to-shell", reason: "Downloaded content piped into a shell or interpreter" },
  { id: "secret-read", reason: "Touches secrets (SSH, cloud or GPG keys, .env, keychain)" },
  { id: "self-config", reason: "Changes AgentHerd's or an agent's permission configuration" },
  { id: "sudo", reason: "Runs as root" },
] as const;

type GuardId = (typeof BUILT_IN_GUARDS)[number]["id"];

const DOWNLOADERS = new Set([
  "curl",
  "wget",
  "iwr",
  "invoke-webrequest",
  "irm",
  "invoke-restmethod",
  "certutil",
  "bitsadmin",
]);
const INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "python",
  "python3",
  "node",
  "perl",
  "ruby",
  "cmd",
  "powershell",
  "pwsh",
  "cscript",
  "wscript",
  "mshta",
  "iex",
  "invoke-expression",
]);
const SECRET_DIRS = [".ssh", ".aws", ".gnupg"];
const SELF_CONFIG_DIRS = [".agentherd", ".codex"];
const CMD_STYLE_DELETERS = new Set(["rd", "rmdir", "del", "erase"]);
const RECURSIVE_DELETE_PROGRAMS = new Set([
  "rm",
  "rd",
  "rmdir",
  "del",
  "erase",
  "remove-item",
  "ri",
]);
const CMD_DELETE_SWITCH = /^\/(?:q|f|p|a(?::[A-Za-z-]+)?)$/i;
const SUDO_WRAPPERS = new Set(["sudo", "doas", "runas", "gsudo"]);

function hit(id: GuardId | string, reason?: string): GuardResult {
  const builtIn = BUILT_IN_GUARDS.find((g) => g.id === id);
  return { hit: true, id, reason: reason ?? builtIn?.reason ?? id };
}

export function guardCheck(
  call: ToolCallInfo,
  ctx: PathContext,
  extraGuards: readonly ExtraGuard[] = [],
  scope: "all" | "configured" = "all",
): GuardResult {
  const configuredOnly = scope === "configured";
  const resolvedPaths = call.paths.map((p) => resolveWord(p, ctx));
  const callPaths = call.paths.map((p, i) => resolvedPaths[i] ?? p);
  const hasPathGuards = Boolean(
    ctx.protectedPaths?.length ||
      ctx.protectedLocationFiles?.length ||
      extraGuards.some((guard) => guard.pathPrefix !== undefined),
  );
  const declared = checkDeclaredPaths(callPaths, ctx);
  if (declared.hit) return declared;
  if (
    configuredOnly &&
    !ctx.protectedPaths?.length &&
    !ctx.protectedLocationFiles?.length &&
    extraGuards.length === 0
  )
    return { hit: false };

  let segments: Segment[] = [];
  if (call.command !== undefined && call.command.trim() !== "") {
    try {
      segments = splitCommand(call.command);
    } catch (error) {
      if (!(error instanceof UnparsedCommandError)) throw error;
      const explicit = checkExtra(extraGuards, [], callPaths, ctx);
      if (explicit.hit) return explicit;
      return !configuredOnly || hasPathGuards ? hit("unparsed", error.message) : { hit: false };
    }
  }

  const commandPaths: string[] = [];
  let unresolved = resolvedPaths.some((p) => p === null);
  for (const segment of segments) {
    for (const word of segment.words) {
      for (const candidate of pathCandidates(word)) {
        const resolved = resolveWord(candidate, ctx);
        if (resolved === null) unresolved = true;
        else commandPaths.push(resolved);
      }
    }
  }
  const allPaths = [...callPaths, ...commandPaths];
  const commandGuard = checkDeclaredPaths(commandPaths, ctx);
  if (commandGuard.hit) return commandGuard;
  const extra = checkExtra(extraGuards, segments, allPaths, ctx);
  if (unresolved && hasPathGuards) {
    return extra.hit
      ? extra
      : hit("unparsed", "A target could not be resolved against configured path guards");
  }
  if (configuredOnly) return extra;

  const results: GuardResult[] = [
    checkRm(call, segments, callPaths, ctx),
    checkForcePush(segments),
    checkPipeToShell(segments),
    checkSecrets(segments, allPaths, ctx),
    checkSelfConfig(allPaths, ctx),
    checkSudo(segments),
    extra,
  ];
  return results.find((r) => r.hit) ?? { hit: false };
}

function checkDeclaredPaths(paths: readonly string[], ctx: PathContext): GuardResult {
  let uncertain = false;
  for (const [roots, locationFile] of [
    [ctx.protectedLocationFiles, true],
    [ctx.protectedPaths, false],
  ] as const) {
    for (const root of roots ?? []) {
      for (const target of paths) {
        const comparison = protectedPathMatch(target, root, locationFile);
        if (comparison === "match") return hit("self-config");
        if (comparison === "uncertain") uncertain = true;
      }
    }
  }
  return uncertain
    ? hit(
        "self-config",
        "A protected data path may match, but its filesystem identity could not be checked",
      )
    : { hit: false };
}

function isRecursiveFlag(word: string, allowCmdSwitch = false): boolean {
  if (allowCmdSwitch && /^\/s$/i.test(word)) return true;
  if (word === "--recursive" || /^--?rec(?:urse)?$/i.test(word)) return true;
  return /^-[A-Za-z]*[rR][A-Za-z]*$/.test(word);
}

function rmTargetsEscape(
  args: readonly string[],
  ctx: PathContext,
  allowCmdSwitches = false,
): boolean {
  let recursive = false;
  const targets: string[] = [];
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as string;
    if (!endOfOptions && word === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && /^\d*(>>?|<|&>>?)&?$/.test(word)) {
      i += 1; // skip the redirection target
      continue;
    }
    if (!endOfOptions && isRecursiveFlag(word, allowCmdSwitches)) {
      recursive = true;
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
  if (!recursive) return false;
  return targets.some((t) => {
    const resolved = resolveWord(t, ctx);
    return resolved === null || !isInside(resolved, ctx.cwd);
  });
}

function checkRm(
  call: ToolCallInfo,
  segments: readonly Segment[],
  callPaths: readonly string[],
  ctx: PathContext,
): GuardResult {
  if (call.kind === "delete" && callPaths.some((p) => !isInside(p, ctx.cwd))) {
    return hit("rm-outside-cwd");
  }
  for (const segment of segments) {
    const words = programWords(segment.words);
    const program = basename(words[0] ?? "");
    if (
      RECURSIVE_DELETE_PROGRAMS.has(program) &&
      rmTargetsEscape(words.slice(1), ctx, CMD_STYLE_DELETERS.has(program))
    ) {
      return hit("rm-outside-cwd");
    }
    // `xargs rm -r` and `find -exec rm -r`: the targets are unknown.
    if (program === "xargs") {
      const inner = programWords(words.slice(1).filter((w) => !w.startsWith("-")));
      const innerProg = basename(inner[0] ?? "");
      if (
        RECURSIVE_DELETE_PROGRAMS.has(innerProg) &&
        words.some((w) => isRecursiveFlag(w, CMD_STYLE_DELETERS.has(innerProg)))
      ) {
        return hit("rm-outside-cwd");
      }
    }
    if (program === "find") {
      const exec = words.findIndex((w) => w === "-exec" || w === "-execdir");
      const execProg = exec === -1 ? "" : basename(words[exec + 1] ?? "");
      if (exec !== -1 && RECURSIVE_DELETE_PROGRAMS.has(execProg)) {
        if (
          words.slice(exec + 2).some((w) => isRecursiveFlag(w, CMD_STYLE_DELETERS.has(execProg)))
        ) {
          return hit("rm-outside-cwd");
        }
      }
    }
  }
  return { hit: false };
}

function checkForcePush(segments: readonly Segment[]): GuardResult {
  for (const segment of segments) {
    const words = programWords(segment.words);
    if (basename(words[0] ?? "") !== "git") continue;
    const push = words.indexOf("push");
    if (push === -1) continue;
    const args = words.slice(push + 1);
    const forced = args.some(
      (w) =>
        w === "--force" ||
        w.startsWith("--force-with-lease") ||
        w === "--force-if-includes" ||
        /^-[A-Za-z]*f[A-Za-z]*$/.test(w) ||
        (w.startsWith("+") && w.length > 1),
    );
    if (forced) return hit("force-push");
  }
  return { hit: false };
}

function checkPipeToShell(segments: readonly Segment[]): GuardResult {
  let downloadInPipeline = false;
  for (const segment of segments) {
    if (segment.joinedBy !== "|") downloadInPipeline = false;
    const program = basename(programWords(segment.words)[0] ?? "");
    if (segment.joinedBy === "|" && downloadInPipeline && INTERPRETERS.has(program)) {
      return hit("pipe-to-shell");
    }
    if (DOWNLOADERS.has(program)) downloadInPipeline = true;
  }
  return { hit: false };
}

function isSecretPath(p: string, ctx: PathContext): boolean {
  const homePath = pathModFor(ctx.home);
  if (SECRET_DIRS.some((d) => isInside(p, homePath.join(ctx.home, d)))) return true;
  return /^\.env(\..+)?$/i.test(pathModFor(p).basename(p));
}

function checkSecrets(
  segments: readonly Segment[],
  paths: readonly string[],
  ctx: PathContext,
): GuardResult {
  if (paths.some((p) => isSecretPath(p, ctx))) return hit("secret-read");
  for (const segment of segments) {
    const words = programWords(segment.words);
    const program = basename(words[0] ?? "");
    const args = words.slice(1);
    if (program === "security") {
      const sub = words[1] ?? "";
      if (/^find-.*-password$/.test(sub) || sub === "dump-keychain") return hit("secret-read");
    }
    if ((program === "cmdkey" || program === "vaultcmd") && args.some((w) => /^\/list/i.test(w))) {
      return hit("secret-read");
    }
    if (program === "reg") {
      const sub = (args[0] ?? "").toLowerCase();
      if (
        (sub === "export" || sub === "save") &&
        args.slice(1).some((w) => /(?:^|[\\/])(sam|security)(?:$|[\\/])/i.test(w))
      ) {
        return hit("secret-read");
      }
    }
  }
  return { hit: false };
}

function checkSelfConfig(paths: readonly string[], ctx: PathContext): GuardResult {
  const homePath = pathModFor(ctx.home);
  for (const p of paths) {
    if (SELF_CONFIG_DIRS.some((d) => isInside(p, homePath.join(ctx.home, d)))) {
      return hit("self-config");
    }
    const pPath = pathModFor(p);
    if (
      pPath.basename(pPath.dirname(p)).toLowerCase() === ".claude" &&
      /^settings.*\.json$/i.test(pPath.basename(p))
    ) {
      return hit("self-config");
    }
  }
  return { hit: false };
}

function isElevatedStartProcess(words: readonly string[]): boolean {
  if (basename(words[0] ?? "") !== "start-process") return false;
  for (let i = 1; i < words.length; i++) {
    const w = (words[i] as string).toLowerCase();
    if (w === "-verb" && (words[i + 1] ?? "").toLowerCase() === "runas") return true;
    if (/^-verb[:=]runas$/i.test(w)) return true;
  }
  return false;
}

function checkSudo(segments: readonly Segment[]): GuardResult {
  for (const segment of segments) {
    // Words before the real program: assignments and wrappers (`env`, `nohup`, `sudo`, ...).
    const words = programWords(segment.words);
    const prefix = segment.words.slice(0, segment.words.length - words.length);
    if (prefix.some((w) => SUDO_WRAPPERS.has(basename(w))) || isElevatedStartProcess(words)) {
      return hit("sudo");
    }
  }
  return { hit: false };
}

function checkExtra(
  extra: readonly ExtraGuard[],
  segments: readonly Segment[],
  paths: readonly string[],
  ctx: PathContext,
): GuardResult {
  const winCtx = isWinPath(ctx.cwd) || isWinPath(ctx.home);
  for (const guard of extra) {
    const command = guard.command;
    if (
      command !== undefined &&
      segments.some((s) =>
        globMatch(command, s.words.join(" "), { caseInsensitive: winCtx || isWinPath(command) }),
      )
    ) {
      return hit(guard.id, guard.reason);
    }
    if (guard.pathPrefix !== undefined) {
      const dir = resolveWord(guard.pathPrefix, ctx);
      if (dir !== null && paths.some((p) => isInside(p, dir))) return hit(guard.id, guard.reason);
    }
  }
  return { hit: false };
}
