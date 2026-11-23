// Runs one host with the real Feishu channel and secrets.json, serving the local API.

import { FeishuChannel } from "@agentherd/channel-feishu";
import { feishuSecrets, secretFile } from "./config.ts";
import { Host } from "./host.ts";
import { mcpSocketPath, serveMcp } from "./mcp-socket.ts";
import { searchPath } from "./profiles.ts";
import { applySystemProxy } from "./proxy.ts";
import { type ApiServer, serveApi, socketPath } from "./server.ts";

export interface RunHostOptions {
  home: string;
  protectedPaths?: readonly string[] | undefined;
  script?: string;
  log?: (line: string) => void;
}

export interface RunningHost {
  host: Host;
  server: ApiServer;
  stop(): Promise<void>;
}

export async function runHost(opts: RunHostOptions): Promise<RunningHost> {
  const log = opts.log ?? ((line: string) => console.log(line));
  applySystemProxy(process.env);
  // An app opened from Finder gets a short PATH; find agents and let agents find `node` like a
  // terminal would.
  process.env.PATH = searchPath(process.env);
  const mcpSocket = mcpSocketPath(opts.home);
  const host = new Host({
    home: opts.home,
    protectedPaths: opts.protectedPaths,
    mcpSocket,
    ...(process.env.AGENTHERD_AGENTS ? { agentsDir: process.env.AGENTHERD_AGENTS } : {}),
    memoryJobs: true,
    secrets: secretFile(opts.home),
    createChannel: (locale) =>
      new FeishuChannel({
        locale,
        ...feishuSecrets(opts.home),
        onError: (error) => log(`[feishu] ${error.message}`),
      }),
    ...(opts.script === undefined ? {} : { script: opts.script }),
    log,
  });
  const server = await serveApi(host, socketPath(opts.home));
  log(`[host] API on ${server.path}`);
  // After serveApi: it refuses to start beside another host, which owns the MCP socket too.
  const mcp = await serveMcp(mcpSocket, (token, msg) => host.mcp(token, msg));
  log(`[host] agent MCP on ${mcp.path}`);
  await host.start();
  return {
    host,
    server,
    async stop() {
      await server.close();
      await mcp.close();
      await host.stop();
    },
  };
}
