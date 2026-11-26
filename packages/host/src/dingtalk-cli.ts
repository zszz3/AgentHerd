import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

// The DingTalk Workspace CLI keeps its sign-in under these names inside its state directory.
// Kept here, with only Node built-ins imported, so `scripts/dws-windows-write-smoke.mjs` runs
// this module on a runner without `pnpm install`.
export const dingTalkStateFiles = {
  config: "config",
  credentials: "credentials",
  resetPending: "reset-pending",
} as const;

export type DingTalkIdentity = Readonly<{
  corpId: string;
  userId: string;
  corpName?: string;
  userName?: string;
}>;
export type DingTalkCommand = Readonly<{ args: readonly string[]; stdin?: string }>;

export interface DingTalkCliPort {
  status(signal: AbortSignal): Promise<DingTalkIdentity | undefined>;
  login(signal: AbortSignal): Promise<void>;
  markResetPending(): Promise<void>;
  reset(signal: AbortSignal): Promise<void>;
  run(
    identity: DingTalkIdentity,
    command: DingTalkCommand,
    signal: AbortSignal,
    beforeDispatch?: () => void,
  ): Promise<unknown>;
}

interface Options {
  executable: string;
  stateDir: string;
}

const MAX_OUTPUT = 2 * 1024 * 1024;
const PLATFORM_ENV = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "SYSTEMDRIVE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
]);

const messages = {
  unavailable: "钉钉组件不可用。",
  failed: "钉钉操作失败；请检查组织是否允许 CLI 及对应业务权限。若是写操作，请先确认结果再重试。",
  cancelled: "钉钉操作已取消或超时；若是写操作，请先确认结果再重试。",
  output_limit: "钉钉返回的数据过大，请缩小查询范围。",
  invalid_response: "无法验证钉钉返回的结果。",
  reset_pending: "本地钉钉授权尚未清除。",
  login_storage_denied:
    "钉钉无法写入本地授权目录，浏览器未打开。请检查系统是否允许钉钉组件写入 AgentHerd 数据目录，再点连接。",
};

export class DingTalkCliError extends Error {
  readonly code: keyof typeof messages;

  constructor(code: keyof typeof messages) {
    super(messages[code]);
    this.code = code;
  }
}

function isLoginStorageDenied(stderr: Buffer[]): boolean {
  try {
    const error = JSON.parse(Buffer.concat(stderr).toString("utf8")).error;
    return (
      error?.category === "auth" &&
      error.code === 2 &&
      typeof error.message === "string" &&
      /^dingtalk login failed: 本地登录态无法安全更新: acquiring file lock: (?:creating config dir for lock|opening lock file): .*?(?:Access is denied\.|拒绝访问。?|Permission denied\.?)$/i.test(
        error.message,
      )
    );
  } catch {
    return false;
  }
}

export async function runDws(
  { executable, stateDir }: Options,
  command: DingTalkCommand,
  signal: AbortSignal,
  json: boolean,
  beforeDispatch?: () => void,
  diagnostic?: "login",
): Promise<unknown> {
  if (!isAbsolute(executable) || !isAbsolute(stateDir)) throw new DingTalkCliError("unavailable");
  if (signal.aborted) throw new DingTalkCliError("cancelled");
  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
  } catch {
    throw new DingTalkCliError("unavailable");
  }
  if (signal.aborted) throw new DingTalkCliError("cancelled");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => PLATFORM_ENV.has(key.toUpperCase())),
  );
  env.DWS_CONFIG_DIR = join(stateDir, dingTalkStateFiles.config);
  env.DWS_KEYCHAIN_DIR = join(stateDir, dingTalkStateFiles.credentials);

  beforeDispatch?.();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...command.args], {
      cwd: stateDir,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", json ? "pipe" : "ignore", diagnostic === "login" ? "pipe" : "ignore"],
    });
    const chunks: Buffer[] = [];
    const stderr: Buffer[] = [];
    let remaining = 8192;
    child.stderr?.on("data", (chunk: Buffer) => {
      const part = chunk.subarray(0, remaining);
      if (part.length === 0) return;
      stderr.push(part);
      remaining -= part.length;
    });
    let size = 0;
    let error: DingTalkCliError | undefined;
    const fail = (code: keyof typeof messages) => {
      if (error !== undefined) return;
      error = new DingTalkCliError(code);
      child.kill();
    };
    const abort = () => fail("cancelled");
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", () => fail("unavailable"));
    child.stdout?.on("data", (chunk: Buffer) => {
      if (error !== undefined) return;
      size += chunk.length;
      if (size > MAX_OUTPUT) fail("output_limit");
      else chunks.push(chunk);
    });
    child.stdout?.on("error", () => fail("failed"));
    child.stdin?.on("error", () => fail("failed"));
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (error !== undefined || code !== 0) {
        const storageDenied = diagnostic === "login" && code === 2 && isLoginStorageDenied(stderr);
        reject(error ?? new DingTalkCliError(storageDenied ? "login_storage_denied" : "failed"));
      } else if (!json) {
        resolve(undefined);
      } else {
        try {
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
          resolve(JSON.parse(decoded));
        } catch {
          reject(new DingTalkCliError("invalid_response"));
        }
      }
    });
    if (signal.aborted) abort();
    child.stdin?.end(command.stdin);
  });
}

const profileId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_@.+/=-]{1,128}$/.test(value);

function label(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const safe = value
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim()
    .slice(0, 100);
  return safe === "" ? undefined : safe;
}

function identityFromStatus(value: unknown): DingTalkIdentity | undefined {
  if (typeof value === "object" && value !== null && "success" in value && value.success === true) {
    const { authenticated, reason, corp_id, user_id, corp_name, user_name } = value as Record<
      string,
      unknown
    >;
    if (authenticated === false && reason === undefined) return undefined;
    if (authenticated === true && profileId(corp_id) && profileId(user_id)) {
      const corpName = label(corp_name);
      const userName = label(user_name);
      return Object.freeze({
        corpId: corp_id,
        userId: user_id,
        ...(corpName === undefined ? {} : { corpName }),
        ...(userName === undefined ? {} : { userName }),
      });
    }
  }
  throw new DingTalkCliError("invalid_response");
}

export function dingtalkCli(options: Options): DingTalkCliPort {
  const execute = (
    command: DingTalkCommand,
    signal: AbortSignal,
    json: boolean,
    ms = 30_000,
    beforeDispatch?: () => void,
  ) =>
    runDws(
      options,
      command,
      AbortSignal.any([signal, AbortSignal.timeout(ms)]),
      json,
      beforeDispatch,
    );
  const resetMarker = join(options.stateDir, dingTalkStateFiles.resetPending);
  const markResetPending = async () => {
    if (!isAbsolute(options.stateDir)) throw new DingTalkCliError("unavailable");
    await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
    await writeFile(resetMarker, "", { mode: 0o600, flush: true });
  };
  return {
    markResetPending,
    status: async (signal) => {
      try {
        await stat(resetMarker);
        throw new DingTalkCliError("reset_pending");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return identityFromStatus(
        await execute({ args: ["auth", "status", "--readonly", "--format=json"] }, signal, true),
      );
    },
    login: async (signal) => {
      await runDws(
        options,
        { args: ["auth", "login", "--format=json"] },
        AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
        false,
        undefined,
        "login",
      );
    },
    reset: async (signal) => {
      await execute({ args: ["auth", "reset"] }, signal, false);
      await rm(resetMarker, { force: true });
    },
    run: (identity, command, signal, beforeDispatch) => {
      if (!profileId(identity.corpId) || !profileId(identity.userId)) {
        throw new DingTalkCliError("invalid_response");
      }
      const profile = `${identity.corpId}:${identity.userId}`;
      return execute(
        { ...command, args: [...command.args, `--profile=${profile}`, "--format=json"] },
        signal,
        true,
        30_000,
        beforeDispatch,
      );
    },
  };
}
