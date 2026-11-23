// Antigravity's settings for AgentHerd's sessions (ADR 0104). AgentHerd starts the owner's own
// `agy acp` with `--cli_dir_name agentherd`, so Antigravity reads its CLI settings from
// ~/.gemini/antigravity-cli/agentherd/ instead of the owner's ~/.gemini/antigravity-cli/. The
// owner's own settings may say "always-proceed" (theirs did); the ones here make edits, commands,
// web and MCP tools ask, so each request reaches AgentHerd's approvals. The Google sign-in is
// shared: it does not live in these settings.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANTIGRAVITY_DIR_NAME } from "./catalog.ts";

/** settings.json: ask before writes, shell, web and MCP tools; no auto mode. */
export const ANTIGRAVITY_SETTINGS = `${JSON.stringify(
  { toolPermission: "request-review", agentMode: "" },
  null,
  2,
)}\n`;

/** The folder Antigravity reads AgentHerd's settings from, under the owner's home. */
export function antigravityDir(userHome: string): string {
  return join(userHome, ".gemini", "antigravity-cli", ANTIGRAVITY_DIR_NAME);
}

/** Writes `ANTIGRAVITY_SETTINGS` unless they are there already; returns the file. */
export function writeAntigravitySettings(userHome: string): string {
  const dir = antigravityDir(userHome);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "settings.json");
  if (!existsSync(file) || readFileSync(file, "utf8") !== ANTIGRAVITY_SETTINGS) {
    writeFileSync(file, ANTIGRAVITY_SETTINGS, { mode: 0o600 });
  }
  return file;
}
