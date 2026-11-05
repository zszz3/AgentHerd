// Built-in agent profiles. A profile with the same id in config.json replaces a built-in one.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentProfile } from "@agentherd/protocol";
import { AGENTS, agentDef, agentProfile, DSH_APP_LAUNCHER } from "./catalog.ts";
import { nodeEnv } from "./runtimes.ts";

const MOCK_BIN = fileURLToPath(new URL("../../mock-agent/bin/mock-agent.ts", import.meta.url));
const PI_ACP_BIN = fileURLToPath(new URL("../../pi-acp/bin/pi-acp.ts", import.meta.url));

/** Folders where npm, Homebrew and installers put CLIs; an app opened from Finder lacks them on PATH. */
export function extraBinDirs(home: string = homedir()): string[] {
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
export function searchPath(env: NodeJS.ProcessEnv = process.env): string {
  let login = "";
  const shell = env.SHELL;
  if (shell !== undefined && shell !== "" && process.platform !== "win32") {
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
  const dirs = [...login.split(delimiter), ...(env.PATH ?? "").split(delimiter), ...extraBinDirs()];
  return [...new Set(dirs.filter((d) => d !== ""))].join(delimiter);
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
): string | undefined {
  const sep = platform === "win32" ? win32.delimiter : posix.delimiter;
  for (const dir of (path ?? "").split(sep)) {
    if (dir === "") continue;
    for (const name of names) {
      const found = commandCandidates(dir, name, platform).find((c) => exists(c));
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Where the DeepSeek Harness desktop app keeps its CLI. */
export const DSH_APP_BIN = `/Applications/${DSH_APP_LAUNCHER}`;

/** The CLI launcher inside the Windows install folder of DeepSeek Harness. */
export const DSH_WINDOWS_LAUNCHER = "resources\\runtime\\cli\\bin\\dsh.cmd";

/** Runs `reg.exe`; throws when it fails or finds nothing. */
export type RegQuery = (args: string[]) => string;

const regQuery: RegQuery = (args) =>
  execFileSync("reg", args, {
    encoding: "utf8",
    timeout: 3000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });

/**
 * Install folders of DeepSeek Harness from the uninstall entries in `reg query /s /f ... /d`
 * output: an entry whose DisplayName starts with the app name, through its DisplayIcon
 * (`<folder>\DeepSeek Harness.exe,0`). The installer may put the app in any folder.
 */
export function dshInstallDirs(output: string): string[] {
  const dirs: string[] = [];
  let name = "";
  let icon = "";
  const flush = () => {
    if (name.startsWith("DeepSeek Harness") && icon !== "") dirs.push(win32.dirname(icon));
    name = "";
    icon = "";
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
  }
  flush();
  return dirs;
}

/**
 * Where the DeepSeek Harness desktop app may keep its CLI: the macOS bundle; on Windows the
 * launcher in each install folder the uninstall entries name (per-user, then all users).
 */
export function dshAppBins(
  platform: NodeJS.Platform = process.platform,
  query: RegQuery = regQuery,
): string[] {
  if (platform === "darwin") return [DSH_APP_BIN];
  if (platform !== "win32") return [];
  const bins: string[] = [];
  for (const root of ["HKCU", "HKLM"]) {
    const key = `${root}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`;
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
 * Finds an agent's CLI without the app's downloads: its env variable (`AGENTHERD_DSH`, …), then
 * its command on `PATH`, then (DSH) the desktop app. On Windows the DSH app comes before PATH:
 * the `dsh` there is usually the separate npm launcher, which serves ACP only when its own
 * `acp` profile bundle is installed, while the app ships every profile.
 * @param appBins Default: dshAppBins(platform), asked only for DSH.
 * @returns The path, or `undefined` when it is not installed.
 */
export function findAgent(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
  appBins: () => string[] = () => dshAppBins(platform),
): string | undefined {
  const def = agentDef(id);
  if (def === undefined) return undefined;
  const explicit = env[def.envVar];
  if (explicit !== undefined && explicit !== "") return explicit;
  const app = () => (id === "dsh" ? appBins().find((p) => exists(p)) : undefined);
  if (platform === "win32") {
    const fromApp = app();
    if (fromApp !== undefined) return fromApp;
  }
  const found = onPath(def.systemNames, env.PATH, exists, platform);
  if (found !== undefined) return found;
  return platform === "win32" ? undefined : app();
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

/**
 * Env an agent needs from the machine besides its catalog env: for Codex, `CODEX_PATH` naming
 * the Codex desktop app's CLI when there is one and the owner set none, so codex-acp runs it.
 * @param clis Default: codexAppClis(platform), asked only for Codex.
 */
export function agentEnv(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
  clis: () => string[] = () => codexAppClis(platform),
): Record<string, string> {
  if (id !== "codex" || (env.CODEX_PATH ?? "") !== "") return {};
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
        `${def.name} not found. Download it on the Agent page of the desktop app, or set ${def.envVar}.`,
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
