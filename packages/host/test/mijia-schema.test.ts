import { describe, expect, it } from "vitest";
import type { ControlDevice, ControlSnapshot } from "../src/mijia-control-types.ts";
import { parseMijiaSpec, resolveMijiaCommand } from "../src/mijia-schema.ts";

const lightUrn = "urn:miot-spec-v2:device:light:0000A001:test-light:1";
const thermostatUrn = "urn:miot-spec-v2:device:thermostat:0000A031:test-thermostat:1";
const lightDevice = {
  homeId: "home-a",
  deviceId: "light-a",
  urn: lightUrn,
  home: "Main home",
  room: "Study",
  name: "Floor lamp",
  sharedOnly: false,
} satisfies ControlDevice;
const on = { iid: 1, description: "Power", format: "bool", access: ["read", "write"] };
const brightness = {
  iid: 2,
  description: "Brightness",
  format: "uint8",
  access: ["write"],
  "value-range": [1, 100, 1],
};
const mode = {
  iid: 3,
  description: "Mode",
  format: "uint8",
  access: ["write"],
  "value-list": [
    { value: 2, description: "Night" },
    { value: 1, description: "Day" },
  ],
};
const lightService = {
  iid: 2,
  description: "Light",
  properties: [on, brightness, mode, { ...on, iid: 4, access: ["read", "notify"] }],
  actions: [
    { iid: 1, description: "Reset", in: [] },
    { iid: 2, description: "Adjust", in: [2] },
    { iid: 3, description: "Unknown signature" },
    { iid: 4, description: "Missing input", in: [999] },
    { iid: 5, description: "Set mode and power", in: [3, 1] },
  ],
};
const thermostat = {
  type: thermostatUrn,
  services: [
    {
      iid: 2,
      description: "Thermostat",
      properties: [
        {
          ...brightness,
          description: "Temperature",
          format: "float",
          "value-range": [16, 30, 0.5],
        },
        {
          ...brightness,
          iid: 3,
          description: "Ratio",
          format: "float",
          "value-range": [0.1, 0.9, 0.1],
        },
      ],
    },
  ],
};
const scene = { homeId: "home-a", home: "Main home", sceneId: "scene-a", name: "Movie night" };

function snapshot(services: readonly unknown[] = [lightService]): ControlSnapshot {
  return {
    inventory: {
      devices: [
        lightDevice,
        { ...lightDevice, urn: thermostatUrn, deviceId: "thermostat-a", name: "Thermostat" },
      ],
      scenes: [scene],
    },
    descriptors: new Map([
      [lightUrn, parseMijiaSpec(lightUrn, { type: lightUrn, services })],
      [thermostatUrn, parseMijiaSpec(thermostatUrn, thermostat)],
    ]),
  };
}

const light = {
  kind: "property",
  homeId: "home-a",
  deviceId: "light-a",
  siid: 2,
  piid: 2,
  value: 40,
} as const;
const action = {
  kind: "action",
  homeId: "home-a",
  deviceId: "light-a",
  siid: 2,
  aiid: 2,
  inputs: [40],
} as const;
const sceneRequest = { kind: "scene", homeId: "home-a", sceneId: "scene-a" } as const;

function withProperty(property: unknown): ControlSnapshot {
  return snapshot([{ ...lightService, properties: [property] }]);
}

describe("MIoT descriptor projection", () => {
  it("projects named services, writable and read-only properties, and only actions with known signatures", () => {
    const controls = snapshot().descriptors.get(lightUrn);
    expect(controls).toMatchObject({ urn: lightUrn, services: [{ siid: 2, label: "Light" }] });
    expect(controls?.services[0]?.properties).toMatchObject([
      { piid: 1, readable: true, writable: true },
      { piid: 2, readable: false, writable: true },
      { piid: 3, readable: false, writable: true },
      { piid: 4, readable: true, writable: false },
    ]);
    expect(
      controls?.services[0]?.actions.map(({ aiid, inputs }) => [
        aiid,
        inputs.map(({ piid }) => piid),
      ]),
    ).toEqual([
      [1, []],
      [2, [2]],
      [5, [3, 1]],
    ]);
  });

  it("does not infer a descriptor from flattened data or another instance URN", () => {
    expect(
      parseMijiaSpec(lightUrn, { type: thermostatUrn, services: [lightService] }).services,
    ).toEqual([]);
    expect(parseMijiaSpec(lightUrn, { properties: [on], actions: [] }).services).toEqual([]);
  });

  it.each([
    ["unknown format", { ...brightness, format: "mystery" }],
    ["unbounded string", { ...on, format: "string" }],
    ["invalid boolean range", { ...brightness, format: "bool" }],
    ["conflicting enum and grid", { ...mode, "value-range": [1, 2, 1] }],
    [
      "duplicated enum key",
      {
        ...mode,
        "value-list": [
          { value: 1, description: "A" },
          { value: 1, description: "B" },
        ],
      },
    ],
    ["out-of-format grid", { ...brightness, "value-range": [-1, 100, 1] }],
    ["zero step", { ...brightness, "value-range": [1, 100, 0] }],
    ["excess grid precision", { ...brightness, format: "float", "value-range": [0, 1, 1e-20] }],
    ["unknown access flag", { ...brightness, access: ["write", "unknown"] }],
  ])("omits a property with %s", (_case, property) => {
    expect(withProperty(property).descriptors.get(lightUrn)?.services[0]?.properties).toEqual([]);
  });

  it("does not resolve action parameters against another service", () => {
    const current = snapshot([lightService, { ...lightService, iid: 3, properties: [] }]);
    expect(() => resolveMijiaCommand({ ...action, siid: 3 }, current)).toThrow(
      "Control is unavailable",
    );
  });

  it.each([
    ["service", [lightService, { iid: 2, description: "Duplicate" }], light],
    [
      "property",
      [{ ...lightService, properties: [...lightService.properties, { iid: 2 }] }],
      light,
    ],
    ["action", [{ ...lightService, actions: [...lightService.actions, { iid: 2 }] }], action],
    [
      "action parameter",
      [{ ...lightService, properties: [...lightService.properties, { iid: 2 }] }],
      action,
    ],
  ])("fails closed for a duplicate %s ID", (_case, services, request) => {
    expect(() => resolveMijiaCommand(request, snapshot(services))).toThrow(
      "Control is unavailable",
    );
  });

  it("keeps unrelated controls when one property ID conflicts", () => {
    const current = snapshot([
      { ...lightService, properties: [...lightService.properties, { iid: 2 }] },
    ]);
    expect(resolveMijiaCommand({ ...light, piid: 1, value: true }, current).request).toMatchObject({
      value: true,
    });
  });
});

describe("Mi Home command resolution", () => {
  it("returns the exact validated property request and a plain owner preview", () => {
    expect(resolveMijiaCommand(light, snapshot())).toMatchObject({
      request: light,
      preview: {
        home: "Main home",
        room: "Study",
        target: "Floor lamp",
        operation: "Property: Light: Brightness",
        arguments: [{ label: "Brightness", value: 40 }],
        sceneWarning: false,
      },
    });
  });

  it("distinguishes a property from a same-named action with identical arguments", () => {
    const current = snapshot([
      { ...lightService, actions: [{ iid: 2, description: "Brightness", in: [2] }] },
    ]);

    const propertyPreview = resolveMijiaCommand(light, current).preview;
    const actionPreview = resolveMijiaCommand(action, current).preview;

    expect(propertyPreview).not.toEqual(actionPreview);
    expect(propertyPreview.operation).toContain("Property");
    expect(actionPreview.operation).toContain("Action");
  });

  it.each([
    ["property", light, { ...light, piid: 6 }],
    ["action", action, { ...action, aiid: 6 }],
  ] as const)(
    "distinguishes equal %s labels within and across equal-named services",
    (_kind, request, sibling) => {
      const service = {
        ...lightService,
        properties: [brightness, { ...brightness, iid: 6 }],
        actions: [
          { iid: 2, description: "Adjust", in: [2] },
          { iid: 6, description: "Adjust", in: [2] },
        ],
      };
      const current = snapshot([service, { ...service, iid: 3 }]);

      const previews = [request, sibling, { ...request, siid: 3 }].map(
        (candidate) => resolveMijiaCommand(candidate, current).preview,
      );

      expect(new Set(previews.map((preview) => JSON.stringify(preview))).size).toBe(3);
      expect(previews[0]?.operation).toContain("service 2");
      expect(previews[1]?.operation).toContain(`${request.kind} 6`);
      expect(previews[2]?.operation).toContain("service 3");
    },
  );

  it("tags actions with canonically equivalent labels", () => {
    const current = snapshot([
      {
        ...lightService,
        actions: [
          { iid: 1, description: "Caf\u00e9", in: [] },
          { iid: 2, description: "Cafe\u0301", in: [] },
        ],
      },
    ]);

    const operations = [1, 2].map(
      (aiid) => resolveMijiaCommand({ ...action, aiid, inputs: [] }, current).preview.operation,
    );

    expect(operations).toEqual([
      "Action [service 2, action 1]: Light: Caf\u00e9",
      "Action [service 2, action 2]: Light: Caf\u00e9",
    ]);
  });

  it("separates service and member names when their separator would collide", () => {
    const current = snapshot([
      { ...lightService, description: "Room: Light", properties: [brightness] },
      {
        ...lightService,
        iid: 3,
        description: "Room",
        properties: [{ ...brightness, description: "Light: Brightness" }],
      },
    ]);

    expect(resolveMijiaCommand(light, current).preview.operation).not.toBe(
      resolveMijiaCommand({ ...light, siid: 3 }, current).preview.operation,
    );
  });

  it("keeps provider labels looking like an operation tag separate from the real tag", () => {
    const withDuplicate = {
      ...lightService,
      properties: [brightness, { ...brightness, iid: 6 }],
      actions: [
        { iid: 1, description: "Reset", in: [] },
        { iid: 2, description: "Reset", in: [] },
      ],
    };
    const lookalike = {
      ...lightService,
      iid: 3,
      description: "Action [service 2, action 1]: Light",
      actions: [{ iid: 1, description: "Reset", in: [] }],
    };
    const current = snapshot([withDuplicate, lookalike]);
    const request = { ...action, aiid: 1, inputs: [] };

    const previews = [request, { ...request, aiid: 2 }, { ...request, siid: 3 }].map(
      (candidate) => resolveMijiaCommand(candidate, current).preview,
    );

    expect(new Set(previews.map((preview) => JSON.stringify(preview))).size).toBe(3);
    expect(previews[0]?.operation).toContain("service 2, action 1");
    expect(previews[2]?.operation).toContain(lookalike.description);
  });

  it("changes stale identity when a new control changes the displayed operation", () => {
    const service = {
      ...lightService,
      properties: [...lightService.properties, { ...brightness, iid: 6 }],
    };

    const before = resolveMijiaCommand(light, snapshot());
    const after = resolveMijiaCommand(light, snapshot([service]));

    expect(after.identity).not.toBe(before.identity);
    expect(after.preview.operation).not.toBe(before.preview.operation);
  });

  it.each([
    ["boolean", { ...light, piid: 1, value: true }, true],
    ["numeric enum", { ...light, piid: 3, value: 2 }, 2],
    ["half-degree step", { ...light, deviceId: "thermostat-a", value: 16.5 }, 16.5],
    ["exact decimal step", { ...light, deviceId: "thermostat-a", piid: 3, value: 0.3 }, 0.3],
  ])("retains a valid %s value", (_case, request, expected) => {
    expect(resolveMijiaCommand(request, snapshot()).preview.arguments[0]?.value).toBe(expected);
  });

  it.each([
    ["numeric string", { ...light, value: "40" }, "Invalid control value"],
    ["numeric boolean", { ...light, piid: 1, value: 1 }, "Invalid control value"],
    ["NaN", { ...light, value: Number.NaN }, "Invalid control request"],
    ["infinity", { ...light, value: Number.POSITIVE_INFINITY }, "Invalid control request"],
    ["extra key", { ...light, payload: {} }, "Invalid control request"],
    ["read-only property", { ...light, piid: 4, value: true }, "Control is unavailable"],
    ["missing enum key", { ...light, piid: 3, value: 3 }, "Invalid control value"],
    ["fraction in integer format", { ...light, value: 40.5 }, "Invalid control value"],
    ["above range", { ...light, value: 101 }, "Invalid control value"],
    [
      "off-grid thermostat value",
      { ...light, deviceId: "thermostat-a", value: 16.25 },
      "Invalid control value",
    ],
    [
      "almost on the grid",
      { ...light, deviceId: "thermostat-a", piid: 3, value: 0.30000000000004 },
      "Invalid control value",
    ],
    ["wrong home", { ...light, homeId: "home-b" }, "Control target is unavailable"],
    ["lookup by name", { ...light, deviceId: "Floor lamp" }, "Invalid control request"],
    ["non-numeric member ID", { ...light, piid: "2" }, "Invalid control request"],
    ["missing action argument", { ...action, inputs: [] }, "Invalid control value"],
    ["extra action argument", { ...action, inputs: [40, 50] }, "Invalid control value"],
    ["sparse action arguments", { ...action, inputs: new Array(1) }, "Invalid control request"],
    [
      "wrong action argument order",
      { ...action, aiid: 5, inputs: [true, 2] },
      "Invalid control value",
    ],
    ["wrong scene home", { ...sceneRequest, homeId: "home-b" }, "Control target is unavailable"],
    ["extra scene key", { ...sceneRequest, deviceId: "light-a" }, "Invalid control request"],
  ])("rejects %s", (_case, request, message) => {
    expect(() => resolveMijiaCommand(request, snapshot())).toThrow(message as string);
  });

  it.each([
    ["uint8 minimum", "uint8", 0, true],
    ["uint8 negative", "uint8", -1, false],
    ["uint8 overflow", "uint8", 256, false],
    ["int8 minimum", "int8", -128, true],
    ["int8 underflow", "int8", -129, false],
    ["int32 overflow", "int32", 2 ** 31, false],
  ] as const)("enforces the %s", (_case, format, value, valid) => {
    const current = withProperty({ iid: 2, description: "Level", format, access: ["write"] });
    const resolve = () => resolveMijiaCommand({ ...light, value }, current);
    if (valid) expect(resolve().request).toMatchObject({ value });
    else expect(resolve).toThrow("Invalid control value");
  });

  it("validates strings against documented enum values without coercion", () => {
    const current = withProperty({
      ...mode,
      iid: 2,
      format: "string",
      "value-list": [{ value: "1", description: "Quiet" }],
    });
    expect(resolveMijiaCommand({ ...light, value: "1" }, current).preview.arguments).toEqual([
      { label: "Mode", value: "1", display: "Quiet" },
    ]);
    expect(() => resolveMijiaCommand({ ...light, value: 1 }, current)).toThrow(
      "Invalid control value",
    );
  });

  it.each([
    { ...light, value: "Cafe\u0301" },
    { ...action, inputs: ["Cafe\u0301"] },
  ])("preserves an explicitly listed decomposed string in a $kind request", (request) => {
    const current = withProperty({
      ...mode,
      iid: 2,
      format: "string",
      "value-list": [{ value: "Cafe\u0301", description: "Cafe\u0301" }],
    });
    const canonicalRequest =
      request.kind === "property"
        ? { ...request, value: "Caf\u00e9" }
        : { ...request, inputs: ["Caf\u00e9"] };

    const resolved = resolveMijiaCommand(request, current);

    expect(resolved.request).toEqual(request);
    expect(resolved.preview.arguments).toEqual([
      { label: "Mode", value: "Cafe\u0301", display: "Caf\u00e9" },
    ]);
    expect(() => resolveMijiaCommand(canonicalRequest, current)).toThrow("Invalid control value");
  });

  it("previews ordered action arguments without retaining the caller's array", () => {
    const input = { ...action, aiid: 5, inputs: [2, true] };
    const resolved = resolveMijiaCommand(input, snapshot());
    input.inputs.reverse();
    expect(resolved.request).toEqual({ ...action, aiid: 5, inputs: [2, true] });
    expect(resolved.preview.arguments).toEqual([
      { label: "Mode", value: 2, display: "Night" },
      { label: "Power", value: true },
    ]);
  });

  it("accepts an explicit parameterless action", () => {
    const request = { ...action, aiid: 1, inputs: [] };
    expect(resolveMijiaCommand(request, snapshot())).toMatchObject({
      request,
      preview: { arguments: [] },
    });
  });

  it("binds a manual scene to a home and warns that it may affect multiple devices", () => {
    expect(resolveMijiaCommand(sceneRequest, snapshot())).toMatchObject({
      request: sceneRequest,
      preview: {
        home: "Main home",
        target: "Movie night",
        operation: "Run scene",
        arguments: [],
        sceneWarning: true,
      },
    });
  });

  it("rejects shared-only devices and duplicate compound target IDs", () => {
    const current = snapshot();
    const withDevices = (devices: ControlDevice[]) => ({
      ...current,
      inventory: { ...current.inventory, devices },
    });
    expect(() =>
      resolveMijiaCommand(light, withDevices([{ ...lightDevice, sharedOnly: true }])),
    ).toThrow("Control target is unavailable");
    expect(() =>
      resolveMijiaCommand(light, withDevices([lightDevice, { ...lightDevice, name: "Copy" }])),
    ).toThrow("Control target is unavailable");
    expect(() =>
      resolveMijiaCommand(sceneRequest, {
        ...current,
        inventory: { ...current.inventory, scenes: [scene, scene] },
      }),
    ).toThrow("Control target is unavailable");
  });

  it("distinguishes identical display names without disclosing IDs for unique labels", () => {
    const current = snapshot();
    const devices = [
      lightDevice,
      { ...lightDevice, deviceId: "light-b" },
      { ...lightDevice, homeId: "home-b", home: "Other home" },
    ];
    const duplicates = { ...current, inventory: { ...current.inventory, devices } };
    const before = resolveMijiaCommand(light, current);
    const first = resolveMijiaCommand(light, duplicates);
    const second = resolveMijiaCommand({ ...light, deviceId: "light-b" }, duplicates);
    const otherHome = resolveMijiaCommand({ ...light, homeId: "home-b" }, duplicates);
    expect(first.preview.target).not.toBe(second.preview.target);
    expect(first.identity).not.toBe(second.identity);
    expect(before.preview.target).toBe("Floor lamp");
    expect(otherHome.preview).toMatchObject({ home: "Other home", target: "Floor lamp" });
  });

  it.each(["device", "scene"] as const)(
    "keeps complete %s previews distinct from lookalike names",
    (kind) => {
      const current = snapshot();
      const rows = [
        { homeId: "home-a", home: "Main home", id: "a", name: "Lamp" },
        { homeId: "home-a", home: "Main home", id: "b", name: "Lamp" },
        { homeId: "home-a", home: "Main home", id: "c", name: "Lamp [a]" },
        { homeId: "home-b", home: "Main home", id: "a", name: "Hall" },
        { homeId: "home-c", home: "Main home", id: "a", name: "Hall" },
        { homeId: "home-d", home: "Main home [home-b]", id: "a", name: "Hall" },
        { homeId: "home-a", home: "Main home", id: "d", name: "[ID: a] Lamp" },
        { homeId: "home-e", home: "[ID: home-b] Main home", id: "a", name: "Hall" },
      ];
      const inventory = {
        devices: rows.map(({ id, ...row }) => ({ ...lightDevice, ...row, deviceId: id })),
        scenes: rows.map(({ id, ...row }) => ({ ...row, sceneId: id })),
      };

      const previews = rows.map(
        ({ homeId, id }) =>
          resolveMijiaCommand(
            kind === "device"
              ? { ...light, homeId, deviceId: id }
              : { ...sceneRequest, homeId, sceneId: id },
            { ...current, inventory },
          ).preview,
      );

      expect(new Set(previews.map((preview) => JSON.stringify(preview))).size).toBe(rows.length);
      expect(previews[2]?.target).toContain("Lamp [a]");
      expect(previews[5]?.home).toContain("Main home [home-b]");
      expect(previews[6]?.target).toContain("[ID: a] Lamp");
      expect(previews[7]?.home).toContain("[ID: home-b] Main home");
    },
  );

  it.each(["device", "scene"] as const)(
    "tags %s targets with canonically equivalent labels",
    (kind) => {
      const current = snapshot();
      const rows = [
        { id: "target-a", name: "Caf\u00e9" },
        { id: "target-b", name: "Cafe\u0301" },
      ];
      const inventory = {
        devices: rows.map(({ id, name }) => ({ ...lightDevice, deviceId: id, name })),
        scenes: rows.map(({ id, name }) => ({ ...scene, sceneId: id, name })),
      };

      const targets = rows.map(
        ({ id }) =>
          resolveMijiaCommand(
            kind === "device" ? { ...light, deviceId: id } : { ...sceneRequest, sceneId: id },
            { ...current, inventory },
          ).preview.target,
      );

      expect(targets).toEqual(["[ID: target-a] Caf\u00e9", "[ID: target-b] Caf\u00e9"]);
    },
  );

  it("keeps duplicate previews distinct and bounded for long IDs, even across same-named homes", () => {
    const current = snapshot();
    const homeId = "h".repeat(128);
    const otherHomeId = "i".repeat(128);
    const deviceId = "a".repeat(128);
    const otherDeviceId = "b".repeat(128);
    const devices = [
      { ...lightDevice, homeId, deviceId },
      { ...lightDevice, homeId, deviceId: otherDeviceId },
      { ...lightDevice, homeId: otherHomeId, deviceId },
    ];
    const duplicates = { ...current, inventory: { ...current.inventory, devices } };
    const previews = devices.map(
      (row) =>
        resolveMijiaCommand({ ...light, homeId: row.homeId, deviceId: row.deviceId }, duplicates)
          .preview,
    );
    expect(new Set(previews.map(({ home, target }) => JSON.stringify([home, target]))).size).toBe(
      3,
    );
    expect(
      previews
        .flatMap(({ home, target }) => [home.length, target.length])
        .every((length) => length <= 160),
    ).toBe(true);
    for (const [index, row] of devices.entries()) {
      expect(previews[index]?.home).toContain(row.homeId);
      if (row.homeId === homeId) expect(previews[index]?.target).toContain(row.deviceId);
    }
  });

  it("fails closed when truncation still makes two complete target previews identical", () => {
    const current = snapshot();
    const sceneId = "a".repeat(128);
    const name = `[ID: literal] ${"x".repeat(120)}`;
    const scenes = [
      { ...scene, sceneId, name: `${name} First` },
      { ...scene, sceneId, homeId: "home-b", name: `${name} Second` },
      scene,
    ];
    const snapshotWithCollision = { ...current, inventory: { ...current.inventory, scenes } };

    for (const row of scenes.slice(0, 2)) {
      expect(() =>
        resolveMijiaCommand(
          { ...sceneRequest, sceneId, homeId: row.homeId },
          snapshotWithCollision,
        ),
      ).toThrow("Control target is unavailable");
    }
    expect(resolveMijiaCommand(sceneRequest, snapshotWithCollision).preview.target).toBe(
      scene.name,
    );
  });

  it("does not include scene metadata outside the public inventory DTO", () => {
    const current = snapshot();
    const scenes = [{ ...scene, room: "unprojected" }];
    const resolved = resolveMijiaCommand(sceneRequest, {
      ...current,
      inventory: { ...current.inventory, scenes },
    });
    expect(resolved.preview).not.toHaveProperty("room");
  });

  it("uses bounded plain labels rather than raw provider fields", () => {
    const current = snapshot();
    const device = {
      ...lightDevice,
      name: `  Floor\n\u202Elamp ${"x".repeat(300)} `,
      token: "unprojected",
    };
    const result = resolveMijiaCommand(light, {
      ...current,
      inventory: { ...current.inventory, devices: [device] },
    });
    expect(result.preview.target).toMatch(/^Floor lamp x+$/);
    expect(result.preview.target.length).toBeLessThanOrEqual(160);
    expect(result.identity).not.toContain("unprojected");
  });

  it("normalizes a target label before applying the length limit", () => {
    const current = snapshot();
    const devices = [{ ...lightDevice, name: `Cafe\u0301${"x".repeat(157)}` }];

    const { preview } = resolveMijiaCommand(light, {
      ...current,
      inventory: { ...current.inventory, devices },
    });

    expect(preview.target).toBe(`Caf\u00e9${"x".repeat(156)}`);
  });

  it("keeps identity stable under field order and unrelated descriptor changes", () => {
    const reordered = {
      actions: [...lightService.actions].reverse(),
      properties: [
        {
          "value-list": [...mode["value-list"]].reverse(),
          format: "uint8",
          access: ["write"],
          iid: 3,
          description: "Mode",
        },
        { ...on, access: ["write", "read"] },
        { ...brightness, description: "Unrelated level" },
      ],
      description: "Light",
      iid: 2,
    };
    const request = { ...action, aiid: 5, inputs: [2, true] };
    expect(resolveMijiaCommand(request, snapshot([reordered])).identity).toBe(
      resolveMijiaCommand(request, snapshot()).identity,
    );
  });

  it.each([
    ["service label", { ...lightService, description: "Lamp" }],
    [
      "property label",
      { ...lightService, properties: [on, { ...brightness, description: "Level" }] },
    ],
    [
      "read access",
      { ...lightService, properties: [on, { ...brightness, access: ["read", "write"] }] },
    ],
    [
      "numeric grid",
      { ...lightService, properties: [on, { ...brightness, "value-range": [1, 101, 1] }] },
    ],
  ])("changes identity when the selected %s changes", (_case, service) => {
    expect(resolveMijiaCommand(light, snapshot([service])).identity).not.toBe(
      resolveMijiaCommand(light, snapshot()).identity,
    );
  });

  it("changes identity when the device is renamed", () => {
    const current = snapshot();
    const devices = [{ ...lightDevice, name: "Desk lamp" }];
    expect(
      resolveMijiaCommand(light, { ...current, inventory: { ...current.inventory, devices } })
        .identity,
    ).not.toBe(resolveMijiaCommand(light, current).identity);
  });

  it("changes identity when ordered action input references change", () => {
    const another = { ...brightness, iid: 6 };
    const service = (refs: number[]) => ({
      ...lightService,
      properties: [brightness, another],
      actions: [{ iid: 2, description: "Adjust", in: refs }],
    });
    const request = { ...action, inputs: [40, 40] };
    expect(resolveMijiaCommand(request, snapshot([service([2, 6])])).identity).not.toBe(
      resolveMijiaCommand(request, snapshot([service([6, 2])])).identity,
    );
  });
});
