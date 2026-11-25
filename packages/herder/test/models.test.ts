import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chooseModel,
  emptyModelSettings,
  type ModelService,
  putService,
  type SecretStore,
} from "@agentherd/core";
import { afterEach, describe, expect, it } from "vitest";
import { validateDreamReply } from "../src/memory-jobs.ts";
import {
  builtinProviders,
  CUSTOM_CONTEXT_WINDOW,
  dreamModels,
  herderFallbacks,
  herderFromSettings,
  knownInput,
  MEMORY_MODEL_DOWN_MS,
  MemoryModelChain,
  memoryModels,
  PI_KEY_ENV,
  PI_MODEL_ENV,
  piModelEnv,
  resolveModel,
  serviceKey,
  testModel,
} from "../src/models.ts";

function secrets(values: Record<string, string> = {}): SecretStore {
  return {
    get: (a) => values[a],
    set: (a, v) => {
      values[a] = v;
    },
    delete: (a) => {
      delete values[a];
    },
  };
}

const deepseek: ModelService = {
  id: "deepseek",
  name: "DeepSeek",
  kind: "builtin",
  provider: "deepseek",
  models: ["deepseek-flash"],
};

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

/** A tiny OpenAI-compatible endpoint that streams one reply. */
async function fakeEndpoint(status = 200): Promise<{ url: string; auth: string[] }> {
  const auth: string[] = [];
  server = createServer((req, res) => {
    auth.push(String(req.headers.authorization));
    req.resume();
    req.on("end", () => {
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad key" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: "assistant", content: "OK" }, null));
      res.write(chunk({}, "stop"));
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, auth };
}

describe("builtinProviders", () => {
  it("lists key-only providers with their models", () => {
    const list = builtinProviders();
    const ds = list.find((p) => p.provider === "deepseek");
    expect(ds?.models.map((m) => m.id)).toContain("deepseek-flash");
    expect(list.some((p) => p.provider === "amazon-bedrock")).toBe(false);
  });
});

describe("resolveModel", () => {
  it("uses pi-ai's model for a builtin service", () => {
    expect(resolveModel(deepseek, "deepseek-flash").baseUrl).toBe("https://api.deepseek.com");
  });

  it("allows a new model id of a known provider", () => {
    const m = resolveModel(deepseek, "deepseek-v9");
    expect(m).toMatchObject({ id: "deepseek-v9", api: "openai-completions", reasoning: false });
  });

  it("builds an OpenAI-compatible model", () => {
    const m = resolveModel(
      {
        id: "relay",
        name: "Relay",
        kind: "openai-compatible",
        baseUrl: "https://r.example/v1/",
        models: ["x"],
      },
      "x",
    );
    expect(m).toMatchObject({
      baseUrl: "https://r.example/v1",
      provider: "relay",
      contextWindow: CUSTOM_CONTEXT_WINDOW,
    });
  });
});

describe("knownInput", () => {
  it("reads images for a model pi-ai knows with vision, under any provider prefix", () => {
    expect(knownInput("claude-opus-5-5")).toEqual(["text", "image"]);
    expect(knownInput("anthropic/claude-opus-5-5")).toEqual(["text", "image"]);
    expect(knownInput("my-private-model")).toEqual(["text"]);
  });
});

describe("serviceKey", () => {
  it("prefers the secret store, then the provider's variable", () => {
    expect(
      serviceKey(deepseek, secrets({ "model:deepseek": "saved" }), { DEEPSEEK_API_KEY: "env" }),
    ).toBe("saved");
    expect(serviceKey(deepseek, secrets(), { DEEPSEEK_API_KEY: "env" })).toBe("env");
    expect(serviceKey(deepseek, secrets(), {})).toBeUndefined();
  });
});

describe("testModel", () => {
  it("reports the reply of a working endpoint and sends the key", async () => {
    const { url, auth } = await fakeEndpoint();
    const model = resolveModel(
      { id: "local", name: "Local", kind: "openai-compatible", baseUrl: url, models: ["m"] },
      "m",
    );
    expect(await testModel(model, "k1")).toEqual({ ok: true, reply: "OK" });
    expect(auth).toEqual(["Bearer k1"]);
  });

  it("reports an error", async () => {
    const { url } = await fakeEndpoint(401);
    const model = resolveModel(
      { id: "local", name: "Local", kind: "openai-compatible", baseUrl: url, models: ["m"] },
      "m",
    );
    const result = await testModel(model, "bad");
    expect(result.ok).toBe(false);
  });
});

describe("herderFromSettings", () => {
  it("needs a chosen model and a key", () => {
    let s = putService(emptyModelSettings(), deepseek);
    expect(herderFromSettings(s, secrets(), {})).toEqual({
      reason: "no model chosen for the Herder",
    });
    s = chooseModel(s, "herder", { serviceId: "deepseek", model: "deepseek-flash" });
    expect(herderFromSettings(s, secrets(), {})).toEqual({
      reason: 'no key for service "deepseek"',
    });
    expect(herderFromSettings(s, secrets({ "model:deepseek": "k" }), {})).toMatchObject({
      ref: "deepseek/deepseek-flash",
    });
  });
});

describe("herderFallbacks", () => {
  it("lists the other models with a key, the current one left out", () => {
    const relay: ModelService = {
      id: "relay",
      name: "Relay",
      kind: "openai-compatible",
      baseUrl: "https://relay.example/v1",
      models: ["deepseek-flash", "glm-5"],
    };
    let s = putService(putService(emptyModelSettings(), deepseek), relay);
    s = chooseModel(s, "herder", { serviceId: "deepseek", model: "deepseek-flash" });
    const keys = secrets({ "model:relay": "k" });
    const refs = herderFallbacks(s, keys, "deepseek/deepseek-flash").map((m) => m.ref);
    expect(refs[0]).toBe("relay/deepseek-flash");
    expect(refs).toContain("relay/glm-5");
    expect(refs).not.toContain("deepseek/deepseek-flash");
    // Without a key a built-in service is skipped.
    expect(herderFallbacks(s, keys, "relay/glm-5").map((m) => m.ref)).not.toContain(
      "deepseek/deepseek-flash",
    );
  });
});

describe("piModelEnv", () => {
  it("passes the model as JSON and the key in its own variable", () => {
    let s = putService(emptyModelSettings(), deepseek);
    expect(piModelEnv(s, secrets(), {})).toMatchObject({ reason: expect.stringMatching(/Pi/) });
    s = chooseModel(s, "pi", { serviceId: "deepseek", model: "deepseek-flash" });
    expect(piModelEnv(s, secrets(), {})).toEqual({ reason: 'no key for service "deepseek"' });
    const choice = piModelEnv(s, secrets({ "model:deepseek": "sk-pi-secret" }), {});
    if (!("env" in choice)) throw new Error(choice.reason);
    expect(choice.ref).toBe("deepseek/deepseek-flash");
    expect(choice.env[PI_KEY_ENV]).toBe("sk-pi-secret");
    expect(JSON.parse(choice.env[PI_MODEL_ENV] ?? "")).toMatchObject({
      id: "deepseek-flash",
      baseUrl: "https://api.deepseek.com",
    });
    expect(choice.env[PI_MODEL_ENV]).not.toContain("sk-pi-secret");
  });
});

describe("memory models fall back (ADR 0090)", () => {
  it("dreams on the Herder, strong, then fast; skips unavailable services and duplicate refs", () => {
    const relay: ModelService = {
      id: "relay",
      name: "Relay",
      kind: "openai-compatible",
      models: ["chief", "strong", "quick", "deepseek-flash"],
      baseUrl: "https://relay.example/v1",
    };
    const settings = chooseModel(
      putService(putService(emptyModelSettings(), deepseek), relay),
      "herder",
      { serviceId: "relay", model: "chief" },
    );
    const entries = (...models: string[]) => models.map((model) => ({ model, auto: false }));
    const tiers = {
      strong: entries("strong", "deepseek-flash", "chief"),
      balanced: [],
      fast: entries("quick", "strong"),
    };
    expect(dreamModels(settings, secrets(), tiers, {}).map((model) => model.ref)).toEqual([
      "relay/chief",
      "relay/strong",
      "relay/deepseek-flash",
      "relay/quick",
    ]);
    expect(memoryModels(settings, secrets(), tiers, {}).map((model) => model.ref)).toEqual([
      "relay/quick",
      "relay/strong",
      "relay/chief",
    ]);
    expect(dreamModels(settings, secrets(), undefined, {}).map((model) => model.ref)).toEqual([
      "relay/chief",
    ]);
  });

  function fake(ref: string, answer: string | Error, seen: string[]) {
    return {
      ref,
      complete: async () => {
        seen.push(ref);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
  }

  it("tries the next model when one fails, then passes the failed one over for a while", async () => {
    const seen: string[] = [];
    let now = 1_000;
    const logs: string[] = [];
    const chain = new MemoryModelChain(
      () => [
        fake("site/gpt-6-luna", new Error("Request timed out."), seen),
        fake("deepseek/deepseek-flash", "{}", seen),
      ],
      (line) => logs.push(line),
      () => now,
    );
    const signal = new AbortController().signal;
    expect(await chain.complete("s", "u", signal)).toBe("{}");
    expect(seen).toEqual(["site/gpt-6-luna", "deepseek/deepseek-flash"]);
    expect(logs[0]).toContain("site/gpt-6-luna failed (Request timed out.)");
    expect(await chain.complete("s", "u", signal)).toBe("{}");
    expect(seen.slice(2)).toEqual(["deepseek/deepseek-flash"]);
    now += MEMORY_MODEL_DOWN_MS + 1;
    await chain.complete("s", "u", signal);
    expect(seen.slice(3)).toEqual(["site/gpt-6-luna", "deepseek/deepseek-flash"]);
  });

  it("tries every model when all are passed over, and says what each one answered", async () => {
    const seen: string[] = [];
    const chain = new MemoryModelChain(() => [
      fake("a/x", new Error("401"), seen),
      fake("b/y", new Error("Request timed out."), seen),
    ]);
    const signal = new AbortController().signal;
    await expect(chain.complete("s", "u", signal)).rejects.toThrow(
      "a/x: 401; b/y: Request timed out.",
    );
    await expect(chain.complete("s", "u", signal)).rejects.toThrow("a/x: 401");
    expect(seen).toEqual(["a/x", "b/y", "a/x", "b/y"]);
  });

  it("falls through malformed dream replies and cools down the models that returned them", async () => {
    const seen: string[] = [];
    const valid = '{"operations":[]}';
    const chain = new MemoryModelChain(() => [
      fake("herder", "{broken}", seen),
      fake("strong", '{"summary":"done"}', seen),
      fake("fast", valid, seen),
    ]);
    const signal = new AbortController().signal;
    expect(await chain.complete("s", "u", signal, validateDreamReply)).toBe(valid);
    expect(seen).toEqual(["herder", "strong", "fast"]);
    expect(await chain.complete("s", "u", signal, validateDreamReply)).toBe(valid);
    expect(seen.slice(3)).toEqual(["fast"]);
  });

  it("says so when no model is set up", async () => {
    const chain = new MemoryModelChain(() => []);
    await expect(chain.complete("s", "u", new AbortController().signal)).rejects.toThrow(
      "no model for memory",
    );
  });
});
