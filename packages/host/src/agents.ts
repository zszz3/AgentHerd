// The agents the owner can run, where each CLI comes from, and downloads of their latest releases
// (catalog.ts, runtimes.ts). The host keeps one Agents and rebuilds profiles when it changes.

import { existsSync } from "node:fs";
import type { AgentProfile } from "@agentherd/protocol";
import type { AgentSource, AgentView } from "./api.ts";
import { AGENTS, type AgentDef, type Fetchers, httpFetchers, npmRuntime } from "./catalog.ts";
import { agentEnv, codexAppClis, dshAppBins, onPath } from "./profiles.ts";
import { currentTarget, type InstallProgress, type RuntimeStore } from "./runtimes.ts";

export interface AgentsOptions {
  store: RuntimeStore;
  env?: NodeJS.ProcessEnv;
  /** Agent definitions (tests pass local ones). */
  catalog?: AgentDef[];
  fetchers?: Fetchers;
  target?: string;
  exists?: (path: string) => boolean;
  /** Default: process.platform (decides how PATH is searched). */
  platform?: NodeJS.Platform;
  /** The DeepSeek Harness desktop app's CLI, when installed. */
  dshApp?: string;
  /** The Codex desktop app's CLI candidates. Default: codexAppClis(platform). */
  codexApps?: string[];
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

  private exists(path: string): boolean {
    return (this.opts.exists ?? existsSync)(path);
  }

  /** Where `id` runs from: its env variable, then the app's download, then PATH and the DSH app. */
  find(id: string): AgentPath | undefined {
    const def = this.catalog.find((d) => d.id === id);
    if (def === undefined) return undefined;
    const explicit = this.env[def.envVar];
    if (explicit !== undefined && explicit !== "") return { path: explicit, source: "system" };
    const managed = this.opts.store.installed(id);
    if (managed !== undefined) {
      return { path: managed.path, source: "managed", version: managed.version };
    }
    const platform = this.opts.platform ?? process.platform;
    const app = (): AgentPath | undefined => {
      if (id !== "dsh") return undefined;
      const path = this.dshApps(platform).find((p) => this.exists(p));
      return path === undefined ? undefined : { path, source: "app" };
    };
    // On Windows the app comes first: the `dsh` on PATH is usually the npm launcher, which
    // lacks the `acp` profile unless installed separately (see findAgent).
    if (platform === "win32") {
      const fromApp = app();
      if (fromApp !== undefined) return fromApp;
    }
    const onSystem = onPath(def.systemNames, this.env.PATH, (p) => this.exists(p), platform);
    if (onSystem !== undefined) return { path: onSystem, source: "system" };
    return platform === "win32" ? undefined : app();
  }

  private appBins: string[] | undefined;

  /** The DSH app's CLI candidates; the registry is read once per host. */
  private dshApps(platform: NodeJS.Platform): string[] {
    if (this.opts.dshApp !== undefined) return [this.opts.dshApp];
    this.appBins ??= dshAppBins(platform);
    return this.appBins;
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
    const base = { id: def.id, name: def.name };
    const error = this.errors.get(def.id);
    const withError = error === undefined ? {} : { error };
    const install = this.installs.get(def.id);
    const canInstall = def.latest !== undefined;
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
      return { ...base, state: "missing", canInstall, canRemove: false, ...withError };
    }
    return {
      ...base,
      state: "ready",
      source: found.source,
      path: found.path,
      ...(found.version === undefined ? {} : { version: found.version }),
      // A download replaces the copy in use with the latest release.
      canInstall: canInstall && found.source === "managed",
      canRemove: found.source === "managed",
      ...withError,
    };
  }

  /** Starts a download of the latest release; onChange fires on progress and at the end. */
  install(id: string): void {
    const def = this.catalog.find((d) => d.id === id);
    if (def?.latest === undefined) throw new Error(`AgentHerd cannot download "${id}"`);
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
    const fetchers = this.opts.fetchers ?? httpFetchers;
    const target = this.opts.target ?? currentTarget();
    const release = await def.latest?.(target, fetchers);
    if (release === undefined) throw new Error(`${def.name} has no build for ${target}`);
    let npmCli: string | undefined;
    if (release.kind === "npm") {
      const npm = await npmRuntime(fetchers);
      npmCli = (await this.opts.store.install(npm, { signal })).path;
    }
    // With the Codex app's CLI at hand, skip the CLI build npm would add (over 100 MB).
    const local = release.kind === "npm" && "CODEX_PATH" in this.extraEnv(def.id);
    const installed = await this.opts.store.install(
      local ? { ...release, omitOptional: true } : release,
      {
        onProgress,
        signal,
        ...(npmCli === undefined ? {} : { npmCli }),
      },
    );
    return installed.path;
  }

  cancel(id: string): void {
    this.installs.get(id)?.abort.abort();
  }

  remove(id: string): void {
    if (this.opts.store.installed(id) === undefined) {
      throw new Error(`"${id}" was not downloaded by AgentHerd`);
    }
    if (this.installs.has(id)) throw new Error("wait for the download to finish or cancel it");
    this.opts.store.remove(id);
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
