// Agent CLIs the host downloads for the owner, like OpenBot's provider runtimes. A release is
// either an archive (checked against the digest its publisher lists) or an npm package (npm checks
// every tarball against the registry's integrity). It is unpacked beside its final folder, checked
// (`--version` or package.json), then moved to <root>/<id>/<version>/ and recorded as current.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, win32 } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Digest {
  algorithm: "sha256" | "sha512";
  encoding: "hex" | "base64";
  value: string;
}

/** How a downloaded executable proves it is the version that was asked for. */
export type VersionCheck = "exec" | "node" | "none";

export interface ArchiveRelease {
  kind: "archive";
  id: string;
  version: string;
  url: string;
  digest: Digest;
  bytes: number;
  format: "tar.gz" | "zip";
  /** Path of the executable inside the unpacked archive. */
  executable: string;
  /** exec: `<exe> --version`; node: `node <exe> --version`; none: no check. */
  check: VersionCheck;
}

export interface NpmRelease {
  kind: "npm";
  id: string;
  version: string;
  package: string;
  /** Path of the entry script inside the install folder (node_modules/…). */
  executable: string;
  /** Leave out optional dependencies (an agent's platform build the machine already has). */
  omitOptional?: boolean;
}

export type Release = ArchiveRelease | NpmRelease;

export function currentTarget(): string {
  return `${process.platform}-${process.arch}`;
}

export interface InstallProgress {
  received: number;
  /** 0 when the size is not known (npm installs). */
  total: number;
}

export interface Installed {
  id: string;
  version: string;
  /** Absolute path of the executable. */
  path: string;
}

export interface InstallOptions {
  onProgress?: (p: InstallProgress) => void;
  signal?: AbortSignal;
  /** npm's CLI script, for npm releases. */
  npmCli?: string;
}

/** File written last in a version folder, after the checks passed. */
const READY_MARK = ".agentherd-ready";
/** <root>/<id>/current.json names the version in use. */
const CURRENT = "current.json";
const CHECK_TIMEOUT_MS = 60_000;
const NPM_TIMEOUT_MS = 15 * 60_000;

/**
 * Env that makes `process.execPath` run a script. Inside Electron's utility process, execPath is
 * the Electron binary, which runs as Node only with ELECTRON_RUN_AS_NODE.
 */
export function nodeEnv(): Record<string, string> {
  return process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" };
}

/** Downloaded agent CLIs under `<root>/<id>/<version>/`. */
/** Executables of downloads made before current.json existed. */
const LEGACY_EXECUTABLES: Record<string, string> = { pi: "pi/pi" };

export class RuntimeStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  dir(id: string, version: string): string {
    return join(this.root, id, version);
  }

  /** The checked copy in use, or undefined. */
  installed(id: string): Installed | undefined {
    const file = join(this.root, id, CURRENT);
    if (!existsSync(file)) return this.legacy(id);
    try {
      const { version, executable } = JSON.parse(readFileSync(file, "utf8")) as {
        version: string;
        executable: string;
      };
      const dir = this.dir(id, version);
      const path = join(dir, executable);
      if (!existsSync(join(dir, READY_MARK)) || !existsSync(path)) return undefined;
      return { id, version, path };
    } catch {
      return undefined;
    }
  }

  /** A copy from before current.json (plan 013 put Pi in <root>/pi/<version>/pi/pi). */
  private legacy(id: string): Installed | undefined {
    const executable = LEGACY_EXECUTABLES[id];
    const base = join(this.root, id);
    if (executable === undefined || !existsSync(base)) return undefined;
    const versions = readdirSync(base).filter((v) => existsSync(join(base, v, READY_MARK)));
    const version = versions.sort().at(-1);
    if (version === undefined || !existsSync(join(base, version, executable))) return undefined;
    return { id, version, path: join(base, version, executable) };
  }

  /**
   * Downloads and checks a release, makes it current and removes older versions.
   * @returns The installed copy.
   * @throws When the download fails, a digest or version does not match, or it was cancelled.
   */
  async install(release: Release, opts: InstallOptions = {}): Promise<Installed> {
    const current = this.installed(release.id);
    if (current?.version === release.version) return current;
    const parent = join(this.root, release.id);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const staging = join(parent, `.installing-${randomUUID()}`);
    mkdirSync(staging);
    try {
      if (release.kind === "archive") await unpackArchive(release, staging, opts);
      else await npmInstall(release, staging, opts);
      writeFileSync(join(staging, READY_MARK), `${release.version}\n`);
      const dir = this.dir(release.id, release.version);
      rmSync(dir, { recursive: true, force: true });
      renameSync(staging, dir);
      writeFileSync(
        join(parent, CURRENT),
        `${JSON.stringify({ version: release.version, executable: release.executable })}\n`,
      );
      for (const name of readdirSync(parent)) {
        if (name !== release.version && name !== CURRENT) {
          rmSync(join(parent, name), { recursive: true, force: true });
        }
      }
      return { id: release.id, version: release.version, path: join(dir, release.executable) };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  /** Removes every downloaded version. */
  remove(id: string): void {
    rmSync(join(this.root, id), { recursive: true, force: true });
  }
}

/** Windows' own tar.exe (bsdtar). */
export function windowsTar(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32", "tar.exe");
}

async function unpackArchive(
  release: ArchiveRelease,
  staging: string,
  opts: InstallOptions,
): Promise<void> {
  const archive = `${staging}.${release.format}`;
  try {
    await download(release, archive, opts.onProgress ?? (() => {}), opts.signal);
    if (process.platform === "win32") {
      // Windows 10+ ships bsdtar, which also reads zip; there is no unzip. Name it by path: a
      // GNU tar from Git for Windows earlier on PATH reads "C:\..." as a remote host.
      await run(windowsTar(), ["-xf", archive, "-C", staging]);
    } else if (release.format === "tar.gz") {
      await run("tar", ["-xzf", archive, "-C", staging]);
    } else if (process.platform === "darwin") {
      // ditto keeps symlinks and code signatures inside .app bundles.
      await run("ditto", ["-x", "-k", archive, staging]);
    } else {
      await run("unzip", ["-q", archive, "-d", staging]);
    }
  } finally {
    rmSync(archive, { force: true });
  }
  const bin = join(staging, release.executable);
  if (!existsSync(bin)) throw new Error(`${release.id} archive has no ${release.executable}`);
  if (release.check === "none") return;
  const [command, args, env] =
    release.check === "node"
      ? [process.execPath, [bin, "--version"], nodeEnv()]
      : [bin, ["--version"], {}];
  const { stdout } = await run(command, args, {
    timeout: CHECK_TIMEOUT_MS,
    env: { ...process.env, ...env },
  }).catch((error: Error & { signal?: string }) => {
    throw new Error(`${release.id} did not start (${describeFailure(error)})`);
  });
  if (!stdout.includes(release.version)) {
    throw new Error(
      `${release.id} reports version "${stdout.trim()}", expected ${release.version}`,
    );
  }
}

async function npmInstall(release: NpmRelease, staging: string, opts: InstallOptions) {
  if (opts.npmCli === undefined) throw new Error("npm is not available to install packages");
  opts.onProgress?.({ received: 0, total: 0 });
  const args = [
    opts.npmCli,
    "install",
    "--prefix",
    staging,
    "--ignore-scripts",
    "--omit=dev",
    ...(release.omitOptional === true ? ["--omit=optional"] : []),
    "--no-audit",
    "--no-fund",
    "--no-save",
    "--loglevel=error",
    `${release.package}@${release.version}`,
  ];
  await run(process.execPath, args, {
    timeout: NPM_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...nodeEnv() },
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  }).catch((error: Error & { stderr?: string }) => {
    if (opts.signal?.aborted) throw new Error("cancelled");
    const detail = (error.stderr ?? "").trim().split("\n").slice(-3).join(" ");
    throw new Error(`npm could not install ${release.package}: ${detail || error.message}`);
  });
  const manifest = join(staging, "node_modules", release.package, "package.json");
  const version = existsSync(manifest)
    ? (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version
    : undefined;
  if (version !== release.version) {
    throw new Error(`${release.package} installed as "${version}", expected ${release.version}`);
  }
  if (!existsSync(join(staging, release.executable))) {
    throw new Error(`${release.package} has no ${release.executable}`);
  }
}

/** Short reason a process failed: a signal (e.g. killed by security software) or its exit code. */
export function describeFailure(error: Error & { signal?: string | null; code?: unknown }) {
  if (error.signal) return `killed by ${error.signal}`;
  if (typeof error.code === "number") return `exit code ${error.code}`;
  return error.message;
}

async function download(
  release: ArchiveRelease,
  path: string,
  onProgress: (p: InstallProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(release.url, signal === undefined ? {} : { signal });
  if (!response.ok || response.body === null) {
    throw new Error(`download failed: HTTP ${response.status} for ${release.url}`);
  }
  const total = Number(response.headers.get("content-length")) || release.bytes;
  const hash = createHash(release.digest.algorithm);
  let received = 0;
  let last = 0;
  const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  body.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    received += chunk.length;
    const now = Date.now();
    if (now - last > 200 || received === total) {
      last = now;
      onProgress({ received, total });
    }
  });
  await pipeline(body, createWriteStream(path, { mode: 0o600 }));
  onProgress({ received, total });
  const actual = hash.digest(release.digest.encoding);
  if (actual !== release.digest.value) {
    throw new Error(
      `download of ${release.url} does not match its ${release.digest.algorithm.toUpperCase()} (got ${actual})`,
    );
  }
}
