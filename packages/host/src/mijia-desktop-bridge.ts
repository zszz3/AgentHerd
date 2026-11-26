import { redact } from "@agentherd/rules";
import type { ControlCheck, ControlOrigin, MijiaControl } from "./mijia-control.ts";
import type {
  ControlInventory,
  ControlOutcome,
  ControlProposal,
  ControlRequest,
  DeviceControls,
} from "./mijia-control-types.ts";
import { parseControlRequest } from "./mijia-schema.ts";

type Operation =
  | Pick<
      Extract<ControlRequest, { kind: "property" }>,
      "kind" | "homeId" | "deviceId" | "siid" | "piid"
    >
  | Pick<
      Extract<ControlRequest, { kind: "action" }>,
      "kind" | "homeId" | "deviceId" | "siid" | "aiid"
    >
  | Extract<ControlRequest, { kind: "scene" }>;
export type DesktopEligibility = (target: { request: Operation; model?: string }) => boolean;

export type DesktopControlOutcome =
  | Exclude<ControlOutcome, { state: "mismatch" }>
  | { state: "mismatch" };
export interface MijiaDesktopBridge {
  available(): Promise<boolean>;
  inventory(): Promise<ControlInventory>;
  capabilities(homeId: string, deviceId: string): Promise<DeviceControls>;
  prepare(input: ControlRequest): Promise<ControlProposal>;
  confirm(id: string): Promise<DesktopControlOutcome>;
  cancel(id: string): Promise<void>;
}

type Call =
  | [method: "inventory", args: []]
  | [method: "capabilities", args: [string, string]]
  | [method: "prepare", args: [ControlRequest]]
  | [method: "confirm" | "cancel", args: [string]];
export type DesktopControlCall = Call;
export type DesktopControlReply =
  | { type: "mijia-desktop:ready" }
  | { type: "mijia-desktop:authorize"; id: number; generation: number }
  | { type: "mijia-desktop:reply"; id: number; generation: number; ok: boolean; value?: unknown };
export interface DesktopParentPort {
  on(event: "message", listener: (message: { data: unknown }) => void): void;
  postMessage(message: DesktopControlReply): void;
}

const unavailable = () => new Error("Mi Home desktop control unavailable");
const targetId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
export function parseDesktopControlCall(method: unknown, args: unknown): Call | undefined {
  if (!Array.isArray(args)) return;
  switch (method) {
    case "inventory":
      if (args.length === 0) return [method, []];
      break;
    case "capabilities":
      if (args.length === 2 && targetId(args[0]) && targetId(args[1]))
        return [method, [args[0], args[1]]];
      break;
    case "prepare":
      if (args.length === 1) {
        try {
          return [method, [parseControlRequest(args[0])]];
        } catch {
          return;
        }
      }
      break;
    case "confirm":
    case "cancel":
      if (
        args.length === 1 &&
        typeof args[0] === "string" &&
        /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(args[0])
      ) {
        return [method, [args[0]]];
      }
  }
}

export function attachMijiaDesktopBridge(
  port: DesktopParentPort,
  control: MijiaControl,
  env: () => Record<string, string>,
  // Production has no independently vetted operation/scene list. Only isolated tests inject one.
  eligible?: DesktopEligibility,
): () => void {
  let stopped = false;
  let retired = 0;
  let active: { generation: number; origin: ControlOrigin } | undefined;
  let lastRequest = 0;
  const authorizations = new Map<
    number,
    {
      generation: number;
      settle(granted: boolean): void;
    }
  >();

  const retire = (generation: number) => {
    retired = Math.max(retired, generation);
    for (const pending of authorizations.values()) {
      if (pending.generation <= retired) pending.settle(false);
    }
    if (active && active.generation <= retired) {
      control.revoke(active.origin);
      active = undefined;
    }
  };
  const post = (message: DesktopControlReply) => {
    try {
      port.postMessage(message);
    } catch {
      stop();
    }
  };
  const stop = () => {
    stopped = true;
    if (active) retire(active.generation);
  };
  const authorize = (id: number, generation: number, origin: ControlOrigin): Promise<boolean> => {
    if (stopped || active?.origin !== origin) return Promise.resolve(false);
    return new Promise((resolve) => {
      const settle = (granted: boolean) => {
        authorizations.delete(id);
        clearTimeout(timer);
        resolve(granted);
      };
      // Bound the wait even if Main can no longer send a retirement notice.
      const timer = setTimeout(() => settle(false), 75_000).unref();
      authorizations.set(id, { generation, settle });
      post({ type: "mijia-desktop:authorize", id, generation });
    });
  };
  const check: ControlCheck = (command) => {
    if (eligible?.(command) !== true) throw unavailable();
    const { home, room, target, operation, arguments: args } = command.preview;
    const fields = [
      home,
      room,
      target,
      operation,
      ...args.flatMap(({ label, value, display }) => [label, value, display]),
    ];
    const inputs = env();
    if (
      fields.some((field) => field !== undefined && redact(String(field), inputs) !== String(field))
    )
      throw unavailable();
  };

  async function inventory(): Promise<ControlInventory> {
    if (!eligible) return { devices: [], scenes: [] };
    const data = await control.inventory();
    const inputs = env();
    const safeId = (s: string) => redact(s, inputs) === s;
    return {
      devices: data.devices
        .filter((d) => safeId(d.homeId) && safeId(d.deviceId))
        .map((d) => ({
          homeId: d.homeId,
          deviceId: d.deviceId,
          urn: "",
          home: redact(d.home, inputs),
          ...(d.room === undefined ? {} : { room: redact(d.room, inputs) }),
          name: redact(d.name, inputs),
          sharedOnly: d.sharedOnly,
        })),
      scenes: data.scenes
        .filter(
          (s) =>
            safeId(s.homeId) &&
            safeId(s.sceneId) &&
            eligible?.({
              request: { kind: "scene", homeId: s.homeId, sceneId: s.sceneId },
            }) === true,
        )
        .map((s) => ({
          homeId: s.homeId,
          sceneId: s.sceneId,
          home: redact(s.home, inputs),
          name: redact(s.name, inputs),
        })),
    };
  }
  async function capabilities(homeId: string, deviceId: string): Promise<DeviceControls> {
    if (!eligible) return { urn: "", services: [] };
    const descriptor = await control.capabilities(homeId, deviceId);
    const inputs = env();
    const text = (s: string) => redact(s, inputs);
    const clean = <T extends DeviceControls["services"][number]["properties"][number]>(
      property: T,
    ) => ({
      ...property,
      label: text(property.label),
      ...(property.choices === undefined
        ? {}
        : { choices: property.choices.map(({ value, label }) => ({ value, label: text(label) })) }),
    });
    const safe = (property: DeviceControls["services"][number]["properties"][number]) =>
      property.format !== "string" &&
      property.choices?.some(({ value }) => typeof value === "string") !== true;
    const services = descriptor.services.flatMap(({ siid, label, properties, actions }) => {
      const target = { homeId, deviceId, siid };
      const model = descriptor.urn;
      const ps = properties
        .filter(
          (p) =>
            p.writable &&
            safe(p) &&
            eligible({ model, request: { ...target, kind: "property", piid: p.piid } }) === true,
        )
        .map(clean);
      const as = actions
        .filter(
          (a) =>
            a.inputs.every(safe) &&
            eligible({ model, request: { ...target, kind: "action", aiid: a.aiid } }) === true,
        )
        .map(({ aiid, label, inputs }) => ({
          aiid,
          label: text(label),
          inputs: inputs.map(clean),
        }));
      return ps.length || as.length
        ? [{ siid, label: text(label), properties: ps, actions: as }]
        : [];
    });
    return { urn: "", services };
  }

  async function dispatch(
    origin: ControlOrigin,
    [method, args]: Call,
    requestAuthorization: () => Promise<boolean>,
  ): Promise<unknown> {
    switch (method) {
      case "inventory":
        return inventory();
      case "capabilities":
        return capabilities(...args);
      case "prepare":
        if (!eligible) throw unavailable();
        return control.prepare(origin, args[0], check);
      case "cancel":
        return control.cancel(origin, args[0]);
      case "confirm": {
        const result = await control.confirm(origin, args[0], check, requestAuthorization);
        return result.state === "mismatch" ? { state: "mismatch" } : result;
      }
    }
  }
  port.on("message", ({ data }) => {
    if (typeof data !== "object" || data === null) return;
    const { type, generation, id, method, args, granted } = data as Record<string, unknown>;
    if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation <= 0)
      return;
    if (type === "mijia-desktop:revoke") {
      retire(generation);
      return;
    }
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return;
    if (type === "mijia-desktop:authorization") {
      const pending = authorizations.get(id);
      if (
        !stopped &&
        active?.generation === generation &&
        pending?.generation === generation &&
        typeof granted === "boolean"
      ) {
        pending.settle(granted);
      }
      return;
    }
    // Main numbers requests monotonically for the life of its transport.
    if (type !== "mijia-desktop:request" || id <= lastRequest) return;
    lastRequest = id;
    const reply = { type: "mijia-desktop:reply", id, generation } as const;
    const call = parseDesktopControlCall(method, args);
    if (stopped || generation <= retired || (active && generation < active.generation) || !call) {
      post({ ...reply, ok: false });
      return;
    }
    if (active && generation > active.generation) retire(active.generation);
    active ??= { generation, origin: { kind: "desktop", key: {} } };
    const origin = active.origin;
    void dispatch(origin, call, () => authorize(id, generation, origin)).then(
      (value) =>
        post(
          !stopped && active?.origin === origin
            ? { ...reply, ok: true, value }
            : { ...reply, ok: false },
        ),
      () => post({ ...reply, ok: false }),
    );
  });
  post({ type: "mijia-desktop:ready" });
  return stop;
}
