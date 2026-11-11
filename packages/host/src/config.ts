// Host configuration: `<home>/config.json` (no secrets) and `<home>/secrets.json` (App Secret and
// model keys). Both are mode 600 inside a mode 700 directory.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelSettings, SecretStore } from "@agentherd/core";
import type { ModelTiers } from "@agentherd/herder";
import type { AgentProfile, ChannelBinding, HerderStyle, Locale, Mode } from "@agentherd/protocol";

export interface CliConfig {
  channel?: ChannelBinding;
  mode?: Mode;
  /** Language of channel texts: "zh-CN" (default) or "en". */
  locale?: Locale;
  /** Agent profiles in addition to the built-in `mock` profile. */
  profiles?: AgentProfile[];
  /** Model services and the model of each role (ADR 0021). Keys are in secrets.json. */
  models?: ModelSettings;
  /** Keep the Mac awake while tasks run (desktop app). */
  keepAwake?: boolean;
  /** How the Herder talks to the owner (ADR 0053); missing means the default style. */
  herderStyle?: HerderStyle;
  /** Where the owner dragged models to (ADR 0028); models not here are placed by name. */
  modelTiers?: Partial<ModelTiers>;
  /** Connected apps (docs/spec/09-agent-tools.md §3). The Composio key is in secrets.json. */
  apps?: { composioUserId?: string };
  /** 小红书 and 知乎 (ADR 0058). Sign-ins are in ~/.agentherd/<platform>/, not here. */
  socials?: Partial<Record<"xiaohongshu" | "zhihu", import("./socials.ts").SocialConfig>>;
  /** News sources turned off in 应用连接 (ADR 0059); all are on unless listed. */
  feedsOff?: ("github-trending" | "hacker-news" | "arxiv")[];
  /** The owner's Obsidian vault, told to every new task (ADR 0059). */
  obsidianVault?: string;
}

export function agentherdHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTHERD_HOME ?? join(homedir(), ".agentherd");
}

export function configPath(home: string): string {
  return join(home, "config.json");
}

export function readConfig(home: string): CliConfig {
  const path = configPath(home);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as CliConfig;
}

export function writeConfig(home: string, config: CliConfig): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = configPath(home);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function secretsPath(home: string): string {
  return join(home, "secrets.json");
}

function readSecrets(home: string): Record<string, string> {
  const path = secretsPath(home);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
}

function writeSecrets(home: string, secrets: Record<string, string>): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = secretsPath(home);
  writeFileSync(path, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Secrets in `<home>/secrets.json`, readable only by the user (mode 600). Accounts are
 * `feishu:<appId>`, `model:<serviceId>` and `composio` (the owner's Composio API key).
 */
export function secretFile(home: string): SecretStore {
  return {
    get(account) {
      const value = readSecrets(home)[account];
      return value === "" ? undefined : value;
    },
    set(account, value) {
      writeSecrets(home, { ...readSecrets(home), [account]: value });
    },
    delete(account) {
      const secrets = readSecrets(home);
      if (!(account in secrets)) return;
      delete secrets[account];
      writeSecrets(home, secrets);
    },
  };
}

/** The Feishu App Secret functions a FeishuChannel needs, backed by `secretFile(home)`. */
export function feishuSecrets(home: string): {
  getSecret(appId: string): Promise<string>;
  saveSecret(appId: string, secret: string): Promise<void>;
} {
  const store = secretFile(home);
  return {
    async getSecret(appId) {
      const secret = store.get(`feishu:${appId}`);
      if (secret === undefined) {
        throw new Error(`no App Secret for ${appId}; run "agentherd setup feishu"`);
      }
      return secret;
    },
    async saveSecret(appId, secret) {
      store.set(`feishu:${appId}`, secret);
    },
  };
}
