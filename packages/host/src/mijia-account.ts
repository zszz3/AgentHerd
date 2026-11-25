import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MijiaDevice, MijiaView } from "./api.ts";
import type { MijiaControlSession } from "./mijia-control.ts";
import { bindMijiaControlWorker, type MijiaControlWorker } from "./mijia-control-worker.ts";

export interface MijiaRuntime {
  open(
    authPath: string,
    onFailure: () => void,
  ): {
    call(name: string, args: Record<string, unknown>): Promise<unknown>;
    close(): Promise<void>;
  };
  picture(url: string): Promise<string>;
  descriptor(urn: string): Promise<unknown>;
}

type Session = {
  dir: string;
  worker: ReturnType<MijiaRuntime["open"]>;
  expiry: ReturnType<typeof setTimeout>;
  control: MijiaControlSession;
};

const SCAN_MS = 120_000;
const scanError: MijiaView = { state: "error", message: "米家登录失败或已过期，请重新扫码。" };
const cleanupError: MijiaView = { state: "cleanup-required" };
const disconnected: MijiaView = { state: "disconnected" };
const readError = () => new Error("无法读取米家设备。请检查连接，必要时断开后重新扫码。");

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function result(session: Session, name: string, args: Record<string, unknown> = {}) {
  const reply = record(await session.worker.call(name, args));
  if (reply === undefined || reply.isError === true) throw readError();
  const wrapped = record(reply.structuredContent)?.result;
  if (typeof wrapped === "string") return wrapped;
  const first = Array.isArray(reply.content) ? record(reply.content[0]) : undefined;
  if (first?.type !== "text" || typeof first.text !== "string") throw readError();
  return first.text;
}

function pictureUrl(reply: string): string {
  const link = /^二维码图片链接: (\S+)\r?$/m.exec(reply)?.[1];
  const url = new URL(link ?? "");
  if (
    url.origin !== "https://account.xiaomi.com" ||
    url.username ||
    url.password ||
    url.hash ||
    !url.pathname.startsWith("/pass/qr/")
  )
    throw readError();
  return url.href;
}

export const validMijiaDeviceId = (id: string) => /^[a-zA-Z0-9._:-]{1,128}$/.test(id);
const label = (value: unknown) => (typeof value === "string" ? value.slice(0, 160) : undefined);
export const MIJIA_PROPERTIES = [
  "on",
  "brightness",
  "color-temperature",
  "temperature",
  "relative-humidity",
  "battery-level",
] as const;
export type MijiaProperty = (typeof MIJIA_PROPERTIES)[number];

/** One owner scan and one local worker, never restored after a Host restart. */
export class MijiaAccount {
  private session?: Session;
  private cleaning?: Promise<MijiaView>;
  private pendingCleanup?: { dir: string; worker?: Session["worker"] };
  private starting?: Promise<MijiaView>;
  private polling?: Promise<MijiaView>;
  private state: MijiaView = disconnected;

  private readonly temp: string;
  private readonly runtime: MijiaRuntime | undefined;
  private readonly onControlInvalidated: (() => void) | undefined;

  constructor(temp: string = tmpdir(), runtime?: MijiaRuntime, onControlInvalidated?: () => void) {
    this.temp = temp;
    this.runtime = runtime;
    this.onControlInvalidated = onControlInvalidated;
  }

  view(): MijiaView {
    return this.runtime === undefined ? { state: "unavailable" } : this.state;
  }

  start(): Promise<MijiaView> {
    if (this.cleaning !== undefined) return this.cleaning;
    if (this.starting !== undefined) return this.starting;
    if (
      this.session !== undefined ||
      this.pendingCleanup !== undefined ||
      this.runtime === undefined
    )
      return Promise.resolve(this.view());
    this.starting = this.begin(this.runtime).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async begin(runtime: MijiaRuntime): Promise<MijiaView> {
    let dir: string | undefined;
    let session: Session | undefined;
    try {
      dir = mkdtempSync(join(this.temp, "agentherd-mijia-"));
      if (process.platform !== "win32") chmodSync(dir, 0o700);
      const worker = runtime.open(join(dir, "auth.json"), () => {
        if (session !== undefined && this.session === session) void this.reset(scanError);
      });
      const expire = () => {
        if (this.session === session) void this.reset(scanError);
      };
      const token = {};
      const control = bindMijiaControlWorker(
        (name, args) => worker.call(name, args),
        (urn) => runtime.descriptor(urn),
        () => this.session?.control.session === token && this.state.state === "connected",
      );
      session = {
        dir,
        worker,
        expiry: setTimeout(expire, SCAN_MS),
        control: { session: token, worker: control },
      };
      session.expiry.unref();
      this.session = session;
      const reply = await result(session, "login");
      if (this.session !== session) return this.view();
      const qrDataUrl = await runtime.picture(pictureUrl(reply));
      if (this.session === session) this.state = { state: "waiting", qrDataUrl };
      return this.view();
    } catch {
      if (session !== undefined)
        return this.session === session ? this.reset(scanError) : this.view();
      if (dir !== undefined) this.pendingCleanup = { dir };
      return this.reset(scanError);
    }
  }

  poll(): Promise<MijiaView> {
    if (this.polling !== undefined) return this.polling;
    const session = this.session;
    if (session === undefined || this.state.state !== "waiting")
      return Promise.resolve(this.view());
    this.polling = this.check(session).finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  private async check(session: Session): Promise<MijiaView> {
    try {
      const reply = await result(session, "login_status");
      if (this.session !== session) return this.view();
      if (reply.startsWith("等待扫码中")) return this.view();
      if (reply !== "登录成功，已切换为新凭证，可继续调用其他工具") throw readError();
      clearTimeout(session.expiry);
      this.state = { state: "connected" };
      return this.view();
    } catch {
      return this.session === session ? this.reset(scanError) : this.view();
    }
  }

  cancel(): Promise<MijiaView> {
    return this.state.state === "connected"
      ? Promise.resolve(this.view())
      : this.reset(disconnected);
  }

  disconnect(): Promise<MijiaView> {
    return this.reset(disconnected);
  }

  private reset(next: MijiaView): Promise<MijiaView> {
    if (this.cleaning !== undefined) return this.cleaning;
    const session = this.session;
    const connected = this.state.state === "connected";
    this.session = undefined;
    this.state = next;
    if (session !== undefined) {
      clearTimeout(session.expiry);
      this.pendingCleanup = { dir: session.dir, worker: session.worker };
      if (connected) this.onControlInvalidated?.();
    }
    const pending = this.pendingCleanup;
    if (pending === undefined) return Promise.resolve(this.view());
    this.cleaning = (async () => {
      try {
        await pending.worker?.close();
        delete pending.worker;
        rmSync(pending.dir, { force: true, recursive: true });
        this.pendingCleanup = undefined;
      } catch {
        this.state = cleanupError;
      }
      return this.view();
    })().finally(() => {
      this.cleaning = undefined;
    });
    return this.cleaning;
  }

  /** A private control port and opaque identity for this authenticated scan only. */
  controlSession(): MijiaControlSession | undefined {
    return this.state.state === "connected" ? this.session?.control : undefined;
  }

  controlWorker(): MijiaControlWorker | undefined {
    return this.controlSession()?.worker;
  }

  /** Captures the current scan session without exposing its worker or credential path. */
  guardRead(): () => void {
    const session = this.session;
    if (session === undefined || this.state.state !== "connected") throw readError();
    return () => {
      if (this.session !== session) throw readError();
    };
  }

  private async read(name: string, args: Record<string, unknown>) {
    const session = this.session;
    if (session === undefined || this.state.state !== "connected") throw readError();
    try {
      const reply: unknown = JSON.parse(await result(session, name, args));
      if (this.session !== session) throw readError();
      return reply;
    } catch {
      throw readError();
    }
  }

  async devices(): Promise<MijiaDevice[]> {
    const items = await this.read("list_devices", {});
    if (!Array.isArray(items)) throw readError();
    return items.slice(0, 500).flatMap((item: unknown) => {
      const row = record(item);
      const id = row?.did;
      const name = label(row?.name);
      if (typeof id !== "string" || !validMijiaDeviceId(id) || !name) return [];
      const home = label(row?.home);
      const room = label(row?.room);
      const online = row?.isOnline;
      return [
        {
          id,
          name,
          ...(home === undefined ? {} : { home }),
          ...(room === undefined ? {} : { room }),
          ...(typeof online === "boolean" ? { online } : {}),
        },
      ];
    });
  }

  async properties(id: string, properties: MijiaProperty[]) {
    if (!validMijiaDeviceId(id)) throw readError();
    const reply = record(
      await this.read("get_device_properties", { did: id, prop_names: properties }),
    );
    if (reply === undefined) throw readError();
    const values: Record<string, boolean | number> = {};
    const unavailable: string[] = [];
    for (const name of properties) {
      const value = reply[name];
      if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
        values[name] = value;
      else unavailable.push(name);
    }
    return { values, unavailable };
  }
}
