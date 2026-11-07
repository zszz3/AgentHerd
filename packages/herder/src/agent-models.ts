// Which models from the owner's list each agent can run, and the env that makes it run one
// (ADR 0025). The Herder picks a model per task; the agent gets it through env, never through
// its command line, so the key stays out of `ps`.

import type { ModelService, ModelSettings, SecretStore } from "@agentherd/core";
import { parseModelRef } from "@agentherd/core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getProviders } from "@earendil-works/pi-ai/compat";
import { PI_KEY_ENV, PI_MODEL_ENV, resolveModel, serviceKey } from "./models.ts";

/** Env names for agents that read the key from a variable named in their config. */
export const CODEX_KEY_ENV = "AGENTHERD_CODEX_KEY";
export const CODEX_PROVIDER = "agentherd";

/** GPT-family models (gpt-*, o1/o3/o4…, codex-*), optionally behind a vendor prefix. */
export function isGptModel(id: string): boolean {
  return /(^|\/)(gpt-|chatgpt|codex|o[1-9](-|$))/i.test(id);
}

/**
 * The agent for a model when the owner does not name one (ADR 0031): Codex for GPT models,
 * Pi for everything else. Falls back to Pi when Codex is not installed, and to the first agent
 * when Pi is not either.
 */
export function agentForModel(ref: string | undefined, agentIds: readonly string[]): string {
  const id = ref === undefined ? "" : ref.slice(ref.indexOf("/") + 1);
  if (ref !== undefined && isGptModel(id) && agentIds.includes("codex")) return "codex";
  if (agentIds.includes("pi")) return "pi";
  const first = agentIds.find((a) => a !== "dsh") ?? agentIds[0];
  if (first === undefined) throw new Error("no agent installed");
  return first;
}

/** DSH reads the key from this variable, named in the provider it gets through `--patch`. */
export const DSH_KEY_ENV = "AGENTHERD_DSH_KEY";
export const DSH_PROVIDER = "agentherd";
/** The wire APIs DSH's pi-ai providers speak (dsh-llm-pi-ai config schema). */
const DSH_APIS: readonly string[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
];

/**
 * The patch overlay (`dsh --patch <file>`) that makes `dsh acp` use the model: one provider named
 * "agentherd" in place of the profile's providers, and the ACP route pointed at it. It holds no
 * key; DSH reads that from `DSH_KEY_ENV`.
 */
export function dshModelPatch(model: Model<Api>): unknown[] {
  return [
    {
      id: "llm-pi-ai",
      config: {
        providers: {
          [DSH_PROVIDER]: {
            displayName: "AgentHerd",
            apiKeyEnv: DSH_KEY_ENV,
            api: model.api,
            baseURL: model.baseUrl,
            ...(model.headers === undefined ? {} : { headers: model.headers }),
            models: [
              {
                id: model.id,
                name: model.name,
                input: model.input,
                ...(model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
                ...(model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {}),
              },
            ],
          },
        },
      },
    },
    { id: "acp", config: { provider: DSH_PROVIDER, model: model.id } },
  ];
}

/**
 * Whether Codex can run a model. Codex speaks only the Responses API (ADR 0031), so it takes:
 * GPT models on any OpenAI-style endpoint, any model pi-ai already reaches through Responses, and
 * any model of the owner's own OpenAI-compatible services — relays often offer Responses for
 * every model (checked on api.blueberrys.site with claude-opus-5-5 and gemini-3.8-flash). Other
 * built-in providers (DeepSeek, Moonshot…) have no Responses endpoint and stay with Pi. A relay
 * without Responses fails Codex's first turn and the task moves to Pi (ADR 0043).
 */
export function codexCanRun(model: Model<Api>): boolean {
  if (model.api === "openai-responses") return true;
  if (model.api !== "openai-completions") return false;
  if (isGptModel(model.id)) return true;
  return !(getProviders() as string[]).includes(model.provider);
}

/**
 * The env that makes an agent use a model, or `undefined` when the agent cannot use it.
 * - pi: any pi-ai model, through the bridge's model extension (verified with Pi 1.5.0).
 * - codex: models `codexCanRun` accepts, as a custom provider in `CODEX_CONFIG` (read by
 *   codex-acp).
 * - dsh: OpenAI- and Anthropic-style models; the key goes in env, the model in `dshModelPatch`.
 */
export function agentModelEnv(
  agentId: string,
  model: Model<Api>,
  key: string | undefined,
): Record<string, string> | undefined {
  switch (agentId) {
    case "pi":
      return { [PI_MODEL_ENV]: JSON.stringify(model), [PI_KEY_ENV]: key ?? "none" };
    case "codex":
      if (!codexCanRun(model)) return undefined;
      return {
        CODEX_CONFIG: JSON.stringify({
          model: model.id,
          model_provider: CODEX_PROVIDER,
          model_providers: {
            [CODEX_PROVIDER]: {
              name: "AgentHerd",
              base_url: model.baseUrl,
              env_key: CODEX_KEY_ENV,
              wire_api: "responses",
            },
          },
        }),
        MODEL_PROVIDER: CODEX_PROVIDER,
        [CODEX_KEY_ENV]: key ?? "none",
      };
    case "dsh":
      if (!DSH_APIS.includes(model.api)) return undefined;
      return { [DSH_KEY_ENV]: key ?? "none" };
    default:
      return undefined;
  }
}

export interface ModelChoice {
  /** "service/model" */
  ref: string;
  /** Profile ids that can run this model. */
  agents: string[];
}

function resolved(service: ModelService, id: string): Model<Api> | undefined {
  try {
    return resolveModel(service, id);
  } catch {
    return undefined;
  }
}

/** Every model in the owner's list, with the agents (of `agentIds`) that can run it. */
export function modelChoices(settings: ModelSettings, agentIds: string[]): ModelChoice[] {
  const out: ModelChoice[] = [];
  for (const service of settings.services) {
    for (const id of service.models) {
      const model = resolved(service, id);
      if (model === undefined) continue;
      // The key does not change which agents can use a model; a placeholder is enough here.
      const agents = agentIds.filter((a) => agentModelEnv(a, model, "key") !== undefined);
      out.push({ ref: `${service.id}/${id}`, agents });
    }
  }
  return out;
}

/**
 * The env for running `agentId` with the model `ref` ("service/model").
 * @throws When the model is not in the list, has no key, or the agent cannot run it.
 */
export function modelEnvFor(
  settings: ModelSettings,
  secrets: SecretStore,
  agentId: string,
  ref: string,
  env?: Record<string, string>,
): Record<string, string> {
  return modelLaunchFor(settings, secrets, agentId, ref, env).env;
}

export interface AgentLaunch {
  env: Record<string, string>;
  /** For DSH: the `--patch` overlay that selects the model (`dshModelPatch`). */
  dshPatch?: unknown[];
}

/**
 * What running `agentId` with the model `ref` ("service/model") takes.
 * @throws When the model is not in the list, has no key, or the agent cannot run it.
 */
export function modelLaunchFor(
  settings: ModelSettings,
  secrets: SecretStore,
  agentId: string,
  ref: string,
  env?: Record<string, string>,
): AgentLaunch {
  const { serviceId, model: id } = parseModelRef(ref);
  const service = settings.services.find((s) => s.id === serviceId);
  if (service === undefined || !service.models.includes(id)) {
    throw new Error(`model "${ref}" is not in the model list`);
  }
  const model = resolveModel(service, id);
  const key = serviceKey(service, secrets, env);
  if (key === undefined && service.kind === "builtin") {
    throw new Error(`no key for service "${service.id}"`);
  }
  const out = agentModelEnv(agentId, model, key);
  if (out === undefined) throw new Error(`agent "${agentId}" cannot run model "${ref}"`);
  return agentId === "dsh" ? { env: out, dshPatch: dshModelPatch(model) } : { env: out };
}
