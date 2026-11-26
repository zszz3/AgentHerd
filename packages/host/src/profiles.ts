// Built-in agent profiles. A profile with the same id in config.json replaces a built-in one.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentProfile } from "@agentherd/protocol";
import { AGENTS, agentDef, agentProfile } from "./catalog.ts";
import { nodeEnv } from "./runtimes.ts";

const MOCK_BIN = fileURLToPath(new URL("../../mock-agent/bin/mock-agent.ts", import.meta.url));
const PI_ACP_BIN = fileURLToPath(new URL("../../pi-acp/bin/pi-acp.ts", import.meta.url));

/** Case-insensitive env lookup (Windows `process.env` copies may carry `Path` instead of `PATH`). */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === lower && v !== undefined) return v;
  }
  return undefined;
}

/** Folders where npm, Homebrew and package managers put CLIs; GUI apps often lack them on PATH. */
export function extraBinDirs(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === "win32") {
    const appData = envValue(env, "APPDATA") ?? win32.join(home, "AppData", "Roaming");
    const localAppData = envValue(env, "LOCALAPPDATA") ?? win32.join(home, "AppData", "Local");
    const programFiles = envValue(env, "ProgramFiles") ?? "C:\\Program Files";
    return [
      win32.join(appData, "npm"),
      win32.join(localAppData, "pnpm"),
      win32.join(localAppData, "Yarn", "bin"),
      win32.join(home, ".bun", "bin"),
      win32.join(home, ".local", "bin"),
      win32.join(home, "scoop", "shims"),
      win32.join(home, ".cargo", "bin"),
      win32.join(programFiles, "nodejs"),
    ];
  }
  return [
    join(home, ".local/bin"),
    join(home, ".npm-global/bin"),
    join(home, ".bun/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

/**
 * PATH of the user's login shell, then the current PATH, then extraBinDirs(). The login shell is
 * asked once; it fails quietly (no shell, slow profile) and then the other two still apply.
 */
export function searchPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const sep = platform === "win32" ? win32.delimiter : posix.delimiter;
  let login = "";
  const shell = envValue(env, "SHELL");
  if (shell !== undefined && shell !== "" && platform !== "win32" && process.platform !== "win32") {
    try {
      login = execFileSync(shell, ["-ilc", 'printf "%s" "$PATH"'], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      login = "";
    }
  }
  const current = envValue(env, "PATH") ?? "";
  const dirs = [...login.split(sep), ...current.split(sep), ...extraBinDirs(home, platform, env)];
  return [...new Set(dirs.filter((d) => d !== ""))].join(sep);
}

/**
 * Paths a command `name` may have in `dir`. On Windows only names with a PATHEXT extension run;
 * npm puts an extensionless shell script beside its `.cmd` shim, which must not be picked.
 */
export function commandCandidates(
  dir: string,
  name: string,
  platform: NodeJS.Platform = process.platform,
  pathext: string | undefined = process.env.PATHEXT,
): string[] {
  if (platform !== "win32") return [posix.join(dir, name)];
  const exts = (pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e !== "");
  if (exts.some((e) => name.toLowerCase().endsWith(e.toLowerCase()))) {
    return [win32.join(dir, name)];
  }
  return exts.map((e) => win32.join(dir, `${name}${e.toLowerCase()}`));
}

/** The first of `names` found on `path` (a PATH value), searching folder by folder. */
export function onPath(
  names: readonly string[],
  path: string | undefined,
  exists: (p: string) => boolean,
  platform: NodeJS.Platform = process.platform,
  pathext?: string,
): string | undefined {
  const sep = platform === "win32" ? win32.delimiter : posix.delimiter;
  for (const dir of (path ?? "").split(sep)) {
    if (dir === "") continue;
    for (const name of names) {
      const found = commandCandidates(dir, name, platform, pathext).find((c) => exists(c));
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Runs `reg.exe`; throws when it fails or finds nothing. */
export type RegQuery = (args: string[]) => string;

const regQuery: RegQuery = (args) => {
  const regExe = win32.join(
    envValue(process.env, "SystemRoot") ?? envValue(process.env, "windir") ?? "C:\\Windows",
    "System32",
    "reg.exe",
  );
  return execFileSync(regExe, args, {
    encoding: "utf8",
    timeout: 3000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
};

/** The CLI launcher inside the DeepSeek Harness desktop app on macOS (ADR 0106). */
export const DSH_MAC_BIN =
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";

/** The CLI launcher inside the Windows install folder of DeepSeek Harness. */
export const DSH_WINDOWS_LAUNCHER = "resources\\runtime\\cli\\bin\\dsh.cmd";

/**
 * Install folders of DeepSeek Harness from the uninstall entries in `reg query /s /f ... /d`
 * output: an entry whose DisplayName starts with the app name, through its DisplayIcon
 * (`<folder>\DeepSeek Harness.exe,0`), else its InstallLocation. The installer lets the owner
 * pick any folder.
 */
export function dshInstallDirs(output: string): string[] {
  const dirs: string[] = [];
  let name = "";
  let icon = "";
  let installLocation = "";
  const flush = () => {
    if (name.startsWith("DeepSeek Harness")) {
      if (icon !== "") dirs.push(win32.dirname(icon));
      else if (installLocation !== "") dirs.push(installLocation);
    }
    name = "";
    icon = "";
    installLocation = "";
  };
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("HKEY_")) {
      flush();
      continue;
    }
    const value = /^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/.exec(line);
    if (value === null) continue;
    const data = (value[2] ?? "").trim();
    if (value[1] === "DisplayName") name = data;
    if (value[1] === "DisplayIcon") icon = data.replace(/,-?\d+$/, "").replace(/^"(.*)"$/, "$1");
    if (value[1] === "InstallLocation") installLocation = data.replace(/^"(.*)"$/, "$1");
  }
  flush();
  return [...new Set(dirs)];
}

/**
 * Where the DeepSeek Harness desktop app keeps its CLI: the macOS bundle; on Windows the launcher
 * in each install folder the uninstall entries name (per-user, then all users and WOW6432Node).
 */
export function dshAppBins(
  platform: NodeJS.Platform = process.platform,
  query: RegQuery = regQuery,
): string[] {
  if (platform === "darwin") return [DSH_MAC_BIN];
  if (platform !== "win32") return [];
  const keys = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  const bins: string[] = [];
  for (const key of keys) {
    let output: string;
    try {
      output = query(["query", key, "/s", "/f", "DeepSeek Harness", "/d"]);
    } catch {
      continue;
    }
    for (const dir of dshInstallDirs(output)) bins.push(win32.join(dir, DSH_WINDOWS_LAUNCHER));
  }
  return [...new Set(bins)];
}

/** The Codex CLI inside the package folder of OpenAI's Codex (ChatGPT) desktop app. */
export const CODEX_WINDOWS_CLI = "app\\resources\\codex.exe";

/** Where Windows records the folder of each Store app the user has installed. */
const APPX_PACKAGES =
  "HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages";

/**
 * Package folders of the Codex desktop app from `reg query <packages> /s /v PackageRootFolder`
 * output, newest version first. Keys are `OpenAI.Codex_<version>_<arch>__<publisher>`.
 */
export function codexPackageRoots(output: string): string[] {
  const found: { version: number[]; root: string }[] = [];
  let version: number[] | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("HKEY_")) {
      const key = /\\OpenAI\.Codex_(\d+(?:\.\d+)*)_[^\\]*$/.exec(line.trim());
      version = key === null ? undefined : (key[1] ?? "").split(".").map(Number);
      continue;
    }
    const value = /^\s+PackageRootFolder\s+REG_(?:EXPAND_)?SZ\s+(.*)$/.exec(line);
    if (value !== null && version !== undefined) {
      found.push({ version, root: (value[1] ?? "").trim() });
    }
  }
  const newer = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (b[i] ?? 0) - (a[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  return found.sort((a, b) => newer(a.version, b.version)).map((f) => f.root);
}

/**
 * Where the Codex desktop app may keep its CLI (Windows only, newest first). codex-acp can run
 * it through `CODEX_PATH` instead of the large CLI build npm would download.
 */
export function codexAppClis(
  platform: NodeJS.Platform = process.platform,
  query: RegQuery = regQuery,
): string[] {
  if (platform !== "win32") return [];
  let output: string;
  try {
    output = query(["query", APPX_PACKAGES, "/s", "/v", "PackageRootFolder"]);
  } catch {
    return [];
  }
  return codexPackageRoots(output).map((root) => win32.join(root, CODEX_WINDOWS_CLI));
}

/** The built-in `mock` profile plays a YAML script. */
export function mockProfile(script: string): AgentProfile {
  return {
    id: "mock",
    name: "Mock agent",
    command: [process.execPath, MOCK_BIN, "--script", script],
    env: nodeEnv(),
    exporter: null,
  };
}

/**
 * Finds an agent's CLI without the app's downloads: its env variable (`AGENTHERD_PI`, …), then
 * its command on `PATH`.
 * @returns The path, or `undefined` when it is not installed.
 */
export function findAgent(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const def = agentDef(id);
  if (def === undefined) return undefined;
  const explicit = envValue(env, def.envVar);
  if (explicit !== undefined && explicit !== "") return explicit;
  return onPath(def.systemNames, envValue(env, "PATH"), exists, platform);
}

/**
 * The built-in `pi` profile: AgentHerd's ACP bridge in front of Pi (ADR 0022). The bridge's gate
 * asks before every tool call except reads inside the task folder.
 * @param bin Path of Pi's CLI.
 * @param modelEnv From `piModelEnv()` when the owner chose a model for Pi; else Pi's own settings.
 */
export function piProfile(bin: string, modelEnv: Record<string, string> = {}): AgentProfile {
  return {
    id: "pi",
    name: "Pi",
    command: [process.execPath, PI_ACP_BIN, "--pi", bin],
    env: { ...nodeEnv(), ...modelEnv },
    exporter: null,
  };
}

/**
 * The profile that starts agent `id` from `bin`: Pi behind the bridge, the others with their
 * ACP arguments and the env that makes them ask before writing (catalog.ts).
 */
export function builtinProfile(
  id: string,
  bin: string,
  piModelEnv: Record<string, string> = {},
  extraEnv: Record<string, string> = {},
): AgentProfile | undefined {
  if (id === "pi") return piProfile(bin, piModelEnv);
  const def = agentDef(id);
  return def === undefined ? undefined : agentProfile(def, bin, extraEnv);
}

/** Env naming the Claude Code CLI that claude-agent-acp runs (read by the Agent SDK). */
export const CLAUDE_EXECUTABLE_ENV = "CLAUDE_CODE_EXECUTABLE";

/**
 * On Windows, the claude.exe behind npm's `claude.cmd`. `spawn` cannot start a `.cmd` without a
 * shell (Node 20.12 refuses it: spawn EINVAL), and that is what the Agent SDK does with the path
 * it is given. Started directly, the exe is fine, so hand it that when it exists.
 */
export function nativeClaude(shim: string, exists: (p: string) => boolean): string | undefined {
  if (!/\.(cmd|ps1|bat)$/i.test(shim) && win32.extname(shim) !== "") return undefined;
  const exe = win32.join(
    win32.dirname(shim),
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "bin",
    "claude.exe",
  );
  return exists(exe) ? exe : undefined;
}

/**
 * The owner's own Claude Code CLI (ADR 0069): `AGENTHERD_CLAUDE_CLI`, `claude` on PATH, or where
 * Anthropic's installers put it (a GUI app has a short PATH). On Windows the PATH entry is npm's
 * shim; the exe behind it is the one that can be started.
 */
export function localClaude(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string | undefined {
  const named = envValue(env, "AGENTHERD_CLAUDE_CLI");
  if (named !== undefined && named !== "") return named;
  const onSystem = onPath(["claude"], envValue(env, "PATH"), exists, platform);
  if (onSystem !== undefined) {
    return platform === "win32" ? (nativeClaude(onSystem, exists) ?? onSystem) : onSystem;
  }
  if (platform === "win32") {
    const localAppData = envValue(env, "LOCALAPPDATA") ?? win32.join(home, "AppData", "Local");
    return [
      win32.join(home, ".local", "bin", "claude.exe"),
      win32.join(home, ".claude", "local", "claude.exe"),
      win32.join(localAppData, "Programs", "claude", "claude.exe"),
    ].find((p) => exists(p));
  }
  return [
    posix.join(home, ".local", "bin", "claude"),
    posix.join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ].find((p) => exists(p));
}

/**
 * Env an agent needs from the machine besides its catalog env: for Codex, `CODEX_PATH` naming
 * the Codex desktop app's CLI when there is one and the owner set none, so codex-acp runs it; for
 * Claude Code, `CLAUDE_CODE_EXECUTABLE` naming the owner's own `claude` (localClaude).
 * @param clis Default: codexAppClis(platform), asked only for Codex.
 */
export function agentEnv(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
  clis: () => string[] = () => codexAppClis(platform),
  home: string = homedir(),
): Record<string, string> {
  if (id === "claude") {
    if ((envValue(env, CLAUDE_EXECUTABLE_ENV) ?? "") !== "") return {};
    const cli = localClaude(env, exists, platform, home);
    return cli === undefined ? {} : { [CLAUDE_EXECUTABLE_ENV]: cli };
  }
  if (id !== "codex" || (envValue(env, "CODEX_PATH") ?? "") !== "") return {};
  const cli = clis().find((p) => exists(p));
  return cli === undefined ? {} : { CODEX_PATH: cli };
}

export interface ResolveOptions {
  script?: string | undefined;
  configured: AgentProfile[];
  /** Path of an agent's CLI. Default: findAgent(). */
  find?: (id: string) => string | undefined;
  /** Env for the `pi` profile's model (see piProfile). */
  piModelEnv?: Record<string, string>;
  /** Machine-specific env of an agent. Default: agentEnv(). */
  agentEnv?: (id: string) => Record<string, string>;
}

/**
 * Resolves a profile id: config.json profiles first, then built-ins.
 * @throws Error with an actionable message when the id is unknown or the agent is not installed.
 */
export function resolveProfile(id: string, opts: ResolveOptions): AgentProfile {
  const configured = opts.configured.find((p) => p.id === id);
  if (configured !== undefined) return configured;
  if (id === "mock") {
    if (opts.script === undefined) throw new Error("--script is required with the mock profile");
    return mockProfile(opts.script);
  }
  const def = agentDef(id);
  if (def !== undefined) {
    const bin = (opts.find ?? ((x: string) => findAgent(x)))(id);
    if (bin === undefined) {
      throw new Error(
        `${def.name} not found. It comes with the desktop app; otherwise install it or set ${def.envVar}.`,
      );
    }
    const extra = (opts.agentEnv ?? ((x: string) => agentEnv(x)))(id);
    return builtinProfile(id, bin, opts.piModelEnv, extra) as AgentProfile;
  }
  const known = ["mock", ...AGENTS.map((a) => a.id), ...opts.configured.map((p) => p.id)];
  throw new Error(`unknown profile "${id}" (known: ${known.join(", ")})`);
}

/**
 * Profiles for `agentherd start`: config.json profiles, then each built-in agent that is
 * installed, then `mock` when a script is given. A configured profile with the same id wins.
 */
export function availableProfiles(opts: ResolveOptions): AgentProfile[] {
  const profiles = [...opts.configured];
  const has = (id: string) => profiles.some((p) => p.id === id);
  const find = opts.find ?? ((x: string) => findAgent(x));
  const extraEnv = opts.agentEnv ?? ((x: string) => agentEnv(x));
  for (const def of AGENTS) {
    if (has(def.id)) continue;
    const bin = find(def.id);
    const profile =
      bin === undefined
        ? undefined
        : builtinProfile(def.id, bin, opts.piModelEnv, extraEnv(def.id));
    if (profile !== undefined) profiles.push(profile);
  }
  if (!has("mock") && opts.script !== undefined) profiles.push(mockProfile(opts.script));
  return profiles;
}
