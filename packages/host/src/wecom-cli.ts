import { type SpawnOptions, spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { wecomConfigFiles } from "./data-home-paths.ts";

interface WecomCliOptions {
  executable?: () => string;
  spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ReturnType<typeof spawn>;
  commandTimeoutMs?: number;
  loginTimeoutMs?: number;
  qrPollIntervalMs?: number;
  maxOutputBytes?: number;
  maxQrBytes?: number;
}

export class WecomDisconnectPendingError extends Error {
  constructor() {
    super("WeCom CLI local disconnect is incomplete.");
  }
}
const PNG_MAGIC = Buffer.from("89504e470d0a1a0a", "hex");
const PNG_END = Buffer.from("0000000049454e44ae426082", "hex");
const QR_FILENAME = "login.png";

// Use the native binary rather than the npm JS shim, so cancellation kills the CLI itself.
function nativeExecutable(): string {
  const require = createRequire(import.meta.url);
  const fromWrapper = createRequire(require.resolve("@wecom/cli/package.json"));
  const manifest = fromWrapper.resolve(
    `@wecom/cli-${process.platform}-${process.arch}/package.json`,
  );
  const file = join(
    dirname(manifest),
    "bin",
    process.platform === "win32" ? "wecom-cli.exe" : "wecom-cli",
  );
  // Electron's spawn cannot use an executable inside the ASAR virtual filesystem.
  return process.versions.electron
    ? file.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
    : file;
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function statIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (!missing(error)) throw error;
    return undefined;
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function checkCanceled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("WeCom CLI was canceled.");
}

async function cleanWorkspace(cwd: string): Promise<void> {
  try {
    await rm(cwd, { recursive: true, force: true });
  } catch {
    throw new Error("WeCom CLI could not clean its working directory.");
  }
}

async function readQr(path: string, maxBytes: number): Promise<string | undefined> {
  const info = await statIfPresent(path);
  if (!info) return undefined;
  if (!info.isFile()) throw new Error("WeCom CLI QR is not a regular file.");
  if (info.size > maxBytes) throw new Error("WeCom CLI QR is too large.");
  if (info.size < PNG_MAGIC.length + PNG_END.length) return undefined;

  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    // Hold even a growing file to the byte budget. The CLI creates it before writing its PNG.
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error("WeCom CLI QR is too large.");
    if (
      length < PNG_MAGIC.length + PNG_END.length ||
      !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC) ||
      !bytes.subarray(length - PNG_END.length, length).equals(PNG_END)
    )
      return undefined;
    return `data:image/png;base64,${bytes.toString("base64", 0, length)}`;
  } finally {
    await file.close();
  }
}

/** One host-owned WeCom CLI config, distinct from the owner's standalone CLI. */
export class WecomCli {
  private readonly configDir: string;
  private readonly options: WecomCliOptions;

  constructor(configDir: string, options: WecomCliOptions = {}) {
    this.configDir = resolve(configDir);
    this.options = options;
  }

  /** Only for argv built by the host catalog, not raw model-supplied CLI arguments. */
  async run(args: readonly string[], signal?: AbortSignal): Promise<unknown> {
    // The catalog must also exclude commands with implicit file reads/writes. The native
    // CLI can access its own OS temp root in addition to the disposable working directory.
    if (
      !args[0] ||
      args[0] === "auth" ||
      args.some((arg) => /^(--output(?:[=-]|$)|-o)/.test(arg))
    ) {
      throw new Error("WeCom CLI arguments are not allowed.");
    }
    const stdout = await this.withWorkspace(signal, (config, cwd) =>
      this.execute(args, config, cwd, {
        signal,
        timeoutMs: this.options.commandTimeoutMs ?? 30_000,
        maxOutputBytes: this.options.maxOutputBytes ?? 4 * 1024 * 1024,
      }),
    );
    try {
      return JSON.parse(stdout) as unknown;
    } catch {
      throw new Error("WeCom CLI returned invalid JSON.");
    }
  }

  async status(signal?: AbortSignal): Promise<boolean> {
    const stdout = await this.withWorkspace(signal, (config, cwd) =>
      this.execute(["auth", "show", "--status"], config, cwd, {
        signal,
        timeoutMs: this.options.commandTimeoutMs ?? 30_000,
        maxOutputBytes: 256,
      }),
    );
    if (stdout.trim() === "authorized") return true;
    if (stdout.trim() === "unauthorized") return false;
    throw new Error("WeCom CLI returned an invalid auth status.");
  }

  async login(onQr: (dataUrl: string) => void, signal: AbortSignal): Promise<void> {
    await this.withWorkspace(signal, async (config, cwd) => {
      const path = join(cwd, QR_FILENAME);
      const maxBytes = this.options.maxQrBytes ?? 1024 * 1024;
      const stop = new AbortController();
      const operation = AbortSignal.any([signal, stop.signal]);
      let qrFailure: Error | undefined;
      const publish = async (): Promise<boolean> => {
        try {
          const image = await readQr(path, maxBytes);
          if (image === undefined || signal.aborted) return false;
          onQr(image);
          return true;
        } catch (error) {
          qrFailure = new Error(
            error instanceof Error && error.message === "WeCom CLI QR is too large."
              ? error.message
              : "WeCom CLI could not deliver the QR.",
          );
          stop.abort();
          return false;
        }
      };
      const poll = (async () => {
        while (!operation.aborted) {
          if (await publish()) return true;
          await sleep(this.options.qrPollIntervalMs ?? 100, undefined, { signal: operation }).catch(
            () => {},
          );
        }
        return false;
      })();
      try {
        await this.execute(
          ["auth", "init", "--noninteractive", "--no-browser", "--output-qrcode", QR_FILENAME],
          config,
          cwd,
          {
            signal: operation,
            timeoutMs: this.options.loginTimeoutMs ?? 5 * 60_000,
          },
        );
      } catch (error) {
        stop.abort();
        await poll;
        throw qrFailure ?? error;
      }
      stop.abort();
      const published = await poll;
      checkCanceled(signal);
      if (qrFailure) throw qrFailure;
      if (!published && !(await publish())) {
        throw qrFailure ?? new Error("WeCom CLI did not produce a QR.");
      }
      checkCanceled(signal);
    });
  }

  async logout(): Promise<void> {
    const config = await this.ownedConfig(false);
    if (!config) return;
    // v1.3.4 has no logout command. Block restoration before touching credentials.
    const marker = join(config, wecomConfigFiles.disconnectPending);
    try {
      await writeFile(marker, "", { flag: "wx", mode: 0o600 }).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") return;
        throw error;
      });
      for (const name of wecomConfigFiles.credentials) {
        await unlink(join(config, name)).catch((error: unknown) => {
          if (!missing(error)) throw error;
        });
      }
      await unlink(marker);
    } catch {
      throw new Error("WeCom CLI could not clear its local credentials.");
    }
  }

  private async ownedConfig(create: boolean): Promise<string | undefined> {
    try {
      const external = join(homedir(), ".config", "wecom");
      if (samePath(this.configDir, external)) throw new Error();
      if (create) await mkdir(this.configDir, { recursive: true, mode: 0o700 });
      const info = await statIfPresent(this.configDir);
      if (!info && !create) return undefined;
      if (!info?.isDirectory()) throw new Error();
      const path = await realpath(this.configDir);
      if ((await statIfPresent(external)) && samePath(path, await realpath(external)))
        throw new Error();
      if (create) {
        if (await statIfPresent(join(path, wecomConfigFiles.disconnectPending)))
          throw new WecomDisconnectPendingError();
        for (const name of [...wecomConfigFiles.credentials, wecomConfigFiles.config]) {
          const file = await statIfPresent(join(path, name));
          if (file && !file.isFile()) throw new Error();
        }
      }
      return path;
    } catch (error) {
      if (error instanceof WecomDisconnectPendingError) throw error;
      throw new Error("WeCom CLI configuration directory is not safe.");
    }
  }

  private async withWorkspace<T>(
    signal: AbortSignal | undefined,
    run: (config: string, cwd: string) => Promise<T>,
  ): Promise<T> {
    checkCanceled(signal);
    const config = await this.ownedConfig(true);
    if (config === undefined) throw new Error("WeCom CLI configuration directory is not safe.");
    let cwd: string;
    try {
      cwd = await mkdtemp(join(tmpdir(), "agentherd-wecom-"));
    } catch {
      throw new Error("WeCom CLI could not create a private working directory.");
    }
    try {
      try {
        // The CLI walks up from cwd looking for .env. Stop it before outside overrides load.
        await writeFile(join(cwd, ".env"), "", { flag: "wx", mode: 0o600 });
      } catch {
        throw new Error("WeCom CLI could not prepare its working directory.");
      }
      return await run(config, cwd);
    } finally {
      await cleanWorkspace(cwd);
    }
  }

  private async execute(
    args: readonly string[],
    config: string,
    cwd: string,
    {
      signal,
      timeoutMs,
      maxOutputBytes,
    }: { signal?: AbortSignal; timeoutMs: number; maxOutputBytes?: number },
  ): Promise<string> {
    checkCanceled(signal);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^WECOM_CLI_/i.test(name)),
    );
    env.WECOM_CLI_CONFIG_DIR = config;
    const options: SpawnOptions = {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", maxOutputBytes === undefined ? "ignore" : "pipe", "ignore"],
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = (this.options.spawn ?? spawn)(
        (this.options.executable ?? nativeExecutable)(),
        args,
        options,
      );
    } catch {
      throw new Error("WeCom CLI could not start.");
    }
    return new Promise<string>((resolveOutput, reject) => {
      const chunks: Buffer[] = [];
      let length = 0;
      let failure: Error | undefined;
      const stop = (message: string) => {
        if (failure) return;
        failure = new Error(message);
        child.kill("SIGKILL");
      };
      const cancel = () => stop("WeCom CLI was canceled.");
      const timer = setTimeout(() => stop("WeCom CLI timed out."), timeoutMs);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      child.on("error", () => {
        failure ??= new Error("WeCom CLI could not start.");
      });
      child.stdout?.on("error", () => stop("WeCom CLI could not read stdout."));
      child.stdout?.on("data", (chunk: Buffer) => {
        if (failure) return;
        length += chunk.length;
        if (maxOutputBytes !== undefined && length > maxOutputBytes) {
          stop("WeCom CLI output is too large.");
        } else {
          chunks.push(chunk);
        }
      });
      // Wait for the native child and its stdout to close before cleaning up the workspace.
      child.once("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error("WeCom CLI command failed."));
        else resolveOutput(Buffer.concat(chunks, length).toString("utf8"));
      });
    });
  }
}
