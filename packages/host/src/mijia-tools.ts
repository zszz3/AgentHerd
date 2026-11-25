import {
  MIJIA_RUN_ACTION as ACTION,
  type AppToolAttempt,
  type AppToolPreflight,
  type AppTools,
  MIJIA_CAPABILITIES as CONTROLS,
  MIJIA_LIST as LIST,
  type McpTool,
  MIJIA_SET_PROPERTY as PROPERTY,
  MIJIA_RUN_SCENE as SCENE,
  MIJIA_SCENES as SCENES,
  MIJIA_STATUS as STATUS,
} from "@agentherd/core";
import {
  MIJIA_PROPERTIES,
  type MijiaAccount,
  type MijiaProperty,
  validMijiaDeviceId,
} from "./mijia-account.ts";

import type { ControlOrigin, MijiaControl } from "./mijia-control.ts";
import type { ControlPreview } from "./mijia-control-types.ts";

const labels = new Map<string, string>([
  [LIST, "米家：列出设备及在线状态"],
  [STATUS, "米家：读取指定设备的常用状态属性（仅出现在共享列表的设备不支持）"],
]);
const properties = new Set<string>(MIJIA_PROPERTIES);
const controlLabels = new Map<string, string>([
  [CONTROLS, "Mi Home: discover controls for a home and device ID"],
  [SCENES, "Mi Home: list existing manual scenes"],
  [PROPERTY, "Mi Home: set a property after exact owner approval"],
  [ACTION, "Mi Home: run a device action after exact owner approval"],
  [SCENE, "Mi Home: run a manual scene after exact owner approval"],
]);
const writes = new Map([
  [PROPERTY, "property"],
  [ACTION, "action"],
  [SCENE, "scene"],
]);
const id = { type: "string", minLength: 1 };
const iid = { type: "integer", minimum: 1 };
const scalar = { type: ["boolean", "number", "string"] };
const keys = { homeId: id, deviceId: id, siid: iid };
const controlSchemas = new Map<string, Record<string, unknown>>([
  [CONTROLS, { homeId: id, deviceId: id }],
  [SCENES, {}],
  [PROPERTY, { ...keys, piid: iid, value: scalar }],
  [ACTION, { ...keys, aiid: iid, inputs: { type: "array", items: scalar } }],
  [SCENE, { homeId: id, sceneId: id }],
]);

function previewText(preview: ControlPreview): string {
  const q = JSON.stringify;
  return [
    `Home: ${q(preview.home)}`,
    ...(preview.room === undefined ? [] : [`Room: ${q(preview.room)}`]),
    `Target: ${q(preview.target)}`,
    `Operation: ${q(preview.operation)}`,
    ...preview.arguments.map(
      (arg, i) =>
        `${i + 1}. ${q(arg.label)}: ${q(arg.value)}${arg.display === undefined ? "" : ` (${q(arg.display)})`}`,
    ),
    ...(preview.sceneWarning
      ? ["This scene may affect multiple devices; its individual steps are not shown."]
      : []),
  ].join("\n");
}

const result = (data: unknown, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  ...(isError ? { isError: true } : {}),
});

async function prepareWrite(
  control: MijiaControl,
  attempt: AppToolAttempt,
  value: unknown,
  kind: string,
  scan?: AbortSignal,
): Promise<AppToolPreflight | undefined> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.hasOwn(value, "kind")
  )
    return undefined;
  const origin: ControlOrigin = { kind: "task", key: attempt.key };
  const signal = scan === undefined ? attempt.signal : AbortSignal.any([attempt.signal, scan]);
  if (signal.aborted) return undefined;
  let abandoned!: () => void;
  const interrupted = new Promise<undefined>((resolve) => {
    abandoned = () => resolve(undefined);
  });
  const revoke = () => {
    control.revoke(origin);
    abandoned();
  };
  signal.addEventListener("abort", revoke, { once: true });
  let id: string | undefined;
  const cancel = () => {
    signal.removeEventListener("abort", revoke);
    if (id !== undefined) control.cancel(origin, id);
  };
  try {
    const preparing = control.prepare(origin, { ...value, kind }).then((proposal) => {
      id = proposal.id;
      if (!signal.aborted) return proposal;
      cancel();
      return undefined;
    });
    const proposal = await Promise.race([preparing, interrupted]);
    if (proposal === undefined || signal.aborted) {
      cancel();
      return undefined;
    }
    const { preview } = proposal;
    const source = [preview.home, preview.target, preview.operation];
    if (preview.room !== undefined) source.push(preview.room);
    for (const arg of preview.arguments) {
      source.push(arg.label);
      if (typeof arg.value === "string") source.push(arg.value);
      if (arg.display !== undefined) source.push(arg.display);
    }
    return {
      exactApproval: {
        preview: { text: previewText(preview), source },
        expiresAt: proposal.expiresAt,
        cancel,
        signal,
      },
      async execute(beforeDispatch) {
        const outcome = await control.confirm(origin, proposal.id, beforeDispatch);
        return result(
          outcome.state === "not-sent"
            ? { state: outcome.state, reason: outcome.reason }
            : { state: outcome.state },
          outcome.state === "not-sent" ||
            outcome.state === "rejected" ||
            outcome.state === "unknown" ||
            outcome.state === "mismatch",
        );
      },
    };
  } catch (error) {
    cancel();
    throw error;
  }
}

export function mijiaTools(
  account: MijiaAccount,
  control?: MijiaControl,
  scanSignal?: () => AbortSignal,
): AppTools {
  const active = () => account.view().state === "connected";
  const preflight = (
    name: string,
    value: unknown,
    attempt?: AppToolAttempt,
  ): AppToolPreflight | undefined | Promise<AppToolPreflight | undefined> => {
    if (control !== undefined && controlLabels.has(name)) {
      const kind = writes.get(name);
      if (kind !== undefined) {
        if (attempt === undefined || attempt.signal.aborted || !active()) return undefined;
        return prepareWrite(control, attempt, value, kind, scanSignal?.());
      }
      const guard = account.guardRead();
      if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid Mi Home arguments");
      const { homeId, deviceId } = value as Record<string, unknown>;
      const keys = Object.keys(value);
      if (
        name === CONTROLS &&
        keys.length === 2 &&
        typeof homeId === "string" &&
        typeof deviceId === "string" &&
        homeId !== "" &&
        deviceId !== ""
      )
        return {
          approvalArguments: { homeId, deviceId },
          execute: async () => {
            guard();
            return result(await control.capabilities(homeId, deviceId));
          },
        };
      if (name === SCENES && keys.length === 0)
        return {
          approvalArguments: {},
          execute: async () => {
            guard();
            return result((await control.inventory()).scenes);
          },
        };
      throw new Error("Invalid Mi Home arguments");
    }
    if (!labels.has(name)) return undefined;
    const guard = account.guardRead();
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("米家工具参数无效。");
    const args = value as Record<string, unknown>;
    const prepare = (
      approvalArguments: unknown,
      read: () => Promise<unknown>,
    ): AppToolPreflight => ({
      approvalArguments,
      async execute() {
        guard();
        return { content: [{ type: "text", text: JSON.stringify(await read()) }] };
      },
    });
    if (name === LIST && Object.keys(args).length === 0)
      return prepare({}, () => account.devices());
    const { id, properties: keys } = args;
    if (
      name === STATUS &&
      Object.keys(args).length === 2 &&
      typeof id === "string" &&
      validMijiaDeviceId(id) &&
      Array.isArray(keys) &&
      keys.length >= 1 &&
      keys.length <= MIJIA_PROPERTIES.length &&
      new Set(keys).size === keys.length &&
      keys.every((key: unknown) => typeof key === "string" && properties.has(key))
    ) {
      const requested = [...keys] as MijiaProperty[];
      return prepare({ id, properties: [...requested] }, () => account.properties(id, requested));
    }
    throw new Error("米家工具参数无效。");
  };
  return {
    preflight,
    list: async () => {
      if (!active()) return [];
      const tools: McpTool[] = [...labels].map(([name, description]) => ({
        name,
        description,
        inputSchema:
          name === LIST
            ? { type: "object", properties: {}, additionalProperties: false }
            : {
                type: "object",
                properties: {
                  id: { type: "string", description: "Device ID from mijia_list_devices" },
                  properties: {
                    type: "array",
                    items: { type: "string", enum: [...MIJIA_PROPERTIES] },
                    minItems: 1,
                    maxItems: MIJIA_PROPERTIES.length,
                    uniqueItems: true,
                  },
                },
                required: ["id", "properties"],
                additionalProperties: false,
              },
      }));
      if (control !== undefined)
        for (const [name, description] of controlLabels) {
          const properties = controlSchemas.get(name);
          if (properties === undefined) continue;
          tools.push({
            name,
            description,
            inputSchema: {
              type: "object",
              properties,
              required: Object.keys(properties),
              additionalProperties: false,
            },
          });
        }
      return tools;
    },
    describe: async (names) => {
      const entries = new Map();
      if (active())
        for (const name of names) {
          const title =
            labels.get(name) ?? (control === undefined ? undefined : controlLabels.get(name));
          if (title !== undefined)
            entries.set(name, {
              title,
              toolkit: "builtin:mijia",
              hints: { readOnly: !writes.has(name) },
            });
        }
      return entries;
    },
    async call(name, value) {
      const prepared = await preflight(name, value);
      if (prepared === undefined) throw new Error("米家工具不可用。");
      return prepared.execute();
    },
  };
}
