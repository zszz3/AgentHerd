// The 验证 (check) button: start an agent's ACP server in an empty folder, open a session and close
// it. This proves the CLI starts, speaks ACP and is signed in, without sending a prompt.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentConnection, startAgent } from "@agentherd/acp-client";
import type { AgentProfile } from "@agentherd/protocol";
import type { AgentCheck } from "./api.ts";

export const VERIFY_TIMEOUT_MS = 60_000;

const AUTH_ERROR = /auth|login|log in|sign in|api key|unauthori[sz]ed|credential|401/i;

export interface VerifyOptions {
  timeoutMs?: number;
  start?: typeof startAgent;
}

/** Removes terminal colour codes so the GUI shows plain text. */
export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point.
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

export async function verifyProfile(
  profile: AgentProfile,
  opts: VerifyOptions = {},
): Promise<AgentCheck> {
  const started = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "agentherd-check-"));
  let connection: AgentConnection | undefined;
  let timer: NodeJS.Timeout | undefined;
  const abort = new AbortController();
  const result = (fields: Partial<AgentCheck>): AgentCheck => ({
    id: profile.id,
    ok: false,
    needsLogin: false,
    authMethods: connection?.authMethods.map((m) => m.name) ?? [],
    ...(connection === undefined ? {} : { agentName: connection.agentName }),
    ...(connection?.agentVersion === undefined ? {} : { agentVersion: connection.agentVersion }),
    ...fields,
    ms: Date.now() - started,
  });
  try {
    const timeoutMs = opts.timeoutMs ?? VERIFY_TIMEOUT_MS;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`));
        abort.abort();
      }, timeoutMs);
    });
    const starting = (opts.start ?? startAgent)(profile, { cwd: dir, signal: abort.signal });
    starting.catch(() => {});
    connection = await Promise.race([starting, timeout]);
    const sessionId = await Promise.race([connection.newSession(dir), timeout]);
    // A profile with a required permission mode (ZCode, ADR 0108) is only verified through the
    // same preparation a task uses: set the mode and wait for the session's own confirmation.
    // This is also where a missing backend or an unusable sign-in shows, because the bridge
    // starts the backend session on this call.
    if (profile.mode !== undefined) {
      await Promise.race([connection.prepareSession(sessionId, profile.mode), timeout]);
    }
    return result({ ok: true });
  } catch (error) {
    const message = (error as Error).message;
    const stderr = connection?.stderr().slice(-5).join("\n") ?? "";
    const detail = stderr === "" || message.includes(stderr) ? message : `${message}\n${stderr}`;
    const needsLogin =
      AUTH_ERROR.test(message) || (connection !== undefined && connection.authMethods.length > 0);
    return result({ needsLogin, error: stripAnsi(detail).slice(0, 2000) });
  } finally {
    clearTimeout(timer);
    await connection?.close().catch(() => {});
    // On Windows the folder stays busy until the agent's process tree has gone; a folder left
    // behind in the temp dir must not turn the check's answer into an error.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {}
  }
}
