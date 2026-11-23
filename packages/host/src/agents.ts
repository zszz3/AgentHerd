// The agents the owner can run and where each CLI comes from: the copy that ships inside the app
// (ADR 0067), at the version AgentHerd is adapted to (catalog.ts), a CLI the owner names, or one
// on PATH. Claude Code is not in the app (ADR 0069): the owner's own `claude` runs it, and the app
// downloads the adapted version only when the owner asks (no updates, no downloads on its own).
// The host keeps one Agents and rebuilds profiles when it changes.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentProfile } from "@agentherd/protocol";
import type { AgentSource, AgentView } from "./api.ts";
import { AGENTS, type AgentDef, type Fetchers, httpFetchers, npmRuntime } from "./catalog.ts";
import { agentEnv, CLAUDE_EXECUTABLE_ENV, codexAppClis, envValue, onPath } from "./profiles.ts";
import { currentTarget, type InstallProgress, type RuntimeStore } from "./runtimes.ts";

export interface AgentsOptions {
  /** The agents that ship with the app (Resources/agents; scripts/fetch-agents.ts in dev). */
  bundled?: RuntimeStore;
  /** Downloads on the owner's computer (<home>/runtimes): Claude Code, and an older app's copies. */
  downloaded?: RuntimeStore;
  env?: NodeJS.ProcessEnv;
  /** Agent definitions (tests pass local ones). */
  catalog?: AgentDef[];
  fetchers?: Fetchers;
  target?: string;
  exists?: (path: string) => boolean;
  /** Default: process.platform (decides how PATH is searched). */
  platform?: NodeJS.Platform;
  /** The Codex desktop app's CLI candidates. Default: codexAppClis(platform). */
  codexApps?: string[];
  /** The owner's home (where Anthropic's installer puts `claude`). Default: os.homedir(). */
  userHome?: string;
  onChange: () => void;
  log?: (line: string) => void;
}

interface Install {
  progress: InstallProgress;
  abort: AbortController;
}

export interface AgentPath {
  path: string;
  source: AgentSource;
  version?: string;
}

export class Agents {
  private readonly opts: AgentsOptions;
  private readonly installs = new Map<string, Install>();
  private readonly errors = new Map<string, string>();

  constructor(opts: AgentsOptions) {
    this.opts = opts;
  }

  get catalog(): AgentDef[] {
    return this.opts.catalog ?? AGENTS;
  }

  private get env(): NodeJS.ProcessEnv {
    return this.opts.env ?? process.env;
  }

  private get target(): string {
    return this.opts.target ?? currentTarget();
  }

  private exists(path: string): boolean {
    return (this.opts.exists ?? existsSync)(path);
  }

  /**
   * Where `id` runs from: its env variable, the copy in the app, a download on this computer,
   * then PATH.
   */
  find(id: string): AgentPath | undefined {
    const def = this.catalog.find((d) => d.id === id);
    if (def === undefined) return undefined;
    const explicit = envValue(this.env, def.envVar);
    if (explicit !== undefined && explicit !== "") return { path: explicit, source: "system" };
    const bundled = this.opts.bundled?.installed(id);
    if (bundled !== undefined) {
      return { path: bundled.path, source: "bundled", version: bundled.version };
    }
    const downloaded = this.opts.downloaded?.installed(id);
    // A download without its CLI build runs only with the owner's own CLI (extraEnv).
    if (downloaded !== undefined && this.runnable(def, downloaded.version)) {
      return { path: downloaded.path, source: "managed", version: downloaded.version };
    }
    const onSystem = onPath(
      def.systemNames,
      envValue(this.env, "PATH"),
      (p) => this.exists(p),
      this.opts.platform ?? process.platform,
    );
    if (onSystem !== undefined) return { path: onSystem, source: "system" };
    // A CLI installed under the owner's home is often missing from the app's PATH (ADR 0104).
    const home = this.opts.userHome ?? homedir();
    const inHome = (def.homeBins ?? []).map((p) => join(home, p)).find((p) => this.exists(p));
    return inHome === undefined ? undefined : { path: inHome, source: "system" };
  }

  /** Required files (AgentDef.requires) absent from the download of `version`. */
  private missingFiles(def: AgentDef, version: string): string[] {
    if (def.requires === undefined || this.opts.downloaded === undefined) return [];
    const root = this.opts.downloaded.dir(def.id, version);
    return def.requires(this.target).filter((file) => !this.exists(join(root, file)));
  }

  private runnable(def: AgentDef, version: string): boolean {
    // An older app's copies (Pi, Codex) are kept as they are; the check is for downloads now.
    if (def.onRequest !== true) return true;
    return this.missingFiles(def, version).length === 0 || this.ownCli(def.id) !== undefined;
  }

  /** The owner's own CLI an adapter runs (Claude Code's `claude`), when there is one. */
  ownCli(id: string): string | undefined {
    if (id !== "claude") return undefined;
    return this.extraEnv(id)[CLAUDE_EXECUTABLE_ENV] ?? envValue(this.env, CLAUDE_EXECUTABLE_ENV);
  }

  private codexClis: string[] | undefined;

  /** Machine-specific env of agent `id` (agentEnv); the registry is read once per host. */
  extraEnv(id: string): Record<string, string> {
    const platform = this.opts.platform ?? process.platform;
    return agentEnv(
      id,
      this.env,
      (p) => this.exists(p),
      platform,
      () => {
        this.codexClis ??= this.opts.codexApps ?? codexAppClis(platform);
        return this.codexClis;
      },
      this.opts.userHome,
    );
  }

  views(configured: AgentProfile[], modelRefs: Record<string, string>): AgentView[] {
    const views = this.catalog.map((def) => this.view(def));
    for (const p of configured) {
      const i = views.findIndex((v) => v.id === p.id);
      const view: AgentView = {
        id: p.id,
        name: p.name,
        state: "ready",
        source: "config",
        path: p.command[0] ?? "",
        canInstall: false,
        canRemove: false,
      };
      if (i >= 0) views[i] = view;
      else views.push(view);
    }
    return views.map((v) => {
      const ref = modelRefs[v.id];
      return ref === undefined || v.source === "config" ? v : { ...v, modelRef: ref };
    });
  }

  private view(def: AgentDef): AgentView {
    const own = this.ownCli(def.id);
    const base = {
      id: def.id,
      name: def.name,
      ...(def.version === undefined ? {} : { adapted: def.version }),
      ...(def.onRequest === true ? { onRequest: true } : {}),
      ...(own === undefined ? {} : { ownCli: own }),
    };
    const error = this.errors.get(def.id);
    const withError = error === undefined ? {} : { error };
    const install = this.installs.get(def.id);
    if (install !== undefined) {
      return {
        ...base,
        state: "installing",
        progress: install.progress,
        canInstall: false,
        canRemove: false,
      };
    }
    const found = this.find(def.id);
    if (found === undefined) {
      return {
        ...base,
        state: "missing",
        canInstall: def.onRequest === true && def.release !== undefined,
        canRemove: this.opts.downloaded?.installed(def.id) !== undefined,
        ...withError,
      };
    }
    return {
      ...base,
      state: "ready",
      source: found.source,
      path: found.path,
      ...(found.version === undefined ? {} : { version: found.version }),
      // No updates from the app: the version is the one in the catalog.
      canInstall: false,
      canRemove: found.source === "managed",
      ...withError,
    };
  }

  /**
   * Downloads the adapted version of an agent that is not in the app (ADR 0069), only when the
   * owner asks; onChange fires on progress and at the end. With the owner's own CLI at hand only
   * the adapter comes down, not the CLI build.
   */
  install(id: string): void {
    const def = this.catalog.find((d) => d.id === id);
    if (def?.release === undefined || def.onRequest !== true) {
      throw new Error(`AgentHerd does not download "${id}"; it comes with the app`);
    }
    if (this.find(id) !== undefined) {
      throw new Error(`${def.name} is installed; AgentHerd does not update agents`);
    }
    if (this.installs.has(id)) return;
    const install: Install = { progress: { received: 0, total: 0 }, abort: new AbortController() };
    this.installs.set(id, install);
    this.errors.delete(id);
    this.opts.onChange();
    const progress = (p: InstallProgress) => {
      install.progress = p;
      this.opts.onChange();
    };
    this.download(def, progress, install.abort.signal)
      .then(
        (path) => this.opts.log?.(`[agents] installed ${id} at ${path}`),
        (error: Error) => {
          if (!install.abort.signal.aborted) this.errors.set(id, error.message);
          this.opts.log?.(`[agents] could not install ${id}: ${error.message}`);
        },
      )
      .finally(() => {
        this.installs.delete(id);
        this.opts.onChange();
      });
  }

  private async download(
    def: AgentDef,
    onProgress: (p: InstallProgress) => void,
    signal: AbortSignal,
  ): Promise<string> {
    const store = this.opts.downloaded;
    if (store === undefined) throw new Error("no place to download agents to");
    const fetchers = this.opts.fetchers ?? httpFetchers;
    const release = await def.release?.(this.target, fetchers);
    if (release === undefined) throw new Error(`${def.name} has no build for ${this.target}`);
    let npmCli: string | undefined;
    if (release.kind === "npm") {
      const npm = await npmRuntime(fetchers);
      npmCli = (await store.install(npm, { signal })).path;
    }
    const own = this.ownCli(def.id) !== undefined;
    const installed = await store.install(
      release.kind !== "npm"
        ? release
        : own
          ? { ...release, omitOptional: true }
          : { ...release, requires: def.requires?.(this.target) ?? [] },
      { onProgress, signal, ...(npmCli === undefined ? {} : { npmCli }) },
    );
    return installed.path;
  }

  cancel(id: string): void {
    this.installs.get(id)?.abort.abort();
  }

  /** Removes a download; the copy in the app (or on PATH) takes over. */
  remove(id: string): void {
    if (this.opts.downloaded?.installed(id) === undefined) {
      throw new Error(`"${id}" was not downloaded by AgentHerd`);
    }
    if (this.installs.has(id)) throw new Error("wait for the download to finish or cancel it");
    this.opts.downloaded.remove(id);
    this.errors.delete(id);
    this.opts.onChange();
  }

  /** Waits for running downloads (tests). */
  async idle(): Promise<void> {
    while (this.installs.size > 0) await new Promise((r) => setTimeout(r, 20));
  }

  stop(): void {
    for (const i of this.installs.values()) i.abort.abort();
  }
}
