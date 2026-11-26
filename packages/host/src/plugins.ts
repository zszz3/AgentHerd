// Plugins (ADR 0094): Claude Code plugins and Gemini CLI extensions the owner installs from the
// official Claude Code plugin library or a GitHub link. AgentHerd downloads the folder, shows
// what it would run before anything is kept, and then gives task agents the plugin's MCP tools
// (through the agentherd gateway, where anything that is not read-only asks the owner) and its
// skills (told to every new task). The Herder gets the read-only tools and the skills only when
// the owner turns that on for the plugin.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AppToolInfo, AppTools, McpTool, SecretStore } from "@agentherd/core";
import type {
  PluginCatalogEntry,
  PluginPatch,
  PluginPreview,
  PluginState,
  PluginView,
} from "./api.ts";
import type { CliConfig, PluginEntry } from "./config.ts";
import { hostDataPaths } from "./data-home-paths.ts";
import {
  entrySource,
  fillVars,
  type GithubSource,
  githubUrl,
  type MarketplaceEntry,
  OFFICIAL_MARKETPLACE,
  OFFICIAL_PREFIX,
  type PluginManifest,
  parseGithubLink,
  readPlugin,
  sourceKey,
} from "./plugin-manifest.ts";
import { httpClient, type McpClient, type PluginTool, stdioClient } from "./plugin-mcp.ts";

export const PLUGIN_DOWNLOAD_MAX = 100 * 1024 * 1024;
export const CATALOG_MS = 6 * 60 * 60_000;
/** How long a looked-at plugin waits in the staging folder for the owner to install it. */
export const STAGING_MS = 30 * 60_000;
export const SKILL_READ_MAX = 30_000;
const DOWNLOAD_MS = 120_000;
const CATALOG_URL = `https://raw.githubusercontent.com/${OFFICIAL_MARKETPLACE.owner}/${OFFICIAL_MARKETPLACE.repo}/${OFFICIAL_MARKETPLACE.ref}/.claude-plugin/marketplace.json`;

export interface PluginStoreOptions {
  home: string;
  secrets: SecretStore;
  config(): CliConfig;
  save(change: (config: CliConfig) => CliConfig): void;
  /** The list or a state changed: the app redraws. */
  changed(): void;
  /** The environment servers start with (PATH with AgentHerd's tool folder). */
  env(): Record<string, string>;
  fetchFn?: typeof fetch;
  /** Unpacks a .tar.gz into a folder; `tar -xzf` by default. */
  extract?(file: string, dir: string): Promise<void>;
  /** Makes a client for one server; the real stdio and HTTP clients by default. */
  client?(server: RunningServer): McpClient;
  log?(line: string): void;
  now?(): Date;
}

/** A server with its variables filled in, ready to start. */
export type RunningServer =
  | {
      plugin: string;
      name: string;
      kind: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd: string;
    }
  | { plugin: string; name: string; kind: "http"; url: string; headers: Record<string, string> };

interface Staged {
  source: string;
  github: GithubSource;
  dir: string;
  root: string;
  manifest: PluginManifest;
  at: number;
}

interface Run {
  manifest: PluginManifest;
  clients: Map<string, McpClient>;
  /** Agent-facing tool name → server and the server's own tool name. */
  names: Map<string, { server: string; tool: PluginTool }>;
  state: PluginState;
  problem?: string;
  listing?: Promise<PluginTool[]>;
}

/** A tool name agents can use: `<PLUGIN>__<tool>`, only letters, digits, _ and -, ≤ 64. */
export function pluginToolName(pluginId: string, tool: string): string {
  const prefix = pluginId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return `${prefix}__${tool.replace(/[^A-Za-z0-9_-]+/g, "_")}`.slice(0, 64);
}

function slugOf(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug === "" ? "plugin" : slug;
}

function commandLine(command: string, args: string[]): string {
  return [command, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");
}

async function tarExtract(file: string, dir: string): Promise<void> {
  await promisify(execFile)("tar", ["-xzf", file, "-C", dir], { windowsHide: true });
}

export class PluginStore {
  private readonly runs = new Map<string, Run>();
  private readonly staged = new Map<string, Staged>();
  private catalogCache: { at: number; entries: MarketplaceEntry[] } | undefined;

  private readonly opts: PluginStoreOptions;

  constructor(opts: PluginStoreOptions) {
    this.opts = opts;
  }

  private get dir(): string {
    return join(this.opts.home, hostDataPaths.plugins.relative);
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private entries(): PluginEntry[] {
    return this.opts.config().plugins ?? [];
  }

  private fetch(url: string, init?: RequestInit): Promise<Response> {
    return (this.opts.fetchFn ?? fetch)(url, init);
  }

  // ---- The official library ----

  private async marketplace(): Promise<MarketplaceEntry[]> {
    const cached = this.catalogCache;
    if (cached !== undefined && this.now().getTime() - cached.at < CATALOG_MS)
      return cached.entries;
    const file = join(this.opts.home, hostDataPaths.pluginCatalog.relative);
    try {
      const res = await this.fetch(CATALOG_URL, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const entries = (JSON.parse(text) as { plugins?: MarketplaceEntry[] }).plugins ?? [];
      this.catalogCache = { at: this.now().getTime(), entries };
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(file, text);
      return entries;
    } catch (error) {
      if (existsSync(file)) {
        const entries = (JSON.parse(readFileSync(file, "utf8")) as { plugins?: MarketplaceEntry[] })
          .plugins;
        if (entries !== undefined) return entries;
      }
      throw new Error(`读不到官方插件库：${(error as Error).message}`);
    }
  }

  async catalog(): Promise<PluginCatalogEntry[]> {
    const installed = new Set(this.entries().map((e) => e.source));
    return (await this.marketplace()).map((e) => {
      const where = entrySource(e);
      const source = `${OFFICIAL_PREFIX}${e.name}`;
      return {
        name: e.name,
        title: e.displayName ?? e.name,
        description: e.description ?? "",
        ...(e.category === undefined ? {} : { category: e.category }),
        ...(e.author?.name === undefined ? {} : { author: e.author.name }),
        ...(e.homepage === undefined ? {} : { homepage: e.homepage }),
        ...("why" in where ? { why: where.why } : { source }),
        installed: installed.has(source),
      };
    });
  }

  // ---- Looking at and installing ----

  private async resolve(source: string): Promise<{ key: string; github: GithubSource }> {
    const text = source.trim();
    if (text.startsWith(OFFICIAL_PREFIX)) {
      const name = text.slice(OFFICIAL_PREFIX.length);
      const entry = (await this.marketplace()).find((e) => e.name === name);
      if (entry === undefined) throw new Error(`官方插件库里没有 ${name}`);
      const where = entrySource(entry);
      if ("why" in where) throw new Error(`${name} 装不了：${where.why}`);
      return { key: text, github: where };
    }
    const github = parseGithubLink(text.startsWith("github:") ? text.slice(7) : text);
    return { key: sourceKey(github), github };
  }

  private async download(github: GithubSource, into: string): Promise<string> {
    const url = `https://codeload.github.com/${github.owner}/${github.repo}/tar.gz/${github.ref ?? "HEAD"}`;
    let res: Response;
    try {
      res = await this.fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_MS) });
    } catch (error) {
      throw new Error(`下载不了 ${github.owner}/${github.repo}：${(error as Error).message}`);
    }
    if (res.status === 404) {
      throw new Error(
        `找不到 ${github.owner}/${github.repo}${github.ref === undefined ? "" : `@${github.ref}`}（只支持公开仓库）`,
      );
    }
    if (!res.ok)
      throw new Error(`下载 ${github.owner}/${github.repo} 时 GitHub 回答 HTTP ${res.status}`);
    const size = Number(res.headers.get("content-length") ?? "0");
    if (size > PLUGIN_DOWNLOAD_MAX) throw new Error("仓库太大（超过 100 MB），不像是一个插件");
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.byteLength > PLUGIN_DOWNLOAD_MAX)
      throw new Error("仓库太大（超过 100 MB），不像是一个插件");
    mkdirSync(into, { recursive: true });
    const file = join(into, "download.tar.gz");
    writeFileSync(file, data);
    const out = join(into, "files");
    mkdirSync(out);
    await (this.opts.extract ?? tarExtract)(file, out);
    rmSync(file, { force: true });
    const tops = readdirSync(out);
    const top = tops.length === 1 ? join(out, tops[0] as string) : out;
    const root = github.path === undefined ? top : join(top, ...github.path.split("/"));
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`仓库里没有 ${github.path} 这个文件夹`);
    }
    return root;
  }

  private dropOldStaging(): void {
    const now = this.now().getTime();
    for (const [key, s] of this.staged) {
      if (now - s.at > STAGING_MS) {
        rmSync(s.dir, { recursive: true, force: true });
        this.staged.delete(key);
      }
    }
  }

  async preview(source: string): Promise<PluginPreview> {
    this.dropOldStaging();
    const { key, github } = await this.resolve(source);
    let staged = this.staged.get(key);
    if (staged === undefined) {
      const dir = join(
        this.opts.home,
        hostDataPaths.pluginStaging.relative,
        randomBytes(6).toString("hex"),
      );
      try {
        const root = await this.download(github, dir);
        const name = github.path?.split("/").pop() ?? github.repo;
        const manifest = readPlugin(root, name);
        staged = { source: key, github, dir, root, manifest, at: this.now().getTime() };
        this.staged.set(key, staged);
      } catch (error) {
        rmSync(dir, { recursive: true, force: true });
        throw error;
      }
    }
    const installed = this.entries().find((e) => e.source === key);
    return {
      ...previewOf(key, github, staged.manifest),
      ...(installed === undefined ? {} : { installedId: installed.id }),
    };
  }

  async install(source: string, keys: Record<string, string>): Promise<PluginView[]> {
    const preview = await this.preview(source);
    const staged = this.staged.get(preview.source) as Staged;
    const taken = new Set(this.entries().map((e) => e.id));
    let id = preview.installedId ?? slugOf(preview.name);
    if (preview.installedId === undefined) {
      for (let n = 2; taken.has(id); n++) id = `${slugOf(preview.name)}-${n}`;
    }
    this.stop(id);
    const target = join(this.dir, id);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    renameSync(staged.root, target);
    rmSync(staged.dir, { recursive: true, force: true });
    this.staged.delete(preview.source);
    for (const k of preview.keys) {
      const v = keys[k]?.trim();
      if (v !== undefined && v !== "") this.opts.secrets.set(secretName(id, k), v);
    }
    const entry: PluginEntry = {
      id,
      source: preview.source,
      name: preview.name,
      enabled: true,
      herder: this.entries().find((e) => e.id === id)?.herder ?? false,
      installedAt: this.now().toISOString(),
      ...(preview.link === "" ? {} : { link: preview.link }),
    };
    this.opts.save((c) => ({
      ...c,
      plugins: [...(c.plugins ?? []).filter((e) => e.id !== id), entry],
    }));
    this.opts.log?.(`[plugins] installed ${id} from ${preview.source}`);
    this.opts.changed();
    void this.check(id);
    return this.views();
  }

  // ---- Installed plugins ----

  private manifestOf(id: string): PluginManifest | undefined {
    const run = this.runs.get(id);
    if (run !== undefined) return run.manifest;
    const entry = this.entries().find((e) => e.id === id);
    if (entry === undefined) return undefined;
    try {
      return readPlugin(join(this.dir, id), entry.name);
    } catch {
      return undefined;
    }
  }

  private keysOf(id: string, manifest: PluginManifest): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of manifest.keys) {
      const v = this.opts.secrets.get(secretName(id, k));
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  views(): PluginView[] {
    return this.entries().map((e) => {
      const dir = join(this.dir, e.id);
      const run = this.runs.get(e.id);
      let manifest: PluginManifest | undefined = run?.manifest;
      let problem: string | undefined;
      if (manifest === undefined) {
        try {
          manifest = readPlugin(dir, e.name);
        } catch (error) {
          problem = `读不了它的文件：${(error as Error).message}`;
        }
      }
      let github: GithubSource | undefined;
      try {
        github = e.source.startsWith("github:") ? parseGithubLink(e.source.slice(7)) : undefined;
      } catch {
        github = undefined;
      }
      const base =
        manifest === undefined
          ? {
              source: e.source,
              link: github === undefined ? "" : githubUrl(github),
              name: e.name,
              description: "",
              format: "claude" as const,
              servers: [],
              keys: [],
              skills: [],
              ignored: [],
              problems: [],
            }
          : previewOf(e.source, github, manifest);
      if (base.link === "" && e.link !== undefined) base.link = e.link;
      const tools = run === undefined ? [] : [...run.names.values()];
      const state: PluginState =
        problem !== undefined ? "failed" : !e.enabled ? "off" : (run?.state ?? "idle");
      return {
        ...base,
        id: e.id,
        enabled: e.enabled,
        herder: e.herder,
        installedAt: e.installedAt,
        state,
        tools: tools.length,
        readTools: tools.filter((t) => readOnly(t.tool)).length,
        ...(problem !== undefined
          ? { problem }
          : e.enabled && run?.problem !== undefined
            ? { problem: run.problem }
            : {}),
        keysSet: (manifest?.keys ?? []).filter(
          (k) => this.opts.secrets.get(secretName(e.id, k)) !== undefined,
        ),
        dir,
      };
    });
  }

  async set(id: string, patch: PluginPatch): Promise<PluginView[]> {
    const entry = this.entries().find((e) => e.id === id);
    if (entry === undefined) throw new Error(`没有 ${id} 这个插件`);
    if (patch.keys !== undefined) {
      for (const [k, v] of Object.entries(patch.keys)) {
        if (v.trim() === "") this.opts.secrets.delete(secretName(id, k));
        else this.opts.secrets.set(secretName(id, k), v.trim());
      }
      this.stop(id);
    }
    this.opts.save((c) => ({
      ...c,
      plugins: (c.plugins ?? []).map((e) =>
        e.id === id
          ? {
              ...e,
              ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
              ...(patch.herder === undefined ? {} : { herder: patch.herder }),
            }
          : e,
      ),
    }));
    if (patch.enabled === false) this.stop(id);
    this.opts.changed();
    if (patch.enabled === true || patch.keys !== undefined) void this.check(id);
    return this.views();
  }

  async remove(id: string): Promise<PluginView[]> {
    const entry = this.entries().find((e) => e.id === id);
    if (entry === undefined) throw new Error(`没有 ${id} 这个插件`);
    const manifest = this.manifestOf(id);
    this.stop(id);
    for (const k of manifest?.keys ?? []) this.opts.secrets.delete(secretName(id, k));
    rmSync(join(this.dir, id), { recursive: true, force: true });
    this.opts.save((c) => ({ ...c, plugins: (c.plugins ?? []).filter((e) => e.id !== id) }));
    this.opts.log?.(`[plugins] removed ${id}`);
    this.opts.changed();
    return this.views();
  }

  /** Stops a plugin's servers; they start again when an agent needs them. */
  stop(id: string): void {
    const run = this.runs.get(id);
    if (run === undefined) return;
    for (const c of run.clients.values()) c.close();
    this.runs.delete(id);
  }

  stopAll(): void {
    for (const id of [...this.runs.keys()]) this.stop(id);
    for (const s of this.staged.values()) rmSync(s.dir, { recursive: true, force: true });
    this.staged.clear();
  }

  // ---- Running ----

  private runOf(id: string): Run | undefined {
    const entry = this.entries().find((e) => e.id === id);
    if (entry === undefined || !entry.enabled) return undefined;
    let run = this.runs.get(id);
    if (run === undefined) {
      const manifest = this.manifestOf(id);
      if (manifest === undefined) return undefined;
      run = { manifest, clients: new Map(), names: new Map(), state: "idle" };
      this.runs.set(id, run);
    }
    return run;
  }

  private serverFor(id: string, run: Run, name: string): McpClient {
    const have = run.clients.get(name);
    if (have !== undefined) return have;
    const spec = run.manifest.servers.find((s) => s.name === name);
    if (spec === undefined) throw new Error(`no server ${name}`);
    const root = join(this.dir, id);
    const keys = this.keysOf(id, run.manifest);
    const base = this.opts.env();
    const fill = (t: string) => fillVars(t, root, keys, base);
    const server: RunningServer =
      spec.kind === "stdio"
        ? {
            plugin: id,
            name,
            kind: "stdio",
            command: fill(spec.command),
            args: spec.args.map(fill),
            env: {
              ...base,
              ...keys,
              ...Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, fill(v)])),
            },
            cwd: spec.cwd === undefined ? root : fill(spec.cwd),
          }
        : {
            plugin: id,
            name,
            kind: "http",
            url: fill(spec.url),
            headers: Object.fromEntries(Object.entries(spec.headers).map(([k, v]) => [k, fill(v)])),
          };
    const client =
      this.opts.client?.(server) ??
      (server.kind === "stdio"
        ? stdioClient({
            command: server.command,
            args: server.args,
            env: server.env,
            cwd: server.cwd,
          })
        : httpClient({ url: server.url, headers: server.headers }));
    run.clients.set(name, client);
    return client;
  }

  /** Lists a plugin's tools, starting its servers; keeps its state for the app. */
  private list(id: string): Promise<PluginTool[]> {
    const run = this.runOf(id);
    if (run === undefined) return Promise.resolve([]);
    if (run.listing !== undefined) return run.listing;
    if (run.manifest.servers.length === 0) {
      run.state = "ready";
      return Promise.resolve([]);
    }
    const before = run.state;
    if (run.state !== "ready") {
      run.state = "starting";
      if (before !== "starting") this.opts.changed();
    }
    const listing = (async () => {
      const problems: string[] = [];
      const names = new Map<string, { server: string; tool: PluginTool }>();
      for (const spec of run.manifest.servers) {
        try {
          const tools = await this.serverFor(id, run, spec.name).tools();
          for (const tool of tools) {
            let name = pluginToolName(id, tool.name);
            for (let n = 2; names.has(name); n++)
              name = `${pluginToolName(id, tool.name).slice(0, 60)}_${n}`;
            names.set(name, { server: spec.name, tool });
          }
        } catch (error) {
          problems.push(`${spec.name}：${(error as Error).message}`);
          run.clients.get(spec.name)?.close();
          run.clients.delete(spec.name);
        }
      }
      run.names = names;
      const state: PluginState = problems.length > 0 && names.size === 0 ? "failed" : "ready";
      const problem = problems.length > 0 ? problems.join("；") : undefined;
      const changed = state !== run.state || problem !== run.problem;
      run.state = state;
      if (problem === undefined) delete run.problem;
      else run.problem = problem;
      if (problem !== undefined) this.opts.log?.(`[plugins] ${id}: ${problem}`);
      if (changed) this.opts.changed();
      return [...names.values()].map((n) => n.tool);
    })();
    run.listing = listing;
    void listing.finally(() => {
      if (run.listing === listing) delete run.listing;
    });
    return listing;
  }

  /** Starts a plugin's servers once to show whether they work. */
  async check(id: string): Promise<void> {
    await this.list(id).catch(() => undefined);
  }

  private async named(
    ids: readonly string[],
  ): Promise<Map<string, { id: string; server: string; tool: PluginTool }>> {
    const out = new Map<string, { id: string; server: string; tool: PluginTool }>();
    for (const id of ids) {
      const run = this.runOf(id);
      if (run === undefined) continue;
      if (run.names.size === 0 || run.state !== "ready") await this.list(id);
      for (const [name, n] of run.names) out.set(name, { id, ...n });
    }
    return out;
  }

  private enabledIds(herder = false): string[] {
    return this.entries()
      .filter((e) => e.enabled && (!herder || e.herder))
      .map((e) => e.id);
  }

  private async callTool(name: string, args: unknown, ids: readonly string[]): Promise<unknown> {
    const found = (await this.named(ids)).get(name);
    if (found === undefined) throw new Error(`unknown tool ${name}`);
    const run = this.runs.get(found.id) as Run;
    return this.serverFor(found.id, run, found.server).call(found.tool.name, args);
  }

  /** The tools of every plugin that is on, for task agents through the gateway. */
  tools(): AppTools | undefined {
    const ids = this.enabledIds();
    if (ids.length === 0) return undefined;
    return {
      list: async () =>
        [...(await this.named(ids)).entries()].map(([name, n]) => toolFor(name, n.tool)),
      describe: async (slugs) => {
        const all = await this.named(ids);
        const out = new Map<string, AppToolInfo>();
        for (const slug of slugs) {
          const n = all.get(slug);
          if (n === undefined) continue;
          const entry = this.entries().find((e) => e.id === n.id);
          out.set(slug, {
            title: `${entry?.name ?? n.id}: ${n.tool.annotations?.title ?? n.tool.name}`,
            toolkit: `plugin:${n.id}`,
            hints: {
              readOnly: readOnly(n.tool),
              // Anything that is not read-only may change something outside: it asks first.
              create: !readOnly(n.tool),
              update: false,
              destructive: n.tool.annotations?.destructiveHint === true,
            },
          });
        }
        return out;
      },
      call: (name, args) => this.callTool(name, args, ids),
    };
  }

  /**
   * What the Herder may use now, without waiting (its system prompt is built synchronously).
   * Plugins whose servers have not answered yet start now and show up on a later turn.
   */
  herderList(): {
    tools: { name: string; description: string }[];
    skills: { name: string; description: string }[];
  } {
    const tools: { name: string; description: string }[] = [];
    for (const id of this.enabledIds(true)) {
      const run = this.runOf(id);
      if (run === undefined) continue;
      if (run.state !== "ready" && run.state !== "failed") {
        void this.list(id).catch(() => undefined);
        continue;
      }
      for (const [name, n] of run.names) {
        if (readOnly(n.tool)) tools.push({ name, description: n.tool.description ?? "" });
      }
    }
    const skills = this.skills(true).map((s) => ({ name: s.name, description: s.description }));
    return { tools, skills };
  }

  /** The read-only tools of plugins the owner let the Herder use. */
  async herderTools(): Promise<McpTool[]> {
    const ids = this.enabledIds(true);
    if (ids.length === 0) return [];
    return [...(await this.named(ids)).entries()]
      .filter(([, n]) => readOnly(n.tool))
      .map(([name, n]) => toolFor(name, n.tool));
  }

  async herderCall(name: string, args: unknown): Promise<unknown> {
    const ids = this.enabledIds(true);
    const found = (await this.named(ids)).get(name);
    if (found === undefined || !readOnly(found.tool)) {
      throw new Error(`${name} is not a read-only plugin tool the Herder may use`);
    }
    return this.callTool(name, args, ids);
  }

  /** Skills of plugins that are on (only the Herder's when `herder`). */
  skills(herder = false): { name: string; description: string; plugin: string; path: string }[] {
    const out: { name: string; description: string; plugin: string; path: string }[] = [];
    for (const id of this.enabledIds(herder)) {
      const m = this.manifestOf(id);
      const entry = this.entries().find((e) => e.id === id);
      for (const s of m?.skills ?? []) {
        out.push({
          name: s.name,
          description: s.description,
          plugin: entry?.name ?? id,
          path: join(this.dir, id, ...s.file.split("/")),
        });
      }
    }
    return out;
  }

  /** A skill's text for the Herder, cut at SKILL_READ_MAX. */
  skillText(name: string): string {
    const skill = this.skills(true).find((s) => s.name === name);
    if (skill === undefined)
      throw new Error(
        `no skill named ${name}; the Herder's skills: ${
          this.skills(true)
            .map((s) => s.name)
            .join(", ") || "none"
        }`,
      );
    const text = readFileSync(skill.path, "utf8");
    return text.length > SKILL_READ_MAX
      ? `${text.slice(0, SKILL_READ_MAX)}\n… (${text.length - SKILL_READ_MAX} more characters in ${skill.path})`
      : text;
  }

  /** What every new task is told about the skills (ADR 0094). */
  note(): string | undefined {
    const skills = this.skills();
    if (skills.length === 0) return undefined;
    return [
      "Skills the owner installed with plugins. When the work matches one, read its SKILL.md first and follow it (paths inside it are relative to its folder):",
      ...skills.map(
        (s) =>
          `- ${s.name} (${s.plugin})${s.description === "" ? "" : `: ${s.description}`} — ${s.path}`,
      ),
    ].join("\n");
  }
}

function secretName(id: string, key: string): string {
  return `plugin:${id}:${key}`;
}

function readOnly(tool: PluginTool): boolean {
  return tool.annotations?.readOnlyHint === true;
}

function toolFor(name: string, tool: PluginTool): McpTool {
  return {
    name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
  };
}

function previewOf(
  source: string,
  github: GithubSource | undefined,
  m: PluginManifest,
): Omit<PluginPreview, "installedId"> {
  return {
    source,
    link: github === undefined ? (m.homepage ?? "") : githubUrl(github),
    name: m.name,
    description: m.description,
    ...(m.version === undefined ? {} : { version: m.version }),
    ...(m.author === undefined ? {} : { author: m.author }),
    format: m.format,
    servers: m.servers.map((s) => ({
      name: s.name,
      kind: s.kind,
      run: s.kind === "stdio" ? commandLine(s.command, s.args) : s.url,
    })),
    keys: m.keys,
    skills: m.skills.map((s) => ({ name: s.name, description: s.description })),
    ignored: m.ignored,
    problems: m.problems,
  };
}
