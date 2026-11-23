// `agentherd` CLI: a development tool until the desktop app exists (plans/004).

import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { FeishuChannel } from "@agentherd/channel-feishu";
import { Herd, Store } from "@agentherd/core";
import {
  applySystemProxy,
  feishuSecrets,
  findAgent,
  LocationError,
  locationContext,
  RuntimeStore,
  readConfig,
  resolveProfile,
  runHost,
  secretFile,
  secretsPath,
  withLocation,
  writeConfig,
} from "@agentherd/host";
import type { Locale, Mode } from "@agentherd/protocol";
import QRCode from "qrcode";
import { MODEL_USAGE, modelCommand } from "./models.ts";

export const USAGE = `Usage: agentherd <command>

Commands:
  setup feishu                 Create a Feishu bot with one QR scan and bind it to you
  model <command>              Model services and the model of each role (agentherd model help)
  run [options] <dir> <prompt> Run one task with an agent; approvals go to Feishu
      --profile <id>           Agent: mock, pi, codex, claude, or one from config.json (default: mock)
      --script <yaml>          Script for the mock profile
      --mode <observe|assist>  Mode (default: from config, else assist)
  start [options]              Stay connected; start and relay to tasks from chat (/help)
      --script <yaml>          Also offer the mock profile with this script
      --mode <observe|assist>  Mode (default: from config, else assist)
  status                       Show recent sessions, open items and decisions

Environment:
  AGENTHERD_HOME               Default: the directory chosen in the app, else ~/.agentherd
  DEEPSEEK_API_KEY, ...        A provider's key, if none is saved in secrets.json
`;

type Out = (line: string) => void;

export async function main(argv: string[], out: Out = console.log): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "setup":
      if (rest[0] === "feishu") {
        return inLocation((home) => {
          applySystemProxy();
          return setupFeishu(home, out);
        });
      }
      out(USAGE);
      return 2;
    case "model":
      if (rest[0] === undefined || rest[0] === "help") {
        out(MODEL_USAGE);
        return rest[0] === undefined ? 2 : 0;
      }
      return inLocation((home) => {
        applySystemProxy();
        return modelCommand(home, rest, out, { secrets: secretFile(home), readKey });
      });
    case "run":
      return inLocation((home) => {
        applySystemProxy();
        return run(home, rest, out);
      });
    case "start":
      return inLocation((home) => {
        applySystemProxy();
        return start(home, rest, out);
      });
    case "status":
      return inLocation((home) => status(home, out));
    case undefined:
    case "help":
    case "--help":
    case "-h":
      out(USAGE);
      return command === undefined ? 2 : 0;
    default:
      out(`unknown command "${command}"\n`);
      out(USAGE);
      return 2;
  }
}

/**
 * Runs a command on the resolved data home under a shared lease, held until the command settles,
 * so a data location change never runs while it writes.
 */
async function inLocation(command: (home: string) => number | Promise<number>): Promise<number> {
  try {
    return await withLocation(locationContext(), ({ home }) => command(home));
  } catch (error) {
    if (!(error instanceof LocationError)) throw error;
    console.error(`agentherd: ${error.message} Open AgentHerd to recover.`);
    return 1;
  }
}

function feishuChannel(home: string, locale?: Locale): FeishuChannel {
  return new FeishuChannel({
    ...(locale === undefined ? {} : { locale }),
    ...feishuSecrets(home),
    onError: (error) => console.error(`[feishu] ${error.message}`),
  });
}

async function setupFeishu(home: string, out: Out): Promise<number> {
  const runDir = join(home, "run");
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const qrPng = join(runDir, "qr.png");
  // Every QR write settles before the lease is released, also when the setup fails.
  const qrWrites: Promise<void>[] = [];
  const setup = feishuChannel(home).setup({
    showQrCode(url, expiresInSeconds) {
      const qrWrite = QRCode.toFile(qrPng, url, { width: 360 }).catch((error: Error) => {
        out(`[setup] could not write ${qrPng}: ${error.message}`);
      });
      qrWrites.push(qrWrite);
      void QRCode.toString(url, { type: "terminal", small: true }).then((qr) => {
        out(qr);
        out(
          `Scan with Feishu, or open in Feishu (valid ${Math.round(expiresInSeconds / 60)} min):`,
        );
        out(url);
        out(`QR image: ${qrPng}`);
      });
    },
    showStatus(state) {
      out(`[setup] ${state}`);
    },
  });
  let binding: Awaited<typeof setup>;
  try {
    binding = await setup;
  } finally {
    await Promise.all(qrWrites);
  }
  const config = readConfig(home);
  writeConfig(home, { ...config, channel: binding });
  out(`Bound to Feishu app ${binding.data.appId}. The App Secret is in ${secretsPath(home)}.`);
  return 0;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function readKey(prompt: string): Promise<string> {
  if (process.stdin.isTTY) console.log(prompt);
  return readStdin();
}

async function run(home: string, args: string[], out: Out): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      profile: { type: "string", default: "mock" },
      script: { type: "string" },
      mode: { type: "string" },
    },
  });
  const [dirArg, ...promptWords] = positionals;
  if (dirArg === undefined || promptWords.length === 0) {
    out(USAGE);
    return 2;
  }
  const config = readConfig(home);
  if (config.channel === undefined) {
    out('No channel. Run "agentherd setup feishu" first.');
    return 1;
  }
  const mode = (values.mode ?? config.mode ?? "assist") as Mode;
  if (mode !== "observe" && mode !== "assist") {
    out(`--mode must be observe or assist in M1, not "${mode}"`);
    return 2;
  }
  const dir = resolve(dirArg);
  mkdirSync(dir, { recursive: true });
  if (!statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  const profile = resolveProfile(values.profile, {
    script: values.script === undefined ? undefined : resolve(values.script),
    configured: config.profiles ?? [],
    // The agents in AGENTHERD_AGENTS (the app's, ADR 0067), an older app's downloads, then the
    // user's own install.
    find: (id) =>
      (process.env.AGENTHERD_AGENTS
        ? new RuntimeStore(process.env.AGENTHERD_AGENTS).installed(id)?.path
        : undefined) ??
      new RuntimeStore(join(home, "runtimes")).installed(id)?.path ??
      findAgent(id),
  });

  const herd = new Herd({
    home,
    userHome: homedir(),
    channel: feishuChannel(home, config.locale),
    binding: config.channel,
    mode,
    ...(config.locale === undefined ? {} : { locale: config.locale }),
    profiles: [profile],
    // A one-off run may share herd.db with a running host; its running tasks are not stale.
    closeStaleTasks: false,
    taskCopies: false,
  });
  herd.registry.onChange((row, previous) => out(`[session] ${previous ?? "new"} → ${row.state}`));
  const stop = () => {
    void herd.stop().then(() => process.exit(130));
  };
  process.once("SIGINT", stop);
  if (process.platform === "win32") process.once("SIGBREAK", stop);
  try {
    await herd.start();
    out(`[herd] connected to Feishu; running ${profile.id} in ${dir}`);
    const result = await herd.run(profile.id, dir, promptWords.join(" "));
    out(`[turn] ${result.stopReason}`);
    return 0;
  } finally {
    process.off("SIGINT", stop);
    if (process.platform === "win32") process.off("SIGBREAK", stop);
    await herd.stop();
  }
}

async function start(home: string, args: string[], out: Out): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { script: { type: "string" }, mode: { type: "string" } },
  });
  const config = readConfig(home);
  if (config.channel === undefined) {
    out('No channel. Run "agentherd setup feishu" first (or bind in the desktop app).');
  }
  if (values.mode !== undefined && values.mode !== "observe" && values.mode !== "assist") {
    out(`--mode must be observe or assist, not "${values.mode}"`);
    return 2;
  }
  const running = await runHost({
    home,
    ...(values.script === undefined ? {} : { script: resolve(values.script) }),
    log: out,
  });
  if (values.mode !== undefined) running.host.updateSettings({ mode: values.mode as Mode });
  const status = running.host.status();
  out(
    status.herder.on
      ? `[herder] ${status.herder.ref}`
      : `[herder] off: ${status.herder.reason}. Only commands work.`,
  );
  if (status.profiles.length === 0) {
    out("[herd] no agent profiles: install Pi, add profiles, or pass --script.");
  }
  out("[herd] send /help to the bot. Ctrl-C to stop.");
  await new Promise<void>((done) => {
    const onSignal = () => {
      process.off("SIGINT", onSignal);
      if (process.platform === "win32") process.off("SIGBREAK", onSignal);
      done();
    };
    process.once("SIGINT", onSignal);
    if (process.platform === "win32") process.once("SIGBREAK", onSignal);
  });
  out("[herd] stopping");
  await running.stop();
  return 0;
}

function status(home: string, out: Out): number {
  const store = Store.open(join(home, "herd.db"));
  try {
    out("Sessions:");
    for (const s of store.recentSessions(10))
      out(`  ${s.updatedAt}  ${s.state.padEnd(16)} ${s.profileId}  ${s.cwd}`);
    out("Open items:");
    for (const i of store.openItems()) out(`  ${i.createdAt}  ${i.risk.padEnd(6)} ${i.title}`);
    out("Decisions:");
    for (const d of store.recentDecisions(10))
      out(`  ${d.createdAt}  ${d.source.padEnd(8)} ${d.action.padEnd(8)} ${d.reason}`);
    return 0;
  } finally {
    store.close();
  }
}
