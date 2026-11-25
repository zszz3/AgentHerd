import { randomUUID } from "node:crypto";
import type {
  ControlInventory,
  ControlOutcome,
  ControlProposal,
  ControlRequest,
  DeviceControls,
  ResolvedCommand,
} from "./mijia-control-types.ts";
import type { MijiaControlWorker } from "./mijia-control-worker.ts";
import {
  findControlDevice,
  parseControlRequest,
  parseMijiaSpec,
  resolveMijiaCommand,
} from "./mijia-schema.ts";

export type ControlOrigin = Readonly<{ kind: "desktop" | "task"; key: object }>;
export type MijiaControlSession = Readonly<{ session: object; worker: MijiaControlWorker }>;
export type ControlCheck = (command: Readonly<ResolvedCommand & { model?: string }>) => void;

type NotSent = Extract<ControlOutcome, { state: "not-sent" }>["reason"];
type Sent = Exclude<ControlOutcome, { state: "not-sent" }>;
type Operation = ControlRequest["kind"];
type AuditResult =
  | { decision: "not-sent"; outcome: NotSent }
  | { decision: "dispatched"; outcome: Sent["state"] };
type ControlAudit = Readonly<{ id: string; operation: Operation } & AuditResult>;

type Clock = { wall(): number; monotonic(): number };
type Options = {
  current(): MijiaControlSession | undefined;
  clock?: Clock;
  audit?(entry: ControlAudit): void;
};

type Reference = { id: string; origin: ControlOrigin; operation: Operation };
type Attempt = Reference & {
  scan: MijiaControlSession;
  request: ControlRequest;
  identity: string;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  expired?: true;
};
type CachedDescriptor = { value: DeviceControls; deadline: number };

const LIFETIME_MS = 5 * 60_000;
const MAX_PENDING = 256;
const MAX_DESCRIPTORS = 64;
const systemClock = { wall: () => Date.now(), monotonic: () => performance.now() };
const unavailable = () => new Error("Mi Home control unavailable");
const sameOrigin = (a: ControlOrigin, b: ControlOrigin) => a.kind === b.kind && a.key === b.key;
const notSent = (reason: NotSent): ControlOutcome => ({ state: "not-sent", reason });

/** Local proposals only. The caller supplies a trusted origin and any current dispatch policy. */
export class MijiaControl {
  private readonly clock: Clock;
  private readonly pending = new Map<string, Attempt>();
  // Keep only bounded correlation metadata so a late confirm can still report expiry.
  private readonly expired = new Map<string, Reference>();
  private readonly active = new WeakSet<object>();
  private readonly generations = {
    desktop: new WeakMap<object, object>(),
    task: new WeakMap<object, object>(),
  };
  private generation = {};
  private descriptors = new WeakMap<object, Map<string, CachedDescriptor>>();
  private stopped = false;
  private readonly options: Options;

  constructor(options: Options) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
  }

  async inventory(): Promise<ControlInventory> {
    try {
      const scan = this.scan();
      const inventory = await scan.worker.inventory();
      this.requireCurrent(scan);
      return structuredClone(inventory);
    } catch {
      throw unavailable();
    }
  }

  async capabilities(homeId: string, deviceId: string): Promise<DeviceControls> {
    try {
      const scan = this.scan();
      const inventory = await scan.worker.inventory();
      this.requireCurrent(scan);
      const { urn } = findControlDevice(inventory, homeId, deviceId);
      const descriptor = await this.descriptor(scan, urn, () => this.requireCurrent(scan));
      this.requireCurrent(scan);
      return structuredClone(descriptor);
    } catch {
      throw unavailable();
    }
  }

  async prepare(
    origin: ControlOrigin,
    input: unknown,
    beforePreview?: ControlCheck,
  ): Promise<ControlProposal> {
    const scan = this.scan();
    const owner = { ...origin };
    const generation = this.generation;
    const originGeneration = this.generations[owner.kind].get(owner.key);
    const check = () => {
      this.requireCurrent(scan);
      if (
        generation !== this.generation ||
        originGeneration !== this.generations[owner.kind].get(owner.key)
      )
        throw unavailable();
    };
    let request: ControlRequest;
    try {
      request = parseControlRequest(input);
    } catch {
      throw new Error("Invalid control request");
    }
    if (request.kind === "action") Object.freeze(request.inputs);
    Object.freeze(request);

    try {
      check();
      const resolved = await this.resolve(scan, request, check);
      check();
      beforePreview?.(resolved);
      check();
      const { identity, preview } = resolved;
      const now = this.clock.monotonic();
      for (const attempt of this.pending.values()) {
        if (attempt.deadline <= now) this.expire(attempt);
      }
      if (this.pending.size >= MAX_PENDING) throw unavailable();
      const id = randomUUID();
      const expiresAt = this.clock.wall() + LIFETIME_MS;
      const copy = structuredClone(preview);
      const timer = setTimeout(() => this.onExpiry(id), LIFETIME_MS).unref();
      this.pending.set(id, {
        id,
        origin: owner,
        scan,
        request,
        operation: request.kind,
        identity,
        deadline: now + LIFETIME_MS,
        timer,
      });
      return { id, expiresAt, preview: copy };
    } catch {
      throw unavailable();
    }
  }

  async confirm(
    origin: ControlOrigin,
    id: string,
    beforeDispatch?: ControlCheck,
    authorizeDesktop?: () => Promise<boolean>,
  ): Promise<ControlOutcome> {
    const attempt = this.pending.get(id);
    if (!attempt) {
      const expired = this.expired.get(id);
      if (!expired || !sameOrigin(origin, expired.origin)) return notSent("cancelled");
      this.expired.delete(id);
      return this.refuse(expired, "expired");
    }
    if (!sameOrigin(origin, attempt.origin)) return notSent("cancelled");
    const invalid = () => {
      if (this.pending.get(id) !== attempt) return attempt.expired ? "expired" : "cancelled";
      if (!this.isCurrent(attempt.scan)) return "stale";
      if (this.clock.monotonic() >= attempt.deadline) return "expired";
      return undefined;
    };
    const refuse = (reason: NotSent) => {
      if (this.pending.get(id) === attempt) {
        this.remove(attempt);
        return this.refuse(attempt, reason);
      }
      return this.expired.delete(id) ? this.refuse(attempt, reason) : notSent(reason);
    };
    const initial = invalid();
    if (initial !== undefined) return refuse(initial);
    const token = attempt.scan.session;
    if (this.active.has(token)) return this.refuse(attempt, "busy");
    this.active.add(token);
    try {
      let resolved: Awaited<ReturnType<MijiaControl["resolve"]>>;
      try {
        resolved = await this.resolve(
          attempt.scan,
          attempt.request,
          () => {
            if (invalid() !== undefined) throw unavailable();
          },
          true,
        );
      } catch {
        return refuse(invalid() ?? "stale");
      }
      const refreshed = invalid();
      if (refreshed !== undefined) return refuse(refreshed);
      if (resolved.identity !== attempt.identity) return refuse("stale");
      if (attempt.origin.kind === "task" && typeof beforeDispatch !== "function") {
        return refuse("blocked");
      }
      try {
        const result: unknown = beforeDispatch?.(resolved);
        if (result !== undefined) {
          // The policy contract is synchronous. Never send on a mistakenly async callback.
          void Promise.resolve(result).catch(() => {});
          return refuse(invalid() ?? "blocked");
        }
      } catch {
        return refuse(invalid() ?? "blocked");
      }
      if (attempt.origin.kind === "desktop" && authorizeDesktop) {
        try {
          if ((await authorizeDesktop()) !== true) return refuse(invalid() ?? "cancelled");
        } catch {
          return refuse(invalid() ?? "cancelled");
        }
        if (resolved.identity !== attempt.identity) return refuse("stale");
      }
      // No awaited work follows authorization before consuming the validated command.
      const final = invalid();
      if (final !== undefined) return refuse(final);

      this.remove(attempt);
      const outcome = await this.dispatch(attempt, resolved.readable);
      this.audit(attempt, { decision: "dispatched", outcome: outcome.state });
      return outcome;
    } finally {
      this.active.delete(token);
    }
  }

  cancel(origin: ControlOrigin, id: string): void {
    const attempt = this.pending.get(id);
    if (attempt && sameOrigin(origin, attempt.origin)) {
      this.remove(attempt);
      this.refuse(attempt, "cancelled");
    }
    const expired = this.expired.get(id);
    if (expired && sameOrigin(origin, expired.origin)) this.expired.delete(id);
  }

  revoke(origin?: ControlOrigin): void {
    if (origin === undefined) {
      this.generation = {};
      this.descriptors = new WeakMap();
    } else this.generations[origin.kind].set(origin.key, {});
    for (const [id, entry] of this.expired) {
      if (origin === undefined || sameOrigin(origin, entry.origin)) this.expired.delete(id);
    }
    const removed: Reference[] = [];
    for (const attempt of this.pending.values()) {
      if (origin === undefined || sameOrigin(origin, attempt.origin)) {
        this.remove(attempt);
        removed.push(attempt);
      }
    }
    for (const reference of removed) this.refuse(reference, "cancelled");
  }

  stop(): void {
    this.stopped = true;
    this.revoke();
  }

  private scan(): MijiaControlSession {
    const scan = this.stopped ? undefined : this.options.current();
    if (!scan) throw unavailable();
    return scan;
  }

  private isCurrent(scan: MijiaControlSession): boolean {
    return !this.stopped && this.options.current()?.session === scan.session;
  }

  private requireCurrent(scan: MijiaControlSession): void {
    if (!this.isCurrent(scan)) throw unavailable();
  }

  private async descriptor(
    scan: MijiaControlSession,
    urn: string,
    check: () => void,
    fresh = false,
  ) {
    const entry = this.descriptors.get(scan.session)?.get(urn);
    if (!fresh && entry && this.clock.monotonic() < entry.deadline) return entry.value;
    const raw = await scan.worker.descriptor(urn);
    check();
    const value = parseMijiaSpec(urn, raw);
    const cache = this.descriptors.get(scan.session) ?? new Map<string, CachedDescriptor>();
    cache.delete(urn);
    if (cache.size >= MAX_DESCRIPTORS) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(urn, { value, deadline: this.clock.monotonic() + LIFETIME_MS });
    this.descriptors.set(scan.session, cache);
    return value;
  }

  private async resolve(
    scan: MijiaControlSession,
    request: ControlRequest,
    check: () => void,
    fresh = false,
  ): Promise<ResolvedCommand & { readable: boolean; model?: string }> {
    const inventory = await scan.worker.inventory();
    check();
    const descriptors = new Map<string, DeviceControls>();
    let readable = false;
    let model: string | undefined;
    if (request.kind !== "scene") {
      const { urn } = findControlDevice(inventory, request.homeId, request.deviceId);
      model = urn;
      const descriptor = await this.descriptor(scan, urn, check, fresh);
      check();
      descriptors.set(urn, descriptor);
      if (request.kind === "property") {
        readable =
          descriptor.services
            .find(({ siid }) => siid === request.siid)
            ?.properties.find(({ piid }) => piid === request.piid)?.readable === true;
      }
    }
    return {
      ...resolveMijiaCommand(request, { inventory, descriptors }),
      readable,
      ...(model === undefined ? {} : { model }),
    };
  }

  private async dispatch({ scan, request }: Attempt, readable: boolean): Promise<Sent> {
    let receipt: Awaited<ReturnType<MijiaControlWorker["mutate"]>>;
    try {
      receipt = await scan.worker.mutate(request);
    } catch {
      return { state: "unknown" };
    }
    if (receipt === "rejected") return { state: "rejected" };
    if (receipt !== "acknowledged") return { state: "unknown" };
    if (request.kind === "property" && readable && this.isCurrent(scan)) {
      try {
        const actual = await scan.worker.readProperty(request);
        if (actual !== undefined && this.isCurrent(scan)) {
          return actual === request.value ? { state: "verified" } : { state: "mismatch", actual };
        }
      } catch {
        // Missing read-back does not change an acknowledged receipt.
      }
    }
    return { state: "acknowledged" };
  }

  private remove(attempt: Attempt): void {
    clearTimeout(attempt.timer);
    this.pending.delete(attempt.id);
  }

  private onExpiry(id: string): void {
    const attempt = this.pending.get(id);
    if (!attempt) return;
    const remaining = attempt.deadline - this.clock.monotonic();
    if (remaining <= 0) this.expire(attempt);
    else attempt.timer = setTimeout(() => this.onExpiry(id), Math.ceil(remaining)).unref();
  }

  private expire(attempt: Attempt): void {
    const { id, origin, operation } = attempt;
    attempt.expired = true;
    this.remove(attempt);
    if (this.expired.size >= MAX_PENDING) {
      const oldest = this.expired.keys().next().value;
      if (oldest !== undefined) this.expired.delete(oldest);
    }
    this.expired.set(id, { id, origin, operation });
  }

  private refuse(reference: Reference, reason: NotSent): ControlOutcome {
    this.audit(reference, { decision: "not-sent", outcome: reason });
    return notSent(reason);
  }

  private audit({ id, operation }: Reference, result: AuditResult): void {
    try {
      this.options.audit?.({ id, operation, ...result });
    } catch {
      // Logging cannot change a control outcome or enable a second dispatch.
    }
  }
}
