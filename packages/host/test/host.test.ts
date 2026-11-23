import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeChannel } from "@agentherd/channel-fake";
import {
  type Herd,
  type HerderHost,
  PROFILE_FIELDS,
  type SecretStore,
  Store,
} from "@agentherd/core";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PET, type HostEvent, PROFILE_FIELD_NAMES } from "../src/api.ts";
import { readConfig, writeConfig } from "../src/config.ts";
import { Host } from "../src/host.ts";
import { connectHost, isHostRunning, serveApi, socketPath } from "../src/server.ts";

function memorySecrets(): SecretStore & { saved: Record<string, string> } {
  const saved: Record<string, string> = {};
  return {
    saved,
    get: (a) => saved[a],
    set: (a, v) => {
      saved[a] = v;
    },
    delete: (a) => {
      delete saved[a];
    },
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function makeHost(bound = false, profileIds: string[] = []) {
  // Short path: Unix socket paths are limited to about 104 bytes on macOS.
  const home = mkdtempSync(join(tmpdir(), "ah-"));
  if (bound) writeConfig(home, { channel: { channelId: "fake", ownerId: "owner", data: {} } });
  const secrets = memorySecrets();
  const channels: FakeChannel[] = [];
  const events: HostEvent[] = [];
  const host = new Host({
    home,
    userHome: home,
    secrets,
    env: {},
    profiles: () =>
      profileIds.map((id) => ({ id, name: id, command: [id], env: {}, exporter: null })),
    createChannel: () => {
      const c = new FakeChannel();
      channels.push(c);
      return c;
    },
  });
  host.onEvent((e) => events.push(e));
  cleanups.push(() => host.stop());
  return { home, host, secrets, channels, events };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
}

describe("Host", () => {
  it("starts without a channel and reports why the Herder is off", async () => {
    const t = makeHost();
    await t.host.start();
    const s = t.host.status();
    expect(s.channel).toEqual({ bound: false, connected: false });
    expect(s.herder).toEqual({ on: false, reason: "no model chosen for the Herder" });
    expect(s.mode).toBe("assist");
    expect(t.host.tasks()).toEqual({ tasks: [], items: [] });
  });

  it("binds the channel through setup and connects", async () => {
    const t = makeHost();
    await t.host.start();
    expect(t.host.setupFeishu().phase).toBe("starting");
    await until(() => t.host.status().channel.connected);
    expect(readConfig(t.home).channel?.channelId).toBe("fake");
    expect(t.host.setupState().phase).toBe("connected");
    expect(t.events.some((e) => e.topic === "setup" && e.data.phase === "connected")).toBe(true);
  });

  it("keeps model keys out of config.json and turns the Herder on and off", async () => {
    const t = makeHost(true);
    await t.host.start();
    expect(t.host.status().channel.connected).toBe(true);
    await t.host.putService(
      {
        id: "deepseek",
        name: "DeepSeek",
        kind: "builtin",
        provider: "deepseek",
        models: ["deepseek-flash"],
      },
      "sk-secret",
    );
    expect(t.host.models().services[0]?.hasKey).toBe(true);
    await t.host.chooseModel("herder", { serviceId: "deepseek", model: "deepseek-flash" });
    expect(t.host.status().herder).toEqual({ on: true, ref: "deepseek/deepseek-flash" });
    expect(readFileSync(join(t.home, "config.json"), "utf8")).not.toContain("sk-secret");
    expect(t.secrets.saved).toEqual({ "model:deepseek": "sk-secret" });

    await t.host.chooseModel("pi", { serviceId: "deepseek", model: "deepseek-flash" });
    expect(t.host.models().roles.pi).toEqual({ serviceId: "deepseek", model: "deepseek-flash" });

    await t.host.setKey("deepseek", "");
    expect(t.host.status().herder).toEqual({ on: false, reason: 'no key for service "deepseek"' });
    await t.host.removeService("deepseek");
    expect(t.host.models()).toEqual({ services: [], roles: {} });
    expect(t.events.some((e) => e.topic === "models")).toBe(true);
  });

  it("probes a saved service's models with its saved key unless a new key is typed", async () => {
    const seen: string[] = [];
    const host = new Host({
      home: mkdtempSync(join(tmpdir(), "ah-")),
      secrets: memorySecrets(),
      env: {},
      profiles: () => [],
      createChannel: () => new FakeChannel(),
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        seen.push(headers.authorization ?? "");
        return new Response(JSON.stringify({ data: [{ id: "m1" }] }));
      }) as typeof fetch,
    });
    cleanups.push(() => host.stop());
    await host.putService(
      {
        id: "relay",
        name: "Relay",
        kind: "openai-compatible",
        baseUrl: "https://relay.example/v1",
        models: ["m1"],
      },
      "sk-saved",
    );
    expect(await host.probeModels({ serviceId: "relay" })).toEqual({
      ok: true,
      models: [{ id: "m1", name: "m1" }],
    });
    await host.probeModels({ serviceId: "relay", key: "sk-new" });
    expect(seen).toEqual(["Bearer sk-saved", "Bearer sk-new"]);
    expect(await host.probeModels({ serviceId: "nope" })).toEqual({
      ok: false,
      message: 'no service "nope"',
    });
  });

  it("connects multiple WeCom office services through one scan without changing the channel", async () => {
    const home = mkdtempSync(join(tmpdir(), "ah-"));
    writeConfig(home, { channel: { channelId: "fake", ownerId: "owner", data: {} } });
    const secrets = memorySecrets();
    let signedIn = false;
    let scans = 0;
    let finish = () => {};
    const scanned = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const host = new Host({
      home,
      secrets,
      env: {},
      profiles: () => [],
      createChannel: () => new FakeChannel(),
      mcpSocket: socketPath(home),
      wecomCli: {
        status: async () => signedIn,
        login: async (qr) => {
          scans++;
          qr("data:image/png;base64,ZmFrZQ==");
          await scanned;
          signedIn = true;
        },
        logout: async () => {
          signedIn = false;
        },
        run: async (args) => {
          if (args[1] === "list") {
            return Object.entries({
              calendar: "calendar.schedules.list",
              meeting: "meeting.list",
              todo: "todo.list",
            }).map(([name, method]) => ({
              name,
              methods: [{ name: method, description: "List items" }],
            }));
          }
          return {
            method: args[2],
            request: { type: "object", properties: {} },
            schemas: {},
            response: {},
          };
        },
      },
    });
    cleanups.push(() => host.stop());
    const server = await serveApi(host, socketPath(home));
    cleanups.push(() => server.close());
    const client = await connectHost(socketPath(home));
    cleanups.push(async () => client.close());
    await host.start();
    let port: HerderHost | undefined;
    const herd = (host as unknown as { herd: Herd }).herd;
    await herd.setHerder((h) => {
      port = h;
      return {
        ownerMessage: () => {},
        ownerAnswer: () => {},
        event: () => {},
        stop: async () => {},
      };
    });
    expect(port?.apps?.()).not.toContain("企业微信");
    expect(await client.host.wecom()).toEqual({ state: "disconnected", capabilities: [] });
    await client.host.startWecomLogin();
    expect(await client.host.wecom()).toMatchObject({
      state: "connecting",
      qr: "data:image/png;base64,ZmFrZQ==",
    });
    finish();
    await expect.poll(async () => (await client.host.wecom()).state).toBe("connected");
    const view = await client.host.wecom();
    expect(view.capabilities.map(({ id }) => id).sort()).toEqual(["calendar", "meeting", "todo"]);
    expect(scans).toBe(1);
    expect(port?.apps?.()).toContain("企业微信");
    expect(view.qr).toBeUndefined();
    expect(readFileSync(join(home, "config.json"), "utf8")).not.toContain("data:image");
    expect(readConfig(home).channel?.channelId).toBe("fake");
    expect(await client.host.disconnectWecom()).toEqual({
      state: "disconnected",
      capabilities: [],
    });
    expect(port?.apps?.()).not.toContain("企业微信");
  });

  it("reconnects the channel on request", async () => {
    const t = makeHost(true);
    await t.host.start();
    expect((await t.host.reconnect()).channel.connected).toBe(true);
    expect(t.channels).toHaveLength(2);
  });

  it("changes the mode and keep-awake, refusing auto", async () => {
    const t = makeHost(true);
    await t.host.start();
    expect(t.host.updateSettings({ mode: "observe", keepAwake: true })).toMatchObject({
      mode: "observe",
      keepAwake: true,
    });
    expect(readConfig(t.home)).toMatchObject({ mode: "observe", keepAwake: true });
    expect(() => t.host.updateSettings({ mode: "auto" })).toThrow(/observe or assist/);
  });

  it("shows the desktop pet by default, saves its figure and passes the owner's words on (ADR 0070)", async () => {
    const t = makeHost(true);
    expect(t.host.status().pet).toEqual(DEFAULT_PET);
    expect(t.host.pet()).toEqual({ connected: false, pending: [], history: [], cards: [] });
    await expect(t.host.stopTask("t1")).rejects.toThrow("not running");
    await t.host.start();
    expect(t.host.pet().connected).toBe(true);

    expect(t.host.updateSettings({ pet: { figure: "claude" } }).pet).toEqual({
      ...DEFAULT_PET,
      figure: "claude",
    });
    expect(t.host.updateSettings({ pet: { on: false } }).pet).toEqual({
      ...DEFAULT_PET,
      on: false,
      figure: "claude",
    });
    expect(readConfig(t.home).pet).toMatchObject({ on: false, figure: "claude" });
    // The Herder's working window (ADR 0097).
    expect(t.host.status().herderWindow).toBe(128_000);
    expect(t.host.updateSettings({ herderWindow: 256_000 }).herderWindow).toBe(256_000);
    expect(readConfig(t.home).herderWindow).toBe(256_000);
    expect(t.host.updateSettings({ herderWindow: 0 }).herderWindow).toBe(0);
    expect(() => t.host.updateSettings({ herderWindow: 100 })).toThrow(
      "herderWindow must be one of 64000, 128000, 256000, 0",
    );
    expect(() => t.host.updateSettings({ pet: { figure: "cat" as never } })).toThrow(
      /deepseek, claude, frieren/,
    );
    // The anime figures of ADR 0092 are kept like the others.
    expect(t.host.updateSettings({ pet: { figure: "frieren" } }).pet.figure).toBe("frieren");
    t.host.updateSettings({ pet: { figure: "claude" } });
    // Notifications and quiet hours (ADR 0079).
    expect(
      t.host.updateSettings({
        pet: { sound: false, quietHours: "22:30-07:45", quietUntil: "2026-11-19T12:00:00.000Z" },
      }).pet,
    ).toMatchObject({ notify: true, sound: false, quietHours: "22:30-07:45" });
    expect(() => t.host.updateSettings({ pet: { quietHours: "25:00-07:00" } })).toThrow(
      /HH:MM-HH:MM/,
    );
    expect(() => t.host.updateSettings({ pet: { quietUntil: "soon" } })).toThrow(/quietUntil/);
    expect(() => t.host.updateSettings({ pet: { notify: "yes" as never } })).toThrow(/pet.notify/);
    t.host.updateSettings({ pet: { sound: true, quietHours: "", quietUntil: "" } });
    // Global shortcuts (ADR 0080).
    expect(t.host.status().pet).toMatchObject({
      talkKey: "CommandOrControl+Shift+Space",
      approveKey: "CommandOrControl+Shift+Y",
    });
    expect(
      t.host.updateSettings({ pet: { talkKey: "Control+Alt+Space", approveKey: "" } }).pet,
    ).toMatchObject({
      talkKey: "Control+Alt+Space",
      approveKey: "",
    });
    expect(() => t.host.updateSettings({ pet: { talkKey: "Y" } })).toThrow(
      /pet.talkKey must be a shortcut/,
    );
    expect(() => t.host.updateSettings({ pet: { approveKey: "Control+Alt+Space" } })).toThrow(
      /different shortcuts/,
    );
    t.host.updateSettings({
      pet: { talkKey: "CommandOrControl+Shift+Space", approveKey: "CommandOrControl+Shift+Y" },
    });
    // Where it floats (ADR 0080).
    expect(t.host.status().pet).toMatchObject({ onTop: "always", overFullscreen: false });
    expect(
      t.host.updateSettings({ pet: { onTop: "busy", overFullscreen: true } }).pet,
    ).toMatchObject({ onTop: "busy", overFullscreen: true });
    expect(() => t.host.updateSettings({ pet: { onTop: "never" as never } })).toThrow(
      /pet.onTop must be one of always, busy/,
    );
    t.host.updateSettings({ pet: { onTop: "always", overFullscreen: false } });

    await t.host.petSay("在吗");
    const chat = t.channels[0];
    // No Herder here, so the herd answers by itself; the pet shows that answer.
    await until(() => (t.host.pet().last?.id ?? 0) > 0);
    // What the owner typed rides on the answer, so the chat app rings only once.
    expect(chat?.messages[0]?.view).toMatchObject({
      text: expect.stringMatching(/^> （在桌宠里说）在吗\n\n---\n\n/),
    });
    expect(t.events.some((e) => e.topic === "pet")).toBe(true);
    // The expanded pet shows the Herder's conversation as herd.db keeps it, from before this
    // start too (none here: no Herder).
    expect(t.host.pet().history).toEqual([]);
    const db = Store.open(join(t.home, "herd.db"));
    db.addHerderTurn("owner", "昨天的话");
    db.addHerderTurn("herder", "昨天的回答");
    // The cards sent before this start are there too (ADR 0072).
    db.putOwnerCard("fake:m9", { kind: "ask", askId: "a1", text: "用哪个？", options: [] });
    db.close();
    expect(t.host.pet().cards).toMatchObject([
      { ref: "fake:m9", open: false, view: { kind: "ask", text: "用哪个？" } },
    ]);
    expect(t.host.pet().history.map((l) => [l.kind, l.text])).toEqual([
      ["owner", "昨天的话"],
      ["say", "昨天的回答"],
    ]);
    await expect(t.host.petPress("nothing", "allow")).rejects.toThrow("这件事已经处理过了");
  });

  it("shows the Herder's guess at the owner's next message until anything new is said (ADR 0084)", async () => {
    const t = makeHost(true);
    await t.host.start();
    let port: HerderHost | undefined;
    const herd = (t.host as unknown as { herd: Herd }).herd;
    await herd.setHerder((h) => {
      port = h;
      return {
        ownerMessage: () => {},
        ownerAnswer: () => {},
        event: () => {},
        stop: async () => {},
      };
    });
    const hook = port?.suggestion;
    expect(hook?.on()).toBe(true);
    hook?.show("把 b 下载下来");
    expect(t.host.pet().suggestion).toBe("把 b 下载下来");
    expect(t.events.some((e) => e.topic === "pet" && e.data.suggestion === "把 b 下载下来")).toBe(
      true,
    );
    // A card that waits for the owner comes first.
    hook?.show("好");
    await new Promise((r) => setTimeout(r, 5));
    herd.store.putOwnerCard("fake:m1", { kind: "ask", askId: "a1", text: "用哪个？", options: [] });
    (t.host as unknown as { petFeed: { isOpen(ref: string): boolean } }).petFeed.isOpen = () =>
      true;
    expect(t.host.pet().suggestion).toBeUndefined();
    // Anything said makes it stale.
    hook?.show("再试一次");
    port?.recordTurn("owner", "算了");
    expect(t.host.pet().suggestion).toBeUndefined();
    // The owner can turn it off.
    expect(t.host.updateSettings({ pet: { suggest: false } }).pet.suggest).toBe(false);
    expect(hook?.on()).toBe(false);
    expect(() => t.host.updateSettings({ pet: { suggest: "yes" as never } })).toThrow(
      /pet.suggest must be true or false/,
    );
  }, 20_000);

  it("timers and GitHub work live in the 信箱; a timer shows when it runs next (ADR 0100)", async () => {
    const off = makeHost(false);
    await off.host.start();
    expect(off.host.mailbox().on).toBe(false);
    await expect(
      off.host.mailboxAdd({
        kind: "timer",
        name: "看新 issue",
        note: "看看 PI-Desktop 有没有新 issue",
        when: { kind: "daily", at: "09:00" },
      }),
    ).rejects.toThrow(/not running/);

    const t = makeHost(true);
    await t.host.start();
    const view = await t.host.mailboxAdd({
      kind: "timer",
      name: "看新 issue",
      note: "看看 PI-Desktop 有没有新 issue，没有就不用说",
      when: { kind: "daily", at: "09:00", days: [1, 2, 3, 4, 5] },
    });
    const timer = view.sources[0];
    expect(timer).toMatchObject({ kind: "timer", everyMinutes: 0, paused: false, by: "owner" });
    expect(timer?.nextAt).toBeDefined();
    const paused = (await t.host.mailboxSet(timer?.id ?? "", { paused: true })).sources[0];
    expect(paused?.paused).toBe(true);
    expect(paused?.nextAt).toBeUndefined();
    const resumed = (await t.host.mailboxSet(timer?.id ?? "", { paused: false })).sources[0];
    expect(resumed?.nextAt).toBeDefined();
    await expect(
      t.host.mailboxAdd({ kind: "timer", name: "x", note: "y", when: { kind: "every", hours: 0 } }),
    ).rejects.toThrow();

    // GitHub work is offered by default; turning it automatic starts a trial run.
    const work = (
      await t.host.mailboxAdd({
        kind: "work",
        name: "acme 的 bug",
        note: "指派给我的",
        what: ["assigned"],
        repo: "acme/app",
      })
    ).sources.find((s) => s.kind === "work");
    expect(work).toMatchObject({ act: "offer", config: { what: ["assigned"], repo: "acme/app" } });
    const auto = (await t.host.mailboxSet(work?.id ?? "", { act: "auto" })).sources.find(
      (s) => s.kind === "work",
    );
    expect(auto?.act).toBe("trial");
    const free = (await t.host.mailboxSet(work?.id ?? "", { trial: false })).sources.find(
      (s) => s.kind === "work",
    );
    expect(free?.act).toBe("auto");

    expect((await t.host.mailboxRemove(timer?.id ?? "")).sources).toHaveLength(1);
    // Only pull requests tasks opened are watches now.
    expect(t.host.watches()).toEqual([]);
  });

  it("shows what the Herder did, newest turn first, with its errors", async () => {
    const t = makeHost(true);
    await t.host.start();
    expect(t.host.herderActivity()).toEqual({ turns: [], incidents: [], total: 0 });
    const herd = (t.host as unknown as { herd: Herd }).herd;
    const say = (text: string, at: number) => ({
      role: "user",
      content: [{ type: "text", text: `[Now: x]\n[Owner's message]\n${text}` }],
      timestamp: at,
    });
    const reply = (text: string, at: number) => ({
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: at,
    });
    herd.store.writeHerderLog(0, [
      say("一", Date.parse("2026-11-16T01:00:00Z")),
      reply("好", Date.parse("2026-11-16T01:00:01Z")),
      say("二", Date.parse("2026-11-16T02:00:00Z")),
      reply("行", Date.parse("2026-11-16T02:00:01Z")),
    ]);
    herd.store.audit("herder.tool", { name: "session_list" }, "2026-11-16T02:00:00.500Z");
    herd.store.audit("herder.error", { message: "boom" }, "2026-11-16T02:30:00Z");
    herd.store.audit("herder.retry", { delay: 1 }, "2026-11-16T00:30:00Z");

    const all = t.host.herderActivity();
    expect(all.total).toBe(2);
    expect(all.turns.map((x) => [x.text, x.reply])).toEqual([
      ["二", "行"],
      ["一", "好"],
    ]);
    // herder.tool is already in the turns; a retry before the oldest turn shown is left out.
    expect(all.incidents).toEqual([
      { at: "2026-11-16T02:30:00Z", kind: "herder.error", data: { message: "boom" } },
    ]);
    const newest = t.host.herderActivity(1);
    expect(newest.turns.map((x) => x.text)).toEqual(["二"]);
    expect(newest.total).toBe(2);
  });

  it("builds the 上下文 tab from herd.db and answers 'unchanged' until something is written (ADR 0095)", async () => {
    const t = makeHost(true);
    expect(() => t.host.herderContext()).toThrow(/not running/);
    await t.host.start();
    const herd = (t.host as unknown as { herd: Herd }).herd;
    herd.store.writeHerderLog(0, [
      {
        role: "user",
        content: [{ type: "text", text: "[Owner's message]\n你好" }],
        timestamp: Date.parse("2026-11-16T01:00:00Z"),
      },
    ]);
    const first = t.host.herderContext();
    if ("unchanged" in first) throw new Error("expected a view");
    expect(first.facts).toMatchObject({ messages: 1, rounds: 1, activeFolds: 0 });
    expect(first.segments).toEqual([
      { kind: "raw", startSeq: 0, endSeq: 0, messages: 1, tokens: first.facts.tokens },
    ]);
    expect(t.host.herderContext(first.key)).toEqual({ key: first.key, unchanged: true });
    expect(t.host.herderMessages(0, 5).map((m) => m.text)).toEqual(["[Owner's message]\n你好"]);
    herd.store.addHerderEvent("start", { messages: 1 });
    const next = t.host.herderContext(first.key);
    expect("unchanged" in next).toBe(false);
    expect(() => t.host.herderContextFold("b1")).toThrow("no fold b1");
  });

  it("keeps Codex out of new tasks after it fails to start one", async () => {
    const t = makeHost(true, ["pi", "codex"]);
    await t.host.start();
    const internals = t.host as unknown as {
      nextModel(p: string, failed: string, tried: string[]): Promise<unknown>;
      herdProfiles(): { id: string }[];
    };
    expect(internals.herdProfiles().map((p) => p.id)).toEqual(["pi", "codex"]);
    expect(await internals.nextModel("codex", "gw/gpt-6-luna", [])).toEqual({
      profileId: "pi",
      model: "gw/gpt-6-luna",
    });
    expect(internals.herdProfiles().map((p) => p.id)).toEqual(["pi"]);
  });

  it("places models in tiers by name, keeps where the owner drags them, and resets", async () => {
    const t = makeHost(false);
    await t.host.putService({
      id: "gw",
      name: "Gateway",
      kind: "openai-compatible",
      baseUrl: "https://gw.example/v1",
      models: ["claude-opus-5-5", "deepseek-flash", "my-model"],
    });
    await t.host.putService({
      id: "gw2",
      name: "Backup",
      kind: "openai-compatible",
      baseUrl: "https://gw2.example/v1",
      models: ["claude-opus-5-5"],
    });
    const refs = (tier: "strong" | "balanced" | "fast") =>
      t.host.modelTiers().tiers[tier].map((m) => m.model);
    expect(refs("strong")).toEqual(["claude-opus-5-5"]);
    expect(refs("balanced")).toEqual(["my-model"]);
    expect(refs("fast")).toEqual(["deepseek-flash"]);
    expect(t.host.modelTiers()).toMatchObject({ custom: false });
    expect(t.host.modelTiers().tiers.strong[0]).toMatchObject({
      model: "claude-opus-5-5",
      services: ["Gateway", "Backup"],
      auto: true,
    });

    t.host.setModelTiers({ strong: ["my-model", "claude-opus-5-5"], balanced: [], fast: [] });
    expect(refs("strong")).toEqual(["my-model", "claude-opus-5-5"]);
    expect(refs("balanced")).toEqual([]);
    expect(t.host.modelTiers().custom).toBe(true);
    // A model added later is placed by name, after the owner's.
    await t.host.putService({
      id: "gw",
      name: "Gateway",
      kind: "openai-compatible",
      baseUrl: "https://gw.example/v1",
      models: ["claude-opus-5-5", "deepseek-flash", "my-model", "gpt-6.1-sol"],
    });
    expect(refs("strong")).toEqual(["my-model", "claude-opus-5-5", "gpt-6.1-sol"]);
    // Plan 018 saved service/model refs; they still count.
    t.host.setModelTiers({ strong: [], balanced: [], fast: ["gw/my-model"] });
    expect(refs("fast")).toEqual(["my-model", "deepseek-flash"]);

    t.host.setModelTiers(null);
    expect(readConfig(t.home).modelTiers).toBeUndefined();
    expect(refs("balanced")).toEqual(["my-model"]);
  });
});

describe("local API socket", () => {
  it("normalizes Windows home paths when deriving named pipe paths", () => {
    const pipe = socketPath("C:\\Users\\me\\.agentherd", "win32");
    expect(pipe).toMatch(/^\\\\\.\\pipe\\agentherd-[0-9a-f]{16}$/);
    expect(socketPath("C:/Users/me/.agentherd/", "win32")).toBe(pipe);
  });

  it("answers calls, forwards events and refuses a second host", async () => {
    const t = makeHost();
    await t.host.start();
    const path = socketPath(t.home);
    const server = await serveApi(t.host, path);
    cleanups.unshift(() => server.close());
    expect(await isHostRunning(path)).toBe(true);
    await expect(serveApi(t.host, path)).rejects.toThrow(/another AgentHerd host/);

    const client = await connectHost(path);
    cleanups.unshift(async () => client.close());
    const events: HostEvent[] = [];
    client.onEvent((e) => events.push(e));
    expect((await client.host.status()).channel.bound).toBe(false);
    await client.host.putService({
      id: "local",
      name: "Ollama",
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      models: ["qwen3"],
    });
    await until(() => events.some((e) => e.topic === "models"));
    // Editing a service without a new key: JSON sends the undefined key as null.
    await client.host.setKey("local", "sk-local");
    const edited = await client.host.putService(
      {
        id: "local",
        name: "Ollama 2",
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:11434/v1",
        models: ["qwen3"],
      },
      undefined,
    );
    expect(edited.services.find((s) => s.id === "local")).toMatchObject({
      name: "Ollama 2",
      hasKey: true,
    });
    await expect(client.host.removeService("nope")).rejects.toThrow(/no service "nope"/);
    expect((await client.host.providers()).some((p) => p.provider === "deepseek")).toBe(true);
  });
});

describe("the owner's profile card (ADR 0091)", () => {
  it("lists the same fields as core", () => {
    expect([...PROFILE_FIELD_NAMES]).toEqual([...PROFILE_FIELDS]);
  });

  it("keeps a 称呼 set in the guide until AgentHerd runs, then writes it to memory", async () => {
    const t = makeHost();
    await t.host.start();
    expect(t.host.ownerProfile()).toEqual({});
    expect(t.host.setProfile("称呼", "  火哥 ")).toEqual({ 称呼: "火哥" });
    expect(readConfig(t.home).profileWaiting).toEqual({ 称呼: "火哥" });
    expect(() => t.host.setProfile("爱好" as "称呼", "爬山")).toThrow(/field must be one of/);
    expect(() => t.host.setProfile("在做", "很".repeat(61))).toThrow(/at most 60/);

    expect(t.host.setupFeishu().phase).toBe("starting");
    await until(() => t.host.status().channel.connected);
    expect(readConfig(t.home).profileWaiting).toBeUndefined();
    const card = t.host.memories().entries.filter((e) => e.kind === "profile");
    expect(card.map((e) => [e.abstract, e.source])).toEqual([["称呼：火哥", "owner_edit"]]);
    expect(t.host.memories().used.profile).toBe(5);

    expect(t.host.setProfile("在做", "AgentHerd")).toEqual({ 称呼: "火哥", 在做: "AgentHerd" });
    expect(t.host.setProfile("称呼", "")).toEqual({ 在做: "AgentHerd" });
    expect(t.host.memories().deleted.map((e) => e.abstract)).toContain("称呼：火哥");
  });
});
