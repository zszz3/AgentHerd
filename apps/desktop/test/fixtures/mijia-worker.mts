import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MijiaControl } from "../../../../packages/host/src/mijia-control.ts";
import type { ControlRequest } from "../../../../packages/host/src/mijia-control-types.ts";
import {
  attachMijiaDesktopBridge,
  type DesktopParentPort,
} from "../../../../packages/host/src/mijia-desktop-bridge.ts";

const root = process.argv[2];
if (!root) throw new Error("Missing isolated fixture directory");
const model = "urn:miot-spec-v2:device:light:0000A001:fictional-lamp:1";
const session = {};
const control = new MijiaControl({ current: () => ({ session, worker }) });
const worker = {
  async inventory() {
    // Freeze a read until the test confirms desktop document retirement.
    if (existsSync(join(root, "hold"))) appendFileSync(join(root, "reading"), ".");
    while (existsSync(join(root, "hold"))) await new Promise((resolve) => setTimeout(resolve, 15));
    return {
      devices: [
        {
          homeId: "fictional-home",
          deviceId: "fictional-lamp",
          urn: model,
          home: "Fictional home",
          room: "Reading room",
          name: "Floor lamp",
          sharedOnly: false,
        },
        {
          homeId: "fictional-home",
          deviceId: "other-lamp",
          urn: model,
          home: "Fictional home",
          room: "Hall",
          name: "Floor lamp",
          sharedOnly: false,
        },
      ],
      scenes: [
        {
          homeId: "fictional-home",
          sceneId: "fictional-scene",
          home: "Fictional home",
          name: "Lamp demo",
        },
      ],
    };
  },
  async descriptor() {
    if (existsSync(join(root, "hold-refresh"))) {
      appendFileSync(join(root, "refreshing"), ".");
      while (existsSync(join(root, "hold-refresh"))) {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    }
    return {
      type: model,
      services: [
        {
          iid: 2,
          description: "Light",
          properties: [
            { iid: 1, description: "Power", format: "bool", access: ["write"] },
            {
              iid: 2,
              description: "Brightness",
              format: "uint8",
              access: ["write"],
              "value-range": [0, 100, 1],
            },
            {
              iid: 3,
              description: "Mode",
              format: "uint8",
              access: ["write"],
              "value-list": [
                { value: 1, description: "Reading" },
                { value: 2, description: "Soft" },
              ],
            },
          ],
          actions: [{ iid: 1, description: "Lamp colour demo", in: [3, 1], out: [] }],
        },
      ],
    };
  },
  async mutate(request: ControlRequest) {
    appendFileSync(join(root, "mutations"), `${JSON.stringify(request)}\n`);
    if (existsSync(join(root, "lose-result"))) throw new Error("Synthetic result loss");
    if (existsSync(join(root, "hold-receipt"))) {
      // The utility is killed by the test after observing the completed fixture write.
      await new Promise<never>(() => {});
    }
    return "acknowledged" as const;
  },
  async readProperty() {
    return undefined;
  },
};
const port = (process as { parentPort?: DesktopParentPort }).parentPort;
if (!port) throw new Error("Missing fixture parent port");
const stop = attachMijiaDesktopBridge(
  port,
  control,
  () => ({}),
  ({ request, model: current }) => {
    if (request.homeId !== "fictional-home") return false;
    if (request.kind === "scene") return request.sceneId === "fictional-scene";
    if (current !== model || request.deviceId !== "fictional-lamp" || request.siid !== 2)
      return false;
    return request.kind === "action" ? request.aiid === 1 : [1, 2, 3].includes(request.piid);
  },
);
port.on("message", ({ data }) => {
  if ((data as { type?: unknown } | null)?.type !== "stop") return;
  stop();
  process.exit(0);
});
