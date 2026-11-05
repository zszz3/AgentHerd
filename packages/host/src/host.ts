// The AgentHerd host: owns the config, the Herd, the Herder and the channel, and answers the local
// API (./api.ts). `agentherd start` and the desktop app both run one host; only one per home.

import { homedir } from "node:os";
import { join } from "node:path";
import {
  chooseModel,
  emptyModelSettings,
  Herd,
  type ModelRef,
  type ModelRole,
  type ModelService,
  type ModelSettings,
  modelKeyAccount,
  putService,
  removeService,
  type SecretStore,
} from "@agentherd/core";
import {
  agentForModel,
  builtinBaseUrls,
  builtinProviders,
  fallbackOrder,
  herderFromSettings,
  isGptModel,
  modelChoices,
  modelEnvFor,
  piModelEnv,
  placeModels,
  resolveModel,
  serviceKey,
  TIERS,
  type TierPlacement,
  testModel,
} from "@agentherd/herder";
import type { AgentProfile, Channel, Locale, Mode, SetupUI } from "@agentherd/protocol";
import { DEFAULT_LOCALE } from "@agentherd/protocol";
import QRCode from "qrcode";
import { Agents } from "./agents.ts";
import type {
  AgentCheck,
  AgentView,
  HostApi,
  HostEvent,
  HostStatus,
  ItemSummary,
  ModelsView,
  ModelTest,
  ModelTiersView,
  ProviderView,
  SettingsPatch,
  SetupState,
  TasksView,
  Tier,
  TranscriptView,
} from "./api.ts";
import type { AgentDef, Fetchers } from "./catalog.ts";
import { type CliConfig, readConfig, writeConfig } from "./config.ts";
import { availableProfiles } from "./profiles.ts";
import { RuntimeStore } from "./runtimes.ts";
import { type VerifyOptions, verifyProfile } from "./verify.ts";

export const HOST_VERSION = "0.0.0";

export interface HostOptions {
  home: string;
  /**
   * Download the agents the model list needs (ADR 0031): Pi always, Codex when a GPT model is in
   * the list. Off in tests.
   */
  autoInstallAgents?: boolean;
  userHome?: string;
  /** Model keys (and anything else under account names). */
  secrets: SecretStore;
  /** Builds the chat channel. The desktop app and the CLI pass the Feishu channel. */
  createChannel: (locale: Locale) => Channel;
  env?: Record<string, string>;
  /** Also offer the mock profile with this script. */
  script?: string;
  /** Profiles override (tests). Default: availableProfiles(). */
  profiles?: () => AgentProfile[];
  log?: (line: string) => void;
  /** Where downloaded agent CLIs go. Default: <home>/runtimes. */
  runtimes?: RuntimeStore;
  /** Agent definitions and release lookups (tests). Default: catalog.ts. */
  catalog?: AgentDef[];
  fetchers?: Fetchers;
  target?: string;
  exists?: (path: string) => boolean;
  /** Options for verifyAgent (tests). */
  verify?: VerifyOptions;
  /** The DeepSeek Harness app's CLI (tests). */
  dshApp?: string;
}

export class Host implements HostApi {
  private readonly opts: HostOptions;
  private readonly listeners = new Set<(event: HostEvent) => void>();
  private herd: Herd | undefined;
  private connected = false;
  private channelError: string | undefined;
  private herderReason: string | undefined;
  private herderRef: string | undefined;
  private readonly modelChecks = new Map<
    string,
    { result: { ok: true } | { ok: false; message: string }; until: number }
  >();
  private setup: SetupState = { phase: "idle" };
  private setupRun = 0;
  private profileList: AgentProfile[] = [];
  private stopped = false;

  private readonly agentList: Agents;

  constructor(opts: HostOptions) {
    this.opts = opts;
    this.agentList = new Agents({
      store: opts.runtimes ?? new RuntimeStore(join(opts.home, "runtimes")),
      ...(opts.env === undefined ? {} : { env: { ...process.env, ...opts.env } }),
      ...(opts.catalog === undefined ? {} : { catalog: opts.catalog }),
      ...(opts.fetchers === undefined ? {} : { fetchers: opts.fetchers }),
      ...(opts.target === undefined ? {} : { target: opts.target }),
      ...(opts.exists === undefined ? {} : { exists: opts.exists }),
      ...(opts.dshApp === undefined ? {} : { dshApp: opts.dshApp }),
      onChange: () => this.agentsChanged(),
      log: (line) => this.log(line),
    });
  }

  onEvent(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: HostEvent): void {
    for (const l of this.listeners) l(event);
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }

  private config(): CliConfig {
    return readConfig(this.opts.home);
  }

  private settings(): ModelSettings {
    return this.config().models ?? emptyModelSettings();
  }

  private saveSettings(models: ModelSettings): void {
    writeConfig(this.opts.home, { ...this.config(), models });
    this.installNeededAgents();
  }

  /** Agents the model list needs: Pi always, Codex when a GPT model is listed (ADR 0031). */
  neededAgents(): string[] {
    const gpt = this.settings().services.some((s) => s.models.some((m) => isGptModel(m)));
    return gpt ? ["pi", "codex"] : ["pi"];
  }

  private installNeededAgents(): void {
    if (this.opts.autoInstallAgents !== true || this.stopped) return;
    const views = this.agentList.views([], {});
    for (const id of this.neededAgents()) {
      const view = views.find((v) => v.id === id);
      if (view?.state !== "missing" || !view.canInstall || view.error !== undefined) continue;
      this.log(`[agents] downloading ${id}, which the model list needs`);
      try {
        this.agentList.install(id);
      } catch (error) {
        this.log(`[agents] could not download ${id}: ${(error as Error).message}`);
      }
    }
  }

  /** Starts following tasks if a channel is bound. */
  async start(): Promise<void> {
    this.installNeededAgents();
    await this.restartHerd();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.agentList.stop();
    this.setupRun++;
    await this.stopHerd();
  }

  private async stopHerd(): Promise<void> {
    const herd = this.herd;
    this.herd = undefined;
    this.connected = false;
    if (herd !== undefined) await herd.stop();
  }

  async reconnect(): Promise<HostStatus> {
    await this.restartHerd();
    return this.status();
  }

  private async restartHerd(): Promise<void> {
    await this.stopHerd();
    const config = this.config();
    this.profileList = this.buildProfiles(config);
    this.refreshHerderChoice();
    if (config.channel === undefined || this.stopped) {
      this.emitStatus();
      return;
    }
    const locale = config.locale ?? DEFAULT_LOCALE;
    const herder = this.herderFactory();
    const herd = new Herd({
      home: this.opts.home,
      userHome: this.opts.userHome ?? homedir(),
      channel: this.opts.createChannel(locale),
      binding: config.channel,
      mode: config.mode ?? "assist",
      locale,
      profiles: this.profileList,
      ...(herder === undefined ? {} : { herder }),
      agentModels: {
        list: () =>
          modelChoices(
            this.settings(),
            this.profileList.map((p) => p.id),
          ),
        envFor: (profileId, ref) =>
          modelEnvFor(this.settings(), this.opts.secrets, profileId, ref, this.opts.env),
        check: (ref) => this.checkModel(ref),
        next: (profileId, failed, tried) => this.nextModel(profileId, failed, tried),
      },
    });
    herd.registry.onChange(() => this.emitTasks());
    try {
      await herd.start();
      this.herd = herd;
      this.connected = true;
      this.channelError = undefined;
      this.log(
        `[herd] connected; agents: ${this.profileList.map((p) => p.id).join(", ") || "none"}`,
      );
    } catch (error) {
      this.channelError = (error as Error).message;
      this.log(`[herd] could not connect: ${this.channelError}`);
      await herd.stop().catch(() => {});
    }
    this.emitStatus();
    this.emitTasks();
  }

  private buildProfiles(config: CliConfig = this.config()): AgentProfile[] {
    if (this.opts.profiles !== undefined) return this.opts.profiles();
    const pi = piModelEnv(this.settings(), this.opts.secrets, this.opts.env);
    return availableProfiles({
      script: this.opts.script,
      configured: config.profiles ?? [],
      find: (id) => this.agentList.find(id)?.path,
      agentEnv: (id) => this.agentList.extraEnv(id),
      ...("env" in pi ? { piModelEnv: pi.env } : {}),
    });
  }

  private agentsChanged(): void {
    const before = this.profileList.map((p) => p.id).join(",");
    this.profileList = this.buildProfiles();
    this.herd?.setProfiles(this.profileList);
    this.emit({ topic: "agents", data: this.agents() });
    if (this.profileList.map((p) => p.id).join(",") !== before) this.emitStatus();
  }

  agents(): AgentView[] {
    const pi = piModelEnv(this.settings(), this.opts.secrets, this.opts.env);
    return this.agentList.views(this.config().profiles ?? [], "ref" in pi ? { pi: pi.ref } : {});
  }

  installAgent(id: string): AgentView[] {
    this.agentList.install(id);
    return this.agents();
  }

  cancelInstall(id: string): AgentView[] {
    this.agentList.cancel(id);
    return this.agents();
  }

  removeAgent(id: string): AgentView[] {
    this.agentList.remove(id);
    return this.agents();
  }

  async verifyAgent(id: string): Promise<AgentCheck> {
    const profile = this.profileList.find((p) => p.id === id);
    if (profile === undefined) {
      return { id, ok: false, needsLogin: false, authMethods: [], error: "not installed", ms: 0 };
    }
    const check = await verifyProfile(profile, this.opts.verify ?? {});
    this.log(`[agents] check ${id}: ${check.ok ? "ok" : check.error}`);
    return check;
  }

  /** Waits for agent downloads (tests). */
  agentsIdle(): Promise<void> {
    return this.agentList.idle();
  }

  private herderFactory() {
    const choice = herderFromSettings(this.settings(), this.opts.secrets, this.opts.env, () =>
      this.placement(),
    );
    return "factory" in choice ? choice.factory : undefined;
  }

  private refreshHerderChoice(): void {
    const choice = herderFromSettings(this.settings(), this.opts.secrets, this.opts.env, () =>
      this.placement(),
    );
    if ("reason" in choice) {
      this.herderReason = choice.reason;
      this.herderRef = undefined;
    } else {
      this.herderReason = undefined;
      this.herderRef = choice.ref;
    }
  }

  /** After a model change: rebuild the Herder in place; running tasks keep going. */
  private async applyModels(): Promise<void> {
    const before = this.herderRef;
    this.refreshHerderChoice();
    if (this.herd !== undefined && before !== this.herderRef) {
      await this.herd.setHerder(this.herderFactory());
    }
    this.profileList = this.buildProfiles();
    this.herd?.setProfiles(this.profileList);
    this.log(`[herder] ${this.herderRef ?? `off: ${this.herderReason}`}`);
    this.emit({ topic: "models", data: this.models() });
    this.emit({ topic: "agents", data: this.agents() });
    this.emitStatus();
  }

  private emitStatus(): void {
    this.emit({ topic: "status", data: this.status() });
  }

  private emitTasks(): void {
    this.emit({ topic: "tasks", data: this.tasks() });
  }

  status(): HostStatus {
    const config = this.config();
    return {
      version: HOST_VERSION,
      home: this.opts.home,
      channel: {
        bound: config.channel !== undefined,
        ...(config.channel?.data.appId === undefined ? {} : { appId: config.channel.data.appId }),
        connected: this.connected,
        ...(this.channelError === undefined ? {} : { error: this.channelError }),
      },
      herder: {
        on: this.herderRef !== undefined,
        ...(this.herderRef === undefined ? {} : { ref: this.herderRef }),
        ...(this.herderReason === undefined ? {} : { reason: this.herderReason }),
      },
      mode: this.herd?.getMode() ?? config.mode ?? "assist",
      locale: config.locale ?? DEFAULT_LOCALE,
      keepAwake: config.keepAwake ?? false,
      profiles: this.profileList.map((p) => p.id),
    };
  }

  tasks(): TasksView {
    const herd = this.herd;
    if (herd === undefined) return { tasks: [], items: [] };
    const tasks = herd.tasks();
    const titles = new Map(tasks.map((t) => [t.id, t.title]));
    const items: ItemSummary[] = herd.store.openItems().map((i) => {
      const taskTitle = titles.get(i.sessionId);
      return {
        id: i.id,
        sessionId: i.sessionId,
        title: i.title,
        body: i.body,
        risk: i.risk,
        createdAt: i.createdAt,
        cwd: i.cwd,
        profileId: i.profileId,
        ...(taskTitle === undefined ? {} : { taskTitle }),
      };
    });
    return { tasks, items };
  }

  transcript(taskId: string): TranscriptView {
    return this.herd?.transcript(taskId) ?? { entries: [], live: "" };
  }

  providers(): ProviderView[] {
    return builtinProviders();
  }

  models(): ModelsView {
    const settings = this.settings();
    return {
      services: settings.services.map((s) => ({
        ...s,
        hasKey: serviceKey(s, this.opts.secrets, this.opts.env) !== undefined,
      })),
      roles: settings.roles,
    };
  }

  async putService(service: ModelService, key?: string): Promise<ModelsView> {
    const next = putService(this.settings(), cleanService(service));
    if (typeof key === "string") this.writeKey(service.id, key);
    this.saveSettings(next);
    await this.applyModels();
    return this.models();
  }

  async removeService(serviceId: string): Promise<ModelsView> {
    this.saveSettings(removeService(this.settings(), serviceId));
    this.opts.secrets.delete(modelKeyAccount(serviceId));
    await this.applyModels();
    return this.models();
  }

  async setKey(serviceId: string, key: string): Promise<ModelsView> {
    if (!this.settings().services.some((s) => s.id === serviceId)) {
      throw new Error(`no service "${serviceId}"`);
    }
    this.writeKey(serviceId, key);
    // Same model, new key: the Herder must be rebuilt to use it.
    this.herderRef = undefined;
    await this.applyModels();
    return this.models();
  }

  async chooseModel(role: ModelRole, ref: ModelRef | null): Promise<ModelsView> {
    this.saveSettings(chooseModel(this.settings(), role, ref ?? undefined));
    await this.applyModels();
    return this.models();
  }

  async testModel(ref: ModelRef): Promise<ModelTest> {
    const service = this.settings().services.find((s) => s.id === ref.serviceId);
    if (service === undefined) return { ok: false, message: `no service "${ref.serviceId}"` };
    try {
      return await testModel(
        resolveModel(service, ref.model),
        serviceKey(service, this.opts.secrets, this.opts.env),
      );
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  private writeKey(serviceId: string, key: string): void {
    const account = modelKeyAccount(serviceId);
    if (key.trim() === "") this.opts.secrets.delete(account);
    else this.opts.secrets.set(account, key.trim());
  }

  setupState(): SetupState {
    return this.setup;
  }

  setupFeishu(): SetupState {
    const run = ++this.setupRun;
    this.setSetup({ phase: "starting" });
    const config = this.config();
    const channel = this.opts.createChannel(config.locale ?? DEFAULT_LOCALE);
    const ui: SetupUI = {
      showQrCode: (url, expiresInSeconds) => {
        void QRCode.toDataURL(url, { width: 320, margin: 1 }).then((qrDataUrl) => {
          if (run !== this.setupRun) return;
          this.setSetup({
            phase: "waiting-scan",
            qrDataUrl,
            url,
            expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
          });
        });
      },
      showStatus: (status) => {
        if (run !== this.setupRun) return;
        if (status === "waiting-confirm" || status === "verifying") {
          this.setSetup({ ...this.setup, phase: status });
        }
      },
    };
    void channel
      .setup(ui)
      .then(async (binding) => {
        if (run !== this.setupRun) return;
        writeConfig(this.opts.home, { ...this.config(), channel: binding });
        this.log(`[setup] bound to ${binding.data.appId ?? binding.channelId}`);
        this.setSetup({ phase: "connected" });
        await this.restartHerd();
      })
      .catch((error: Error) => {
        if (run !== this.setupRun) return;
        this.setSetup({ phase: "failed", error: error.message });
      });
    return this.setup;
  }

  cancelSetup(): SetupState {
    this.setupRun++;
    this.setSetup({ phase: "idle" });
    return this.setup;
  }

  private setSetup(state: SetupState): void {
    this.setup = state;
    this.emit({ topic: "setup", data: state });
  }

  updateSettings(patch: SettingsPatch): HostStatus {
    const config = this.config();
    const next: CliConfig = { ...config };
    if (patch.mode !== undefined) {
      if (patch.mode !== "observe" && patch.mode !== "assist") {
        throw new Error(`mode must be observe or assist, not "${patch.mode}"`);
      }
      next.mode = patch.mode as Mode;
      this.herd?.setMode(patch.mode);
    }
    if (patch.keepAwake !== undefined) next.keepAwake = patch.keepAwake;
    writeConfig(this.opts.home, next);
    this.emitStatus();
    return this.status();
  }

  private placement(): TierPlacement {
    const services = this.settings().services;
    const names = [...new Set(services.flatMap((s) => s.models))];
    const saved = this.config().modelTiers;
    // Plan 018 saved `service/model` refs; read those as the model name.
    const ids = new Set(services.map((s) => s.id));
    const asName = (entry: string) => {
      if (names.includes(entry)) return entry;
      const slash = entry.indexOf("/");
      return slash > 0 && ids.has(entry.slice(0, slash)) ? entry.slice(slash + 1) : entry;
    };
    const normalized =
      saved === undefined
        ? undefined
        : Object.fromEntries(TIERS.map((t) => [t, (saved[t] ?? []).map(asName)]));
    return placeModels(names, normalized);
  }

  modelTiers(): ModelTiersView {
    const services = this.settings().services;
    const placement = this.placement();
    const tiers = {} as ModelTiersView["tiers"];
    for (const tier of TIERS) {
      tiers[tier] = placement[tier].map(({ model, auto }) => ({
        model,
        services: services.filter((s) => s.models.includes(model)).map((s) => s.name),
        auto,
      }));
    }
    return { tiers, custom: this.config().modelTiers !== undefined };
  }

  /**
   * After `failed` broke a task before it acted: Codex hands the same model to Pi (ADR 0031);
   * otherwise the next model in fallback order that answers (ADR 0030), in the agent that model
   * gets.
   */
  private async nextModel(
    profileId: string,
    failed: string,
    tried: readonly string[],
  ): Promise<{ profileId: string; model: string } | undefined> {
    const ids = this.profileList.map((p) => p.id);
    if (profileId === "codex" && ids.includes("pi")) return { profileId: "pi", model: failed };
    this.modelChecks.set(failed, {
      result: { ok: false, message: "failed in a task" },
      until: Date.now() + 120_000,
    });
    const choices = modelChoices(this.settings(), ids);
    const auto = profileId === "pi" || profileId === "codex";
    for (const ref of fallbackOrder(
      choices,
      failed,
      auto ? undefined : profileId,
      this.placement(),
    )) {
      if (tried.includes(ref)) continue;
      if ((await this.checkModel(ref)).ok) {
        return { profileId: auto ? agentForModel(ref, ids) : profileId, model: ref };
      }
    }
    return undefined;
  }

  /** Test calls by ref: a working model is trusted for 10 minutes, a failing one for 2. */
  private async checkModel(ref: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const now = Date.now();
    const cached = this.modelChecks.get(ref);
    if (cached !== undefined && cached.until > now) return cached.result;
    const slash = ref.indexOf("/");
    const r = await this.testModel({ serviceId: ref.slice(0, slash), model: ref.slice(slash + 1) });
    const result = r.ok ? ({ ok: true } as const) : { ok: false as const, message: r.message };
    this.modelChecks.set(ref, { result, until: now + (r.ok ? 600_000 : 120_000) });
    return result;
  }

  setModelTiers(tiers: Record<Tier, string[]> | null): ModelTiersView {
    const next: CliConfig = { ...this.config() };
    if (tiers === null) delete next.modelTiers;
    else {
      const clean: Record<Tier, string[]> = { strong: [], balanced: [], fast: [] };
      for (const tier of TIERS) {
        const list = tiers[tier];
        if (!Array.isArray(list)) throw new Error(`tier "${tier}" must be a list of models`);
        clean[tier] = list.filter((r): r is string => typeof r === "string");
      }
      next.modelTiers = clean;
    }
    writeConfig(this.opts.home, next);
    return this.modelTiers();
  }
}

function cleanService(s: ModelService): ModelService {
  const base: ModelService = {
    id: s.id.trim(),
    name: s.name.trim(),
    kind: s.kind,
    models: s.models.map((m) => m.trim()).filter((m) => m !== ""),
  };
  if (s.kind === "builtin" && s.provider !== undefined) base.provider = s.provider;
  if (s.kind === "openai-compatible" && s.baseUrl !== undefined) base.baseUrl = s.baseUrl.trim();
  if (s.kind === "openai-compatible" && s.api === "anthropic-messages") base.api = s.api;
  return base;
}
