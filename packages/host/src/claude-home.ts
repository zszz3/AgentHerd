// A Claude Code config directory of AgentHerd's own (ADR 0066). claude-agent-acp starts a session
// in "auto" mode unless settings name another one, and auto lets a classifier approve edits and
// commands. The settings here make every edit and command ask, so the request reaches the owner
// through AgentHerd's approvals. The owner's own ~/.claude (sign-in, settings, plugins) is not
// used: the model and key come from the owner's model list, in env.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostDataPaths } from "./data-home-paths.ts";

export const CLAUDE_CONFIG_ENV = "CLAUDE_CONFIG_DIR";

/** settings.json: ask before every edit and command; no auto mode. */
export const CLAUDE_SETTINGS = `${JSON.stringify(
  {
    permissions: { defaultMode: "default", disableAutoMode: "disable" },
    disableAutoMode: "disable",
  },
  null,
  2,
)}\n`;

/** `env` with CLAUDE_CONFIG_DIR at `<home>/run/claude`, holding `CLAUDE_SETTINGS`. */
export function withClaudeHome(home: string, env: Record<string, string>): Record<string, string> {
  const dir = join(home, hostDataPaths.claude.relative);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(home, hostDataPaths.claudeSettings.relative);
  if (!existsSync(file) || readFileSync(file, "utf8") !== CLAUDE_SETTINGS) {
    writeFileSync(file, CLAUDE_SETTINGS, { mode: 0o600 });
  }
  return { ...env, [CLAUDE_CONFIG_ENV]: dir };
}
