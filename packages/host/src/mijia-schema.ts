import type {
  ActionControl,
  ControlInventory,
  ControlPreview,
  ControlRequest,
  ControlSnapshot,
  DeviceControls,
  NumericFormat,
  PropertyControl,
  ResolvedCommand,
  Scalar,
  ServiceControls,
} from "./mijia-control-types.ts";

type Row = Record<string, unknown>;
type Range = NonNullable<PropertyControl["range"]>;
type Choices = NonNullable<PropertyControl["choices"]>;

const FLOAT_MAX = 3.4028234663852886e38;
const numericBounds: Record<NumericFormat, readonly [number, number]> = {
  int8: [-128, 127],
  uint8: [0, 255],
  int16: [-32768, 32767],
  uint16: [0, 65535],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
  float: [-FLOAT_MAX, FLOAT_MAX],
};
const LABEL_LIMIT = 160;
const DECIMAL_PLACES = 12;

function record(value: unknown): Row | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return value as Row;
}

function plainText(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
}

function label(value: unknown): string {
  return typeof value === "string"
    ? plainText(value).normalize("NFC").slice(0, LABEL_LIMIT).trimEnd()
    : "";
}

function iid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function id(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(value);
}

function isScalar(value: unknown): value is Scalar {
  return (
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function hasFormat(value: unknown, format: PropertyControl["format"]): value is Scalar {
  if (format === "bool") return typeof value === "boolean";
  if (format === "string") return typeof value === "string";
  const [min, max] = numericBounds[format];
  return (
    typeof value === "number" &&
    value >= min &&
    value <= max &&
    (format === "float" || Number.isInteger(value))
  );
}

/** Scale the shortest round-tripping decimal text, without floating-point arithmetic or rounding. */
function scaled(value: number): bigint | undefined {
  if (!Number.isFinite(value)) return undefined;
  const [mantissa = "", exponent = "0"] = String(value).split("e");
  const [whole = "", fraction = ""] = mantissa.split(".");
  const shift = DECIMAL_PLACES + Number(exponent) - fraction.length;
  if (shift < 0) return undefined;
  return BigInt(whole + fraction) * 10n ** BigInt(shift);
}

function inRange(value: number, [min, max, step]: Range): boolean {
  if (value < min || value > max) return false;
  const offsets = [value, min, step].map(scaled);
  const [point, start, stride] = offsets;
  return (
    point !== undefined &&
    start !== undefined &&
    stride !== undefined &&
    stride > 0n &&
    (point - start) % stride === 0n
  );
}

function valueRange(raw: unknown, format: PropertyControl["format"]): Range | undefined {
  if (!Array.isArray(raw) || raw.length !== 3) return undefined;
  const [min, max, step]: unknown[] = raw;
  if (
    typeof min !== "number" ||
    typeof max !== "number" ||
    typeof step !== "number" ||
    !hasFormat(min, format) ||
    !hasFormat(max, format) ||
    !hasFormat(step, format) ||
    min > max ||
    step <= 0 ||
    scaled(min) === undefined ||
    scaled(max) === undefined ||
    scaled(step) === undefined
  )
    return undefined;
  return [min, max, step];
}

function choicesFor(raw: unknown, format: PropertyControl["format"]): Choices | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const choices = new Map<Scalar, Choices[number]>();
  for (const item of raw) {
    const entry = record(item);
    const value = entry?.value;
    const text = label(entry?.description);
    if (
      !hasFormat(value, format) ||
      !text ||
      choices.has(value) ||
      (typeof value === "string" && (value.length > LABEL_LIMIT || plainText(value) !== value))
    )
      return undefined;
    choices.set(value, { value, label: text });
  }
  return [...choices.values()].sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

/** Count IDs before interpreting rows, so an invalid duplicate cannot be used as a fallback. */
function uniqueMembers(raw: unknown): Map<number, Row> {
  const result = new Map<number, Row>();
  const seen = new Set<number>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const row = record(item);
      if (row === undefined || !iid(row.iid)) continue;
      if (seen.has(row.iid)) result.delete(row.iid);
      else result.set(row.iid, row);
      seen.add(row.iid);
    }
  }
  return result;
}

function property(piid: number, row: Row): PropertyControl | undefined {
  const text = label(row.description);
  const { format, access } = row;
  if (
    !text ||
    typeof format !== "string" ||
    (format !== "bool" && format !== "string" && !Object.hasOwn(numericBounds, format)) ||
    !Array.isArray(access) ||
    [...access].some((flag) => flag !== "read" && flag !== "write" && flag !== "notify")
  )
    return undefined;

  const knownFormat = format as PropertyControl["format"];
  const projected = {
    piid,
    label: text,
    format: knownFormat,
    readable: access.includes("read"),
    writable: access.includes("write"),
  };
  const constraints = Object.keys(row).filter((key) => key.startsWith("value-"));
  if (constraints.length > 1) return undefined;
  switch (constraints[0]) {
    case "value-range": {
      const range = valueRange(row["value-range"], knownFormat);
      return range === undefined ? undefined : { ...projected, range };
    }
    case "value-list": {
      const choices = choicesFor(row["value-list"], knownFormat);
      return choices === undefined ? undefined : { ...projected, choices };
    }
    case undefined:
      return knownFormat === "string" ? undefined : projected;
    default:
      return undefined;
  }
}

function action(
  aiid: number,
  row: Row,
  properties: ReadonlyMap<number, PropertyControl>,
): ActionControl | undefined {
  const text = label(row.description);
  if (!text || !Array.isArray(row.in)) return undefined;
  const inputs: PropertyControl[] = [];
  for (const ref of row.in) {
    const input = iid(ref) ? properties.get(ref) : undefined;
    if (input === undefined) return undefined;
    inputs.push(input);
  }
  return { aiid, label: text, inputs };
}

/** Project a full MIoT instance response for exactly the requested URN. */
export function parseMijiaSpec(urn: string, raw: unknown): DeviceControls {
  const instance = record(raw);
  const services: ServiceControls[] = [];
  if (instance?.type !== urn) return { urn, services };
  for (const [siid, service] of uniqueMembers(instance.services)) {
    const text = label(service.description);
    if (!text) continue;
    const properties = new Map<number, PropertyControl>();
    for (const [piid, row] of uniqueMembers(service.properties)) {
      const control = property(piid, row);
      if (control !== undefined) properties.set(piid, control);
    }
    const actions = [...uniqueMembers(service.actions)].flatMap(([aiid, row]) => {
      const control = action(aiid, row, properties);
      return control === undefined ? [] : [control];
    });
    services.push({ siid, label: text, properties: [...properties.values()], actions });
  }
  return { urn, services };
}

function exactKeys(row: Row, ...keys: string[]): boolean {
  return (
    Reflect.ownKeys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key))
  );
}

export function parseControlRequest(input: unknown): ControlRequest {
  const row = record(input);
  if (row !== undefined) {
    const { kind, homeId, deviceId, sceneId, siid, piid, aiid, value, inputs } = row;
    if (id(homeId)) {
      if (kind === "scene" && id(sceneId) && exactKeys(row, "kind", "homeId", "sceneId"))
        return { kind, homeId, sceneId };
      if (id(deviceId) && iid(siid)) {
        if (
          kind === "property" &&
          iid(piid) &&
          isScalar(value) &&
          exactKeys(row, "kind", "homeId", "deviceId", "siid", "piid", "value")
        )
          return { kind, homeId, deviceId, siid, piid, value };
        if (
          kind === "action" &&
          iid(aiid) &&
          Array.isArray(inputs) &&
          exactKeys(row, "kind", "homeId", "deviceId", "siid", "aiid", "inputs")
        ) {
          const copy: unknown[] = [...inputs];
          if (copy.every(isScalar)) return { kind, homeId, deviceId, siid, aiid, inputs: copy };
        }
      }
    }
  }
  throw new Error("Invalid control request");
}

function requestedArgument(
  control: PropertyControl,
  value: unknown,
): ControlPreview["arguments"][number] {
  const choice = control.choices?.find((candidate) => candidate.value === value);
  if (
    !hasFormat(value, control.format) ||
    (control.choices !== undefined && choice === undefined) ||
    (control.range !== undefined && (typeof value !== "number" || !inRange(value, control.range)))
  )
    throw new Error("Invalid control value");
  return {
    label: control.label,
    value,
    ...(choice === undefined ? {} : { display: choice.label }),
  };
}

function propertyIdentity(control: PropertyControl): unknown[] {
  return [
    control.piid,
    control.label,
    control.readable,
    control.writable,
    control.format,
    control.range,
    control.choices?.map(({ value, label }) => [value, label]),
  ];
}

function operationLabel(
  descriptor: DeviceControls,
  service: ServiceControls,
  request: Exclude<ControlRequest, { kind: "scene" }>,
  name: string,
): string {
  const kind = request.kind;
  const title = kind === "property" ? "Property" : "Action";
  const memberId = kind === "property" ? request.piid : request.aiid;
  const text = `${service.label}: ${name}`;
  const ambiguous = descriptor.services.some((other) =>
    kind === "property"
      ? other.properties.some(
          (member) =>
            member.writable &&
            (other.siid !== service.siid || member.piid !== memberId) &&
            `${other.label}: ${member.label}` === text,
        )
      : other.actions.some(
          (member) =>
            (other.siid !== service.siid || member.aiid !== memberId) &&
            `${other.label}: ${member.label}` === text,
        ),
  );
  // The kind prefix reserves separate namespaces for tagged and untagged operations.
  return ambiguous
    ? `${title} [service ${service.siid}, ${kind} ${memberId}]: ${text}`
    : `${title}: ${text}`;
}

type Target = { homeId: string; home: string; name: string };

const ID_PREFIX = "[ID: ";

function displayLabel(text: string, id: string, ambiguous: boolean): string {
  // A literal label starting with the reserved prefix is itself tagged, not stripped.
  if (!ambiguous && !text.startsWith(ID_PREFIX)) return text;
  const tag = `${ID_PREFIX}${id}] `;
  return tag + text.slice(0, LABEL_LIMIT - tag.length).trimEnd();
}

function targetPreview<T extends Target>(
  rows: readonly T[],
  target: T,
  targetId: (row: T) => string,
  roomOf?: (row: T) => string | undefined,
) {
  const home = label(target.home);
  const room = label(roomOf?.(target));
  const name = label(target.name);
  if (!home || !name) throw new Error("Control target is unavailable");
  const groups = new Map<string, Map<string, number>>();
  const peers = rows.flatMap((row) => {
    if (label(roomOf?.(row)) !== room) return [];
    const home = label(row.home);
    const name = label(row.name);
    if (!home || !name) return [];
    const key = JSON.stringify([home, name]);
    const homes = groups.get(key) ?? new Map<string, number>();
    homes.set(row.homeId, (homes.get(row.homeId) ?? 0) + 1);
    groups.set(key, homes);
    return [{ row, home, name, homes }];
  });
  const render = (peer: (typeof peers)[number]) => ({
    home: displayLabel(peer.home, peer.row.homeId, peer.homes.size > 1),
    ...(room ? { room } : {}),
    target: displayLabel(peer.name, targetId(peer.row), (peer.homes.get(peer.row.homeId) ?? 0) > 1),
  });
  const selected = peers.find((peer) => peer.row === target);
  if (selected === undefined) throw new Error("Control target is unavailable");
  const preview = render(selected);
  // Truncation can still merge two tagged names with the same ID in different contexts.
  for (const peer of peers) {
    if (peer === selected) continue;
    const other = render(peer);
    if (other.home === preview.home && other.target === preview.target)
      throw new Error("Control target is unavailable");
  }
  return preview;
}

function lookupTarget<T extends Target>(
  rows: readonly T[],
  homeId: string,
  targetId: string,
  getId: (row: T) => string,
): T {
  const index = new Map<string, T | undefined>();
  for (const row of rows) {
    const key = JSON.stringify([row.homeId, getId(row)]);
    index.set(key, index.has(key) ? undefined : row);
  }
  const target = index.get(JSON.stringify([homeId, targetId]));
  if (target === undefined) throw new Error("Control target is unavailable");
  return target;
}

export function findControlDevice(inventory: ControlInventory, homeId: string, deviceId: string) {
  const device = lookupTarget(inventory.devices, homeId, deviceId, (row) => row.deviceId);
  if (device.sharedOnly !== false) throw new Error("Control target is unavailable");
  return device;
}

/** Resolve a single command without provider calls or access to account state. */
export function resolveMijiaCommand(input: unknown, snapshot: ControlSnapshot): ResolvedCommand {
  const request = parseControlRequest(input);
  const { devices, scenes } = snapshot.inventory;
  if (request.kind === "scene") {
    const scene = lookupTarget(scenes, request.homeId, request.sceneId, (row) => row.sceneId);
    const target = targetPreview(scenes, scene, (row) => row.sceneId);
    const operation = "Run scene";
    return {
      request,
      preview: { ...target, operation, arguments: [], sceneWarning: true },
      identity: JSON.stringify([
        request.kind,
        scene.homeId,
        scene.sceneId,
        target.home,
        label(scene.name),
        target.target,
        operation,
      ]),
    };
  }

  const device = findControlDevice(snapshot.inventory, request.homeId, request.deviceId);
  const target = targetPreview(
    devices,
    device,
    (row) => row.deviceId,
    (row) => row.room,
  );
  const descriptor = snapshot.descriptors.get(device.urn);
  const service =
    descriptor?.urn === device.urn
      ? descriptor.services.find(({ siid }) => siid === request.siid)
      : undefined;
  if (descriptor === undefined || service === undefined) throw new Error("Control is unavailable");
  const identity = [
    request.kind,
    device.homeId,
    device.deviceId,
    device.urn,
    target.home,
    target.room,
    label(device.name),
    target.target,
    service.siid,
    service.label,
  ];

  if (request.kind === "property") {
    const control = service.properties.find(({ piid }) => piid === request.piid);
    if (control?.writable !== true) throw new Error("Control is unavailable");
    const operation = operationLabel(descriptor, service, request, control.label);
    return {
      request,
      preview: {
        ...target,
        operation,
        arguments: [requestedArgument(control, request.value)],
        sceneWarning: false,
      },
      identity: JSON.stringify([...identity, operation, propertyIdentity(control)]),
    };
  }

  const control = service.actions.find(({ aiid }) => aiid === request.aiid);
  if (control === undefined) throw new Error("Control is unavailable");
  if (control.inputs.length !== request.inputs.length) throw new Error("Invalid control value");
  const values = request.inputs;
  const operation = operationLabel(descriptor, service, request, control.label);
  return {
    request,
    preview: {
      ...target,
      operation,
      arguments: control.inputs.map((parameter, index) =>
        requestedArgument(parameter, values[index]),
      ),
      sceneWarning: false,
    },
    identity: JSON.stringify([
      ...identity,
      operation,
      control.aiid,
      control.label,
      control.inputs.map(propertyIdentity),
    ]),
  };
}
