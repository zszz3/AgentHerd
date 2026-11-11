// A fake bridge for previewing the UI in a plain browser (vite dev without Electron).
// It is installed only when the preload script did not set `window.agentherd`.
// `?sim=` picks the starting state:
//   fresh (default)  not bound, no Herder model: the first run opens
//   bound            bound and connected, no Herder model
//   network          bound, but connecting to Feishu failed; 重新连接 then works
//   ready            bound, connected, Herder chosen
//   empty            like ready, with no tasks
//   no-agent         like empty, with no agent profiles
//   offline          like ready, then the connection to the host drops
//   pi-failed        like empty, and the last Pi download failed
// `?open=` opens a dialog at once, for screenshots (see `devOpen`):
//   add-service      the 添加服务 chooser
//   add-builtin      the 添加服务 form of OpenRouter, with a few models chosen
//   add-custom       the 添加服务 form of an OpenAI-compatible address
//   edit-<id>        the edit dialog of the service <id> (deepseek, gateway)
//   task-<id>        the conversation of the task <id> (s2 has one)

import type {
  AgentView,
  AppsView,
  HostEvent,
  HostStatus,
  MemoryView,
  ModelsView,
  ModelTiersView,
  RemoteHost,
  SchedulesView,
  SetupState,
  SocialView,
  Tier,
  WatchView,
} from "@agentherd/host/api";
import type { Bridge } from "../../shared/bridge";
import {
  hoursFromNow,
  PLACEHOLDER_QR,
  providers,
  sampleMemory,
  sampleSchedules,
  sampleServices,
  sampleSocials,
  sampleTasks,
  sampleTranscript,
  sampleWatches,
} from "./dev-fixtures";

type Listener<T> = (value: T) => void;

const SIMS = [
  "fresh",
  "bound",
  "network",
  "ready",
  "empty",
  "no-agent",
  "offline",
  "pi-failed",
] as const;

type Sim = (typeof SIMS)[number];

function simulation(): Sim {
  const value = new URLSearchParams(window.location.search).get("sim");
  return SIMS.find((s) => s === value) ?? "fresh";
}

function installFakeBridge(): void {
  const sim = simulation();
  const herderChosen = sim !== "fresh" && sim !== "bound" && sim !== "network";
  const eventListeners = new Set<Listener<HostEvent>>();
  const connectionListeners = new Set<Listener<boolean>>();
  const keys = new Map<string, string>([["deepseek", "sk-fake"]]);
  let setupTimers: ReturnType<typeof setTimeout>[] = [];

  let status: HostStatus = {
    version: "0.0.0-dev",
    home: "~/.agentherd",
    channel:
      sim === "fresh"
        ? { bound: false, connected: false }
        : sim === "network"
          ? {
              bound: true,
              appId: "cli_fake123",
              connected: false,
              error: "getaddrinfo ENOTFOUND open.feishu.cn",
            }
          : { bound: true, appId: "cli_fake123", connected: true },
    herder: herderChosen
      ? { on: true, ref: "deepseek/deepseek-chat" }
      : { on: false, reason: "no model chosen for the Herder" },
    mode: "observe",
    locale: "zh-CN",
    keepAwake: true,
    herderStyle: "friend",
    profiles: sim === "no-agent" ? [] : ["dsh"],
  };

  const tasks = sampleTasks(sim === "empty" || sim === "no-agent");

  let models: ModelsView = {
    services: sampleServices(),
    roles: herderChosen ? { herder: { serviceId: "deepseek", model: "deepseek-chat" } } : {},
  };

  let setup: SetupState = { phase: "idle" };
  let memory: MemoryView = sampleMemory();
  let schedules: SchedulesView = sampleSchedules(sim === "empty" || sim === "no-agent");
  let apps: AppsView =
    sim === "ready"
      ? {
          hasKey: true,
          apps: [
            { slug: "gmail", name: "Gmail", connected: true, connecting: false },
            { slug: "github", name: "GitHub", connected: false, connecting: false },
            { slug: "slack", name: "Slack", connected: false, connecting: false },
            { slug: "notion", name: "Notion", connected: false, connecting: false },
          ],
        }
      : { hasKey: false, apps: [] };
  const appsChanged = (): void => emit({ topic: "apps", data: structuredClone(apps) });
  let socials: SocialView[] = sampleSocials();
  let watches: WatchView[] = sampleWatches(sim === "empty" || sim === "no-agent");
  /** Changes one platform and tells the page, as the host's "socials" event does. */
  const setSocial = (platform: SocialView["platform"], patch: Partial<SocialView>): void => {
    socials = socials.map((s) => (s.platform === platform ? { ...s, ...patch } : s));
    emit({ topic: "socials", data: structuredClone(socials) });
  };

  const emit = (event: HostEvent): void => {
    for (const l of eventListeners) l(event);
  };
  const delay = <T>(value: T, ms = 150): Promise<T> =>
    new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), ms));

  const herderStatus = (): HostStatus["herder"] => {
    const ref = models.roles.herder;
    return ref === undefined
      ? { on: false, reason: "no model chosen for the Herder" }
      : { on: true, ref: `${ref.serviceId}/${ref.model}` };
  };
  const modelsChanged = (): ModelsView => {
    // Like core: roles that point at models no longer listed are cleared.
    const roles: ModelsView["roles"] = {};
    for (const role of ["herder", "reviewer", "pi"] as const) {
      const ref = models.roles[role];
      if (ref === undefined) continue;
      const s = models.services.find((x) => x.id === ref.serviceId);
      if (s?.models.includes(ref.model)) roles[role] = ref;
    }
    models = { ...models, roles };
    status = { ...status, herder: herderStatus() };
    emit({ topic: "models", data: structuredClone(models) });
    emit({ topic: "status", data: structuredClone(status) });
    return models;
  };
  const setSetup = (next: SetupState): void => {
    setup = next;
    emit({ topic: "setup", data: structuredClone(setup) });
  };

  const missing = (id: string, name: string, extra: Partial<AgentView> = {}): AgentView => ({
    id,
    name,
    state: "missing",
    canInstall: true,
    canRemove: false,
    ...extra,
  });
  let agents: AgentView[] = [
    sim === "no-agent"
      ? missing("dsh", "DeepSeek Harness")
      : {
          id: "dsh",
          name: "DeepSeek Harness",
          state: "ready",
          source: "app",
          path: "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh",
          canInstall: false,
          canRemove: false,
        },
    missing(
      "pi",
      "Pi",
      sim === "pi-failed" ? { error: "download failed: HTTP 503 for https://github.com/…" } : {},
    ),
    missing("codex", "Codex"),
  ];
  let installTimer: ReturnType<typeof setInterval> | undefined;
  const setAgents = (next: AgentView[]): AgentView[] => {
    agents = next;
    const ids = agents.filter((a) => a.state === "ready").map((a) => a.id);
    status = { ...status, profiles: ids };
    emit({ topic: "agents", data: structuredClone(agents) });
    emit({ topic: "status", data: structuredClone(status) });
    return agents;
  };
  const patch = (id: string, change: Partial<AgentView>): AgentView[] =>
    setAgents(agents.map((a) => (a.id === id ? ({ ...a, ...change } as AgentView) : a)));
  const reset = (a: AgentView): AgentView => missing(a.id, a.name);

  // The fake places models by a few names; the real rules are in packages/herder/src/model-guide.ts.
  let placed: Record<Tier, string[]> | null = null;
  const fakeTier = (model: string): Tier =>
    /opus|gpt-6|pro-latest/.test(model)
      ? "strong"
      : /flash|mini|haiku/.test(model)
        ? "fast"
        : "balanced";
  const tiersView = (): ModelTiersView => {
    const names = [...new Set(models.services.flatMap((s) => s.models))];
    const all = names.map((model) => ({
      model,
      services: models.services.filter((s) => s.models.includes(model)).map((s) => s.name),
    }));
    const tiers: ModelTiersView["tiers"] = { strong: [], balanced: [], fast: [] };
    const done = new Set<string>();
    for (const tier of ["strong", "balanced", "fast"] as const) {
      for (const name of placed?.[tier] ?? []) {
        const m = all.find((x) => x.model === name);
        if (m === undefined || done.has(name)) continue;
        done.add(name);
        tiers[tier].push({ ...m, auto: false });
      }
    }
    for (const m of all)
      if (!done.has(m.model)) tiers[fakeTier(m.model)].push({ ...m, auto: true });
    return { tiers, custom: placed !== null };
  };

  const fake: RemoteHost = {
    apps: (search) =>
      delay({
        ...apps,
        apps: apps.apps.filter(
          (a) => search === undefined || a.slug.includes(search.toLowerCase()),
        ),
      }),
    setComposioKey: (key) => {
      if (key.trim() === "") apps = { hasKey: false, apps: [] };
      else if (key.trim() === "bad")
        return delay({ ...apps, problem: "这个 Composio API Key 不能用：Invalid API key" });
      else
        apps = {
          hasKey: true,
          apps: [
            { slug: "gmail", name: "Gmail", connected: false, connecting: false },
            { slug: "github", name: "GitHub", connected: false, connecting: false },
          ],
        };
      return delay(apps, 600);
    },
    socials: () => delay(socials),
    enableSocial: (platform) => {
      setSocial(platform, { enabled: true, accepted: true, state: "starting" });
      setTimeout(() => setSocial(platform, { state: "signed-out" }), 1500);
      return delay(socials);
    },
    disableSocial: (platform) => {
      setSocial(platform, { enabled: false, state: "off" });
      return delay(socials);
    },
    socialLoginCode: (platform) => {
      // The preview "scans" by itself after a few seconds.
      setTimeout(() => setSocial(platform, { state: "ready", account: "预览账号" }), 4000);
      return delay({ image: PLACEHOLDER_QR, signedIn: false }, 600);
    },
    socialLogout: (platform) => {
      socials = socials.map((s) => {
        if (s.platform !== platform) return s;
        const { account: _, ...rest } = s;
        return { ...rest, state: "signed-out" as const };
      });
      return delay(socials);
    },
    testSocial: (platform) => {
      const s = socials.find((x) => x.platform === platform);
      const ok = s?.state === "ready";
      return delay(
        {
          ok,
          message: ok ? `连接正常，账号「${s?.account ?? ""}」` : "登录已失效，点「重连」扫码",
          socials,
        },
        800,
      );
    },
    setSocialWatch: (platform, kind, on) => {
      socials = socials.map((s) =>
        s.platform === platform ? { ...s, watch: { ...s.watch, [kind]: on } } : s,
      );
      return delay(socials);
    },
    watches: () => delay(watches),
    setWatchPaused: (id, paused) => {
      watches = watches.map((w) => (w.id === id ? { ...w, paused } : w));
      return delay(watches);
    },
    removeWatch: (id) => {
      watches = watches.filter((w) => w.id !== id || !w.removable);
      return delay(watches);
    },
    connectApp: (slug) => {
      apps = {
        ...apps,
        apps: apps.apps.map((a) => (a.slug === slug ? { ...a, connecting: true } : a)),
      };
      appsChanged();
      setTimeout(() => {
        apps = {
          ...apps,
          apps: apps.apps.map((a) =>
            a.slug === slug ? { ...a, connecting: false, connected: true } : a,
          ),
        };
        appsChanged();
      }, 3000);
      return delay({ url: "https://example.com/" });
    },
    disconnectApp: (slug) => {
      apps = {
        ...apps,
        apps: apps.apps.map((a) => (a.slug === slug ? { ...a, connected: false } : a)),
      };
      return delay(apps);
    },
    agents: () => delay(agents),
    installAgent: (id) => {
      const npm = id === "codex";
      const total = npm ? 0 : 48_027_930;
      let received = 0;
      const current = agents.find((a) => a.id === id) as AgentView;
      patch(id, { ...reset(current), state: "installing", progress: { received, total } });
      installTimer = setInterval(() => {
        received = npm ? received + 1 : Math.min(total, received + 4_000_000);
        if (npm ? received < 8 : received < total) {
          patch(id, { progress: { received: npm ? 0 : received, total } });
          return;
        }
        clearInterval(installTimer);
        setAgents(
          agents.map((a) =>
            a.id === id
              ? {
                  id,
                  name: a.name,
                  state: "ready",
                  source: "managed",
                  version: "1.0.0",
                  canInstall: true,
                  canRemove: true,
                }
              : a,
          ),
        );
      }, 300);
      return delay(agents);
    },
    cancelInstall: (id) => {
      clearInterval(installTimer);
      return delay(setAgents(agents.map((a) => (a.id === id ? reset(a) : a))));
    },
    removeAgent: (id) => delay(setAgents(agents.map((a) => (a.id === id ? reset(a) : a)))),
    verifyAgent: (id) => {
      const loginNeeded = false;
      const agent = agents.find((a) => a.id === id);
      return delay(
        loginNeeded
          ? {
              id,
              ok: false,
              needsLogin: true,
              authMethods: ["Log in with your account"],
              error: "Authentication required",
              ms: 1800,
            }
          : {
              id,
              ok: true,
              needsLogin: false,
              agentName: agent?.name ?? id,
              agentVersion: agent?.version ?? "0.2.1-rc.2",
              authMethods: [],
              ms: 1200,
            },
        1200,
      );
    },
    status: () => delay(status),
    reconnect: () => {
      // The second try connects.
      if (status.channel.bound) {
        status = {
          ...status,
          channel: { bound: true, appId: status.channel.appId, connected: true },
        };
        emit({ topic: "status", data: structuredClone(status) });
      }
      return delay(status, 900);
    },
    tasks: () => delay(tasks),
    transcript: (taskId) => delay(sampleTranscript(taskId)),
    memories: () => delay(memory),
    schedules: () => delay(schedules),
    setSchedulePaused: (id, paused) => {
      schedules = {
        ...schedules,
        schedules: schedules.schedules.map((s) => {
          if (s.id !== id) return s;
          const { nextAt: _, ...rest } = s;
          return paused ? { ...rest, paused } : { ...rest, paused, nextAt: hoursFromNow(20) };
        }),
      };
      return delay(schedules);
    },
    removeSchedule: (id) => {
      schedules = { ...schedules, schedules: schedules.schedules.filter((s) => s.id !== id) };
      return delay(schedules);
    },
    editMemory: (id, text) => {
      memory = {
        ...memory,
        entries: memory.entries.map((e) =>
          e.id === id ? { ...e, abstract: text, source: "owner_edit" as const, rev: e.rev + 1 } : e,
        ),
      };
      return delay(memory);
    },
    forgetMemory: (id) => {
      const gone = memory.entries.find((e) => e.id === id);
      memory = {
        ...memory,
        entries: memory.entries.filter((e) => e.id !== id),
        deleted:
          gone === undefined ? memory.deleted : [{ ...gone, status: "deleted" }, ...memory.deleted],
      };
      return delay(memory);
    },
    restoreMemory: (id) => {
      const back = memory.deleted.find((e) => e.id === id);
      memory = {
        ...memory,
        deleted: memory.deleted.filter((e) => e.id !== id),
        entries:
          back === undefined ? memory.entries : [{ ...back, status: "active" }, ...memory.entries],
      };
      return delay(memory);
    },
    providers: () => delay(providers),
    models: () => delay(models),
    putService: (service, key) => {
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(service.id)) {
        return Promise.reject(new Error(`service id "${service.id}" is invalid`));
      }
      if (service.models.length === 0) {
        return Promise.reject(new Error(`service "${service.id}" has no models`));
      }
      if (key === "") keys.delete(service.id);
      else if (key !== undefined) keys.set(service.id, key);
      const others = models.services.filter((s) => s.id !== service.id);
      models = {
        ...models,
        services: [...others, { ...service, hasKey: keys.has(service.id) }],
      };
      return delay(modelsChanged());
    },
    removeService: (serviceId) => {
      keys.delete(serviceId);
      models = { ...models, services: models.services.filter((s) => s.id !== serviceId) };
      return delay(modelsChanged());
    },
    setKey: (serviceId, key) => {
      if (key === "") keys.delete(serviceId);
      else keys.set(serviceId, key);
      models = {
        ...models,
        services: models.services.map((s) =>
          s.id === serviceId ? { ...s, hasKey: keys.has(serviceId) } : s,
        ),
      };
      return delay(modelsChanged());
    },
    chooseModel: (role, ref) => {
      const roles = { ...models.roles };
      if (ref === null) delete roles[role];
      else roles[role] = ref;
      models = { ...models, roles };
      return delay(modelsChanged());
    },
    testModel: (ref) => {
      const s = models.services.find((x) => x.id === ref.serviceId);
      if (s === undefined) return delay({ ok: false, message: `no service "${ref.serviceId}"` });
      if (!keys.has(s.id) && s.kind === "builtin") {
        return delay({ ok: false, message: "401 Unauthorized: missing API key" }, 700);
      }
      return delay({ ok: true, reply: `你好，我是 ${ref.model}。` }, 900);
    },
    probeModels: (target) => {
      const saved = models.services.find((x) => x.id === target.serviceId);
      const base = (target.baseUrl ?? saved?.baseUrl ?? "").replace(/\/+$/, "");
      if (base.includes("down")) {
        return delay({ ok: false, message: `GET ${base}/models: connect ECONNREFUSED` }, 600);
      }
      const ids = ["deepseek-v4-flash", "glm-5", "gpt-5.5", "kimi-k2.6", "qwen3-coder-plus"];
      return delay(
        {
          ok: true,
          models: ids.map((id) => ({ id, name: id })),
          ...(/\/v1$/.test(base) ? {} : { baseUrl: `${base}/v1` }),
        },
        700,
      );
    },
    setupFeishu: () => {
      for (const t of setupTimers) clearTimeout(t);
      setupTimers = [];
      setSetup({
        phase: "waiting-scan",
        qrDataUrl: PLACEHOLDER_QR,
        url: "https://open.feishu.cn/example",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      setupTimers.push(
        setTimeout(() => setSetup({ phase: "waiting-confirm" }), 5000),
        setTimeout(() => setSetup({ phase: "verifying" }), 8000),
        setTimeout(() => {
          status = {
            ...status,
            channel: { bound: true, appId: "cli_fake123", connected: true },
          };
          setSetup({ phase: "connected" });
          emit({ topic: "status", data: structuredClone(status) });
        }, 10000),
      );
      return delay(setup);
    },
    cancelSetup: () => {
      for (const t of setupTimers) clearTimeout(t);
      setupTimers = [];
      setup = { phase: "idle" };
      return delay(setup);
    },
    setupState: () => delay(setup),
    modelTiers: () => delay(tiersView()),
    setModelTiers: (tiers) => {
      placed = tiers;
      return delay(tiersView());
    },
    updateSettings: (patch) => {
      status = { ...status, ...patch };
      emit({ topic: "status", data: structuredClone(status) });
      return delay(status);
    },
  };

  const fakeBridge: Bridge = {
    host: fake,
    onEvent: (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onConnection: (listener) => {
      connectionListeners.add(listener);
      setTimeout(() => listener(true), 0);
      if (sim === "offline") setTimeout(() => listener(false), 1000);
      return () => connectionListeners.delete(listener);
    },
  };
  window.agentherd = fakeBridge;
  console.info("[AgentHerd] window.agentherd not found; using the in-memory dev bridge.");
}

let fakeInstalled = false;
if ((window as Partial<Window>).agentherd === undefined) {
  installFakeBridge();
  fakeInstalled = true;
}

/** The dialog named by `?open=`; only with the fake bridge, so never in the real app. */
export function devOpen(): string | null {
  return fakeInstalled ? new URLSearchParams(window.location.search).get("open") : null;
}
