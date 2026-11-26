import type { ControlInventory, ControlRequest, Scalar } from "./mijia-control-types.ts";

export interface MijiaControlWorker {
  inventory(): Promise<ControlInventory>;
  descriptor(urn: string): Promise<unknown>;
  mutate(request: ControlRequest): Promise<"acknowledged" | "rejected" | "unknown">;
  readProperty(request: Extract<ControlRequest, { kind: "property" }>): Promise<Scalar | undefined>;
}

type Tool =
  | "agentherd_inventory"
  | "agentherd_set_property"
  | "agentherd_run_action"
  | "agentherd_run_scene"
  | "agentherd_read_property";

type Row = Record<string, unknown>;
const unavailable = () => new Error("Mi Home control data unavailable");
const record = (value: unknown): Row | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : undefined;
const isId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(value);
const isScalar = (value: unknown): value is Scalar =>
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  (typeof value === "string" && value.length <= 160);
const label = (value: unknown) =>
  typeof value === "string"
    ? value
        .replace(/[\p{Cc}\p{Cf}\p{Cs}\s]+/gu, " ")
        .trim()
        .normalize("NFC")
        .slice(0, 160)
        .trimEnd()
    : "";

function inventory(raw: unknown): ControlInventory {
  const root = record(raw);
  if (!Array.isArray(root?.devices) || !Array.isArray(root.scenes)) throw unavailable();
  return {
    devices: root.devices.flatMap((item: unknown) => {
      const row = record(item);
      if (!row || !isId(row.homeId) || !isId(row.deviceId) || typeof row.sharedOnly !== "boolean")
        return [];
      const room = label(row.room);
      return [
        {
          homeId: row.homeId,
          deviceId: row.deviceId,
          urn: typeof row.urn === "string" && row.urn.length <= 256 ? row.urn : "",
          home: label(row.home),
          name: label(row.name),
          sharedOnly: row.sharedOnly,
          ...(room ? { room } : {}),
        },
      ];
    }),
    scenes: root.scenes.flatMap((item: unknown) => {
      const row = record(item);
      if (!row || !isId(row.homeId) || !isId(row.sceneId)) return [];
      return [
        { homeId: row.homeId, sceneId: row.sceneId, home: label(row.home), name: label(row.name) },
      ];
    }),
  };
}

const list = <T>(value: unknown, project: (value: unknown) => T) =>
  Array.isArray(value) ? value.map(project) : null;
const safeScalar = (value: unknown) => (isScalar(value) ? value : null);
const member = (row: Row) => ({ iid: safeScalar(row.iid), description: label(row.description) });

function descriptor(urn: string, raw: unknown): unknown {
  const root = record(raw);
  if (root?.type !== urn) throw unavailable();
  return {
    type: urn,
    services: list(root.services, (value) => {
      const row = record(value);
      if (!row) return null;
      return {
        ...member(row),
        properties: list(row.properties, (value) => {
          const property = record(value);
          if (!property) return null;
          return {
            ...member(property),
            format: safeScalar(property.format),
            access: list(property.access, safeScalar),
            ...("value-range" in property
              ? { "value-range": list(property["value-range"], safeScalar) }
              : {}),
            ...("value-list" in property
              ? {
                  "value-list": list(property["value-list"], (value) => {
                    const choice = record(value);
                    return choice
                      ? { value: safeScalar(choice.value), description: label(choice.description) }
                      : null;
                  }),
                }
              : {}),
            ...(Object.keys(property).some(
              (key) => key.startsWith("value-") && key !== "value-range" && key !== "value-list",
            )
              ? { "value-unsupported": null }
              : {}),
          };
        }),
        actions: list(row.actions, (value) => {
          const action = record(value);
          return action
            ? { ...member(action), ...("in" in action ? { in: list(action.in, safeScalar) } : {}) }
            : null;
        }),
      };
    }),
  };
}

export function bindMijiaControlWorker(
  call: (name: Tool, args: Record<string, unknown>) => Promise<unknown>,
  readDescriptor: (urn: string) => Promise<unknown>,
  current: () => boolean,
): MijiaControlWorker {
  async function request(name: Tool, args: Record<string, unknown>) {
    try {
      if (!current()) throw unavailable();
      const reply = record(await call(name, args));
      if (!current() || !reply || reply.isError === true) throw unavailable();
      const body = record(reply.structuredContent)?.result;
      if (typeof body !== "string") throw unavailable();
      const parsed: unknown = JSON.parse(body);
      return parsed;
    } catch {
      throw unavailable();
    }
  }

  return {
    async inventory() {
      return inventory(await request("agentherd_inventory", {}));
    },
    async descriptor(urn) {
      try {
        if (!current()) throw unavailable();
        const raw = await readDescriptor(urn);
        if (!current()) throw unavailable();
        return descriptor(urn, raw);
      } catch {
        throw unavailable();
      }
    },
    async mutate(command) {
      try {
        let result: unknown;
        switch (command.kind) {
          case "property":
            result = await request("agentherd_set_property", {
              did: command.deviceId,
              siid: command.siid,
              piid: command.piid,
              value: command.value,
            });
            break;
          case "action":
            result = await request("agentherd_run_action", {
              did: command.deviceId,
              siid: command.siid,
              aiid: command.aiid,
              inputs: command.inputs,
            });
            break;
          case "scene":
            result = await request("agentherd_run_scene", {
              home_id: command.homeId,
              scene_id: command.sceneId,
            });
            break;
        }
        return result === "acknowledged" || result === "rejected" ? result : "unknown";
      } catch {
        return "unknown";
      }
    },
    async readProperty(command) {
      try {
        const value = await request("agentherd_read_property", {
          did: command.deviceId,
          siid: command.siid,
          piid: command.piid,
        });
        return isScalar(value) ? value : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
