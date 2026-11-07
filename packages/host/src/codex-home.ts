// A Codex home of AgentHerd's own for Codex runs with a model from the owner's list (ADR 0043).
// Newer Codex (0.166, shipped in the ChatGPT app) refuses a turn whose provider differs from the
// provider of the global config ("This chat uses agentherd, but your current provider is
// openai"), and codex-acp has no way to pass `-c model_provider=…` to `codex app-server`. So the
// run gets CODEX_HOME pointing at a directory whose config.toml names the same provider. The
// file holds no key: the provider reads it from AGENTHERD_CODEX_KEY.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The owner's Codex sign-in and settings are not used for these runs. */
export const CODEX_HOME_ENV = "CODEX_HOME";

interface CodexConfig {
  model_provider?: unknown;
  model_providers?: Record<string, Record<string, unknown>>;
}

const toml = (value: unknown): string => JSON.stringify(String(value));

/** config.toml naming the provider of `CODEX_CONFIG` as the current one. */
export function codexHomeToml(config: CodexConfig): string {
  const id = typeof config.model_provider === "string" ? config.model_provider : "";
  const provider = config.model_providers?.[id];
  if (id === "" || provider === undefined) throw new Error("CODEX_CONFIG names no provider");
  const lines = [`model_provider = ${toml(id)}`, "", `[model_providers.${id}]`];
  for (const [key, value] of Object.entries(provider)) lines.push(`${key} = ${toml(value)}`);
  return `${lines.join("\n")}\n`;
}

/**
 * `env` with CODEX_HOME set when it runs Codex with a custom provider (CODEX_CONFIG); the
 * directory is `<home>/run/codex-<sha16 of config.toml>`, made once and kept.
 */
export function withCodexHome(home: string, env: Record<string, string>): Record<string, string> {
  const raw = env.CODEX_CONFIG;
  if (raw === undefined) return env;
  const text = codexHomeToml(JSON.parse(raw) as CodexConfig);
  const id = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const dir = join(home, "run", `codex-${id}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "config.toml");
  if (!existsSync(file) || readFileSync(file, "utf8") !== text) {
    writeFileSync(file, text, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return { ...env, [CODEX_HOME_ENV]: dir };
}
