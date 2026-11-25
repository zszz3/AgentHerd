import { expect, it, vi } from "vitest";
import { type ControlOrigin, MijiaControl } from "../src/mijia-control.ts";
import type { ControlInventory, ControlRequest } from "../src/mijia-control-types.ts";
import type { MijiaControlWorker } from "../src/mijia-control-worker.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const urn = "urn:miot-spec-v2:device:light:0000A001:fixture:1";
const light = {
  kind: "property",
  homeId: "home-1",
  deviceId: "lamp-1",
  siid: 2,
  piid: 3,
  value: true,
} satisfies ControlRequest;
const action = {
  kind: "action",
  homeId: "home-1",
  deviceId: "lamp-1",
  siid: 2,
  aiid: 4,
  inputs: [true],
} satisfies ControlRequest;
const scene = { kind: "scene", homeId: "home-1", sceneId: "scene-1" } satisfies ControlRequest;
const device = {
  homeId: "home-1",
  deviceId: "lamp-1",
  urn,
  home: "Home",
  room: "Den",
  name: "Lamp",
  sharedOnly: false,
};
const inventory: ControlInventory = {
  devices: [device],
  scenes: [{ homeId: "home-1", sceneId: "scene-1", home: "Home", name: "Good night" }],
};
const descriptor = (access = ["read", "write"], description = "Power", type = urn) => ({
  type,
  services: [
    {
      iid: 2,
      description: "Light",
      properties: [{ iid: 3, description, format: "bool", access }],
      actions: [
        { iid: 4, description: "Apply power", in: [3] },
        { iid: 5, description: "Reset", in: [] },
      ],
    },
  ],
});

function fixture() {
  const worker = {
    inventory: vi.fn<MijiaControlWorker["inventory"]>().mockResolvedValue(inventory),
    descriptor: vi.fn<MijiaControlWorker["descriptor"]>().mockResolvedValue(descriptor()),
    mutate: vi.fn<MijiaControlWorker["mutate"]>().mockResolvedValue("acknowledged"),
    readProperty: vi.fn<MijiaControlWorker["readProperty"]>().mockResolvedValue(true),
  } satisfies MijiaControlWorker;
  let session = {};
  const clock = { wall: 1_700_000_000_000, mono: 0 };
  const audit = vi.fn();
  const control = new MijiaControl({
    current: () => ({ session, worker }),
    clock: { wall: () => clock.wall, monotonic: () => clock.mono },
    audit,
  });
  const origin: ControlOrigin = { kind: "desktop", key: {} };
  return {
    control,
    worker,
    origin,
    clock,
    audit,
    replaceScan: () => {
      session = {};
    },
  };
}

it("copies and validates the request before the first await and does not send during preview", async () => {
  const { control, worker, origin } = fixture();
  const read = deferred<ControlInventory>();
  worker.inventory.mockReturnValueOnce(read.promise);
  const input = { ...action, inputs: [true] };
  const pending = control.prepare(origin, input);
  input.deviceId = "other";
  input.inputs[0] = false;
  read.resolve(inventory);
  const proposal = await pending;
  expect(proposal.preview).toEqual({
    home: "Home",
    room: "Den",
    target: "Lamp",
    operation: "Action: Light: Apply power",
    arguments: [{ label: "Power", value: true }],
    sceneWarning: false,
  });
  expect(worker.mutate).not.toHaveBeenCalled();
  proposal.preview.target = "Altered";
  Object.assign(proposal.preview.arguments[0], { value: false });
  expect(await control.confirm(origin, proposal.id)).toEqual({ state: "acknowledged" });
  expect(worker.mutate.mock.calls).toEqual([[action]]);
  expect(worker.readProperty).not.toHaveBeenCalled();
});

it("rejects unexpected fields before touching the worker", async () => {
  const { control, worker, origin } = fixture();
  await expect(control.prepare(origin, { ...light, home: "not a stable ID" })).rejects.toThrow(
    "Invalid control request",
  );
  expect(worker.inventory).not.toHaveBeenCalled();
});

it("does not reveal or revoke a proposal for another origin", async () => {
  const { control, worker, origin } = fixture();
  const proposal = await control.prepare(origin, light);
  const other = { kind: origin.kind, key: {} };
  expect(await control.confirm(other, proposal.id)).toEqual(
    await control.confirm(other, "missing"),
  );
  control.cancel(other, proposal.id);
  expect(worker.mutate).not.toHaveBeenCalled();
  expect(await control.confirm(origin, proposal.id)).toEqual({ state: "verified" });
});

it("expires at the exact monotonic deadline despite a backward wall-clock change", async () => {
  const { control, worker, origin, clock } = fixture();
  const proposal = await control.prepare(origin, light);
  expect(proposal.expiresAt).toBe(1_700_000_300_000);
  clock.wall -= 60 * 60_000;
  clock.mono += 5 * 60_000;
  expect(await control.confirm(origin, proposal.id)).toEqual({
    state: "not-sent",
    reason: "expired",
  });
  expect(await control.confirm(origin, proposal.id)).toEqual({
    state: "not-sent",
    reason: "cancelled",
  });
  expect(worker.mutate).not.toHaveBeenCalled();
});

it("cleans up an expired ID while retaining an origin-scoped expiry result", async () => {
  vi.useFakeTimers();
  try {
    const { control, worker, origin, clock } = fixture();
    const proposal = await control.prepare(origin, light);
    expect(vi.getTimerCount()).toBe(1);
    clock.mono += 5 * 60_000;
    vi.advanceTimersByTime(5 * 60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(await control.confirm({ kind: "task", key: origin.key }, proposal.id)).toEqual({
      state: "not-sent",
      reason: "cancelled",
    });
    expect(await control.confirm(origin, proposal.id)).toEqual({
      state: "not-sent",
      reason: "expired",
    });
    expect(worker.inventory).toHaveBeenCalledOnce();
    expect(worker.mutate).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("uses the monotonic clock, not a forward wall-clock change", async () => {
  const { control, worker, origin, clock } = fixture();
  const proposal = await control.prepare(origin, light);
  clock.wall += 60 * 60_000;
  clock.mono += 5 * 60_000 - 1;
  expect(await control.confirm(origin, proposal.id)).toEqual({ state: "verified" });
  expect(worker.mutate.mock.calls).toEqual([[light]]);
});

it.each(["name", "home", "home membership", "spec", "shared-only"])(
  "requires a new confirmation after a change to %s",
  async (change) => {
    const { control, worker, origin } = fixture();
    const proposal = await control.prepare(origin, light);
    if (change === "spec") worker.descriptor.mockResolvedValue(descriptor(["write"]));
    else {
      const patch = {
        name: { name: "Renamed" },
        home: { home: "Renamed home" },
        "home membership": { homeId: "home-2" },
        "shared-only": { sharedOnly: true },
      }[change];
      worker.inventory.mockResolvedValue({ ...inventory, devices: [{ ...device, ...patch }] });
    }
    expect(await control.confirm(origin, proposal.id)).toEqual({
      state: "not-sent",
      reason: "stale",
    });
    expect(worker.mutate).not.toHaveBeenCalled();
  },
);

it.each(["cancelled", "expired", "stale"] as const)(
  "returns %s without requesting a descriptor when invalidated during the fresh inventory read",
  async (reason) => {
    const { control, worker, origin, clock, replaceScan } = fixture();
    const proposal = await control.prepare(origin, light);
    const read = deferred<ControlInventory>();
    worker.inventory.mockReturnValueOnce(read.promise);
    const confirming = control.confirm(origin, proposal.id);
    if (reason === "cancelled") control.cancel(origin, proposal.id);
    if (reason === "expired") clock.mono += 5 * 60_000;
    if (reason === "stale") replaceScan();
    read.resolve(inventory);
    expect(await confirming).toEqual({ state: "not-sent", reason });
    expect(worker.descriptor).toHaveBeenCalledOnce();
    expect(worker.mutate).not.toHaveBeenCalled();
  },
);

it("checks the session after a delayed fresh descriptor before calling the policy hook", async () => {
  const { control, worker, origin, replaceScan } = fixture();
  const proposal = await control.prepare(origin, light);
  const descriptorStarted = deferred<void>();
  const read = deferred<unknown>();
  worker.descriptor.mockImplementationOnce(() => {
    descriptorStarted.resolve();
    return read.promise;
  });
  const policy = vi.fn();
  const confirming = control.confirm(origin, proposal.id, policy);
  await descriptorStarted.promise;
  replaceScan();
  read.reject(new Error("untrusted descriptor detail"));
  expect(await confirming).toEqual({ state: "not-sent", reason: "stale" });
  expect(policy).not.toHaveBeenCalled();
  expect(worker.mutate).not.toHaveBeenCalled();
});

it.each(["cancelled", "revoked", "expired", "stale", "blocked"] as const)(
  "fails closed when the synchronous policy hook leaves the proposal %s",
  async (change) => {
    const { control, worker, origin, clock, replaceScan, audit } = fixture();
    const proposal = await control.prepare(origin, light);
    expect(
      await control.confirm(origin, proposal.id, () => {
        if (change === "cancelled") control.cancel(origin, proposal.id);
        if (change === "revoked") control.revoke(origin);
        if (change === "expired") clock.mono += 5 * 60_000;
        if (change === "stale") replaceScan();
        if (change === "blocked") throw new Error("untrusted policy detail");
      }),
    ).toEqual({ state: "not-sent", reason: change === "revoked" ? "cancelled" : change });
    expect(worker.mutate).not.toHaveBeenCalled();
    expect(await control.confirm(origin, proposal.id)).toEqual({
      state: "not-sent",
      reason: "cancelled",
    });
    expect(JSON.stringify(audit.mock.calls)).not.toContain("untrusted policy detail");
  },
);

it("consumes a task proposal without a policy hook and never sends it", async () => {
  const { control, worker, audit } = fixture();
  const task: ControlOrigin = { kind: "task", key: {} };
  const proposal = await control.prepare(task, light);

  expect(await control.confirm(task, proposal.id)).toEqual({
    state: "not-sent",
    reason: "blocked",
  });
  expect(worker.mutate).not.toHaveBeenCalled();

  const policy = vi.fn();
  expect(await control.confirm(task, proposal.id, policy)).toEqual({
    state: "not-sent",
    reason: "cancelled",
  });
  expect(policy).not.toHaveBeenCalled();
  expect(worker.mutate).not.toHaveBeenCalled();
  expect(audit.mock.calls).toEqual([
    [{ id: proposal.id, operation: "property", decision: "not-sent", outcome: "blocked" }],
  ]);
});

it("sends a task proposal once after its synchronous policy hook passes", async () => {
  const { control, worker } = fixture();
  const task: ControlOrigin = { kind: "task", key: {} };
  const proposal = await control.prepare(task, light);
  const policy = vi.fn();

  expect(await control.confirm(task, proposal.id, policy)).toEqual({ state: "verified" });
  expect(policy).toHaveBeenCalledOnce();
  expect(policy).toHaveBeenCalledBefore(worker.mutate);
  expect(worker.mutate.mock.calls).toEqual([[light]]);
});

it("fails closed if a caller mistakenly supplies an asynchronous policy", async () => {
  const { control, origin, worker } = fixture();
  const proposal = await control.prepare(origin, light);
  const confirm = control.confirm(origin, proposal.id, async () => {
    throw new Error("untrusted policy detail");
  });
  expect(await confirm).toEqual({ state: "not-sent", reason: "blocked" });
  expect(worker.mutate).not.toHaveBeenCalled();
});

it("rejects a prepare that is in flight when its origin is revoked", async () => {
  const { control, worker, origin } = fixture();
  const read = deferred<ControlInventory>();
  worker.inventory.mockReturnValueOnce(read.promise);
  const preparing = control.prepare(origin, light);
  control.revoke(origin);
  read.resolve(inventory);
  await expect(preparing).rejects.toThrow("Mi Home control unavailable");
  expect(worker.descriptor).not.toHaveBeenCalled();
  expect(worker.mutate).not.toHaveBeenCalled();
});

it("reserves before the first confirm await and never queues another ID", async () => {
  const { control, worker, origin } = fixture();
  const one = await control.prepare(origin, light);
  const two = await control.prepare(origin, { ...light, value: false });
  const receipt = deferred<"acknowledged">();
  const dispatched = deferred<void>();
  worker.mutate.mockImplementationOnce(() => {
    dispatched.resolve();
    return receipt.promise;
  });
  const first = control.confirm(origin, one.id);
  expect(await control.confirm(origin, one.id)).toEqual({ state: "not-sent", reason: "busy" });
  await dispatched.promise;
  expect(await control.confirm(origin, one.id)).toEqual({ state: "not-sent", reason: "cancelled" });
  expect(await control.confirm(origin, two.id)).toEqual({ state: "not-sent", reason: "busy" });
  receipt.resolve("acknowledged");
  expect(await first).toEqual({ state: "verified" });
  expect(worker.mutate.mock.calls).toEqual([[light]]);
});

it("holds the session slot through read-back even after revoking the dispatched origin", async () => {
  const { control, worker, origin } = fixture();
  const other: ControlOrigin = { kind: "task", key: {} };
  const one = await control.prepare(origin, light);
  const two = await control.prepare(other, { ...light, value: false });
  const read = deferred<boolean>();
  const reading = deferred<void>();
  worker.readProperty.mockImplementationOnce(() => {
    reading.resolve();
    return read.promise;
  });
  const first = control.confirm(origin, one.id);
  await reading.promise;
  control.revoke(origin);
  expect(await control.confirm(other, two.id)).toEqual({ state: "not-sent", reason: "busy" });
  read.resolve(true);
  expect(await first).toEqual({ state: "verified" });
  expect(worker.mutate.mock.calls).toEqual([[light]]);
});

it.each([
  [true, { state: "verified" }],
  [false, { state: "mismatch", actual: false }],
  [undefined, { state: "acknowledged" }],
] as const)("reports a read-back of %s without replaying", async (actual, expected) => {
  const { control, worker, origin } = fixture();
  worker.readProperty.mockResolvedValue(actual);
  const proposal = await control.prepare(origin, light);
  expect(await control.confirm(origin, proposal.id)).toEqual(expected);
  expect(worker.readProperty.mock.calls).toEqual([[light]]);
  expect(worker.mutate.mock.calls).toEqual([[light]]);
});

it.each(["read failure", "reconnect before read", "reconnect during read"])(
  "keeps acknowledgement without a current observation on %s",
  async (change) => {
    const { control, worker, origin, replaceScan } = fixture();
    if (change === "read failure") worker.readProperty.mockRejectedValue(new Error("bad read"));
    if (change === "reconnect before read") {
      worker.mutate.mockImplementationOnce(async () => {
        replaceScan();
        return "acknowledged";
      });
    }
    if (change === "reconnect during read") {
      worker.readProperty.mockImplementationOnce(async () => {
        replaceScan();
        return true;
      });
    }
    const proposal = await control.prepare(origin, light);
    expect(await control.confirm(origin, proposal.id)).toEqual({ state: "acknowledged" });
    expect(worker.readProperty).toHaveBeenCalledTimes(change === "reconnect before read" ? 0 : 1);
    expect(worker.mutate.mock.calls).toEqual([[light]]);
  },
);

it.each([light, { ...action, aiid: 5, inputs: [] }, scene] as const)(
  "acknowledges but never reads back $kind without a readable property",
  async (request) => {
    const { control, worker, origin } = fixture();
    worker.descriptor.mockResolvedValue(descriptor(["write"]));
    const proposal = await control.prepare(origin, request);
    expect(proposal.preview.sceneWarning).toBe(request.kind === "scene");
    expect(await control.confirm(origin, proposal.id)).toEqual({ state: "acknowledged" });
    expect(worker.readProperty).not.toHaveBeenCalled();
    expect(worker.mutate.mock.calls).toEqual([[request]]);
  },
);

it.each(["rejected", "unknown", "timeout", "parser threw"] as const)(
  "does not read back or replay after %s",
  async (receipt) => {
    const { control, worker, origin, audit } = fixture();
    if (receipt === "rejected" || receipt === "unknown") worker.mutate.mockResolvedValue(receipt);
    else if (receipt === "timeout") worker.mutate.mockRejectedValue(new Error("untrusted timeout"));
    else
      worker.mutate.mockImplementation(() => {
        throw new Error("untrusted parser detail");
      });
    const proposal = await control.prepare(origin, light);
    const state = receipt === "rejected" ? "rejected" : "unknown";
    expect(await control.confirm(origin, proposal.id)).toEqual({ state });
    expect(await control.confirm(origin, proposal.id)).toEqual({
      state: "not-sent",
      reason: "cancelled",
    });
    expect(worker.readProperty).not.toHaveBeenCalled();
    expect(worker.mutate.mock.calls).toEqual([[light]]);
    expect(audit.mock.calls).toContainEqual([
      { id: proposal.id, operation: "property", decision: "dispatched", outcome: state },
    ]);
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/untrusted|lamp-1|Home|Power/);
  },
);

it("uses current inventory and caches capabilities by session and monotonic time with isolated output", async () => {
  const { control, worker, clock, replaceScan } = fixture();
  expect(await control.inventory()).toEqual(inventory);
  const first = await control.capabilities("home-1", "lamp-1");
  Object.assign(first.services[0], { label: "Altered" });
  const second = await control.capabilities("home-1", "lamp-1");
  expect(second.services[0]?.label).toBe("Light");
  expect(worker.descriptor).toHaveBeenCalledTimes(1);
  clock.mono += 5 * 60_000;
  await control.capabilities("home-1", "lamp-1");
  expect(worker.descriptor).toHaveBeenCalledTimes(2);
  replaceScan();
  await control.capabilities("home-1", "lamp-1");
  expect(worker.descriptor).toHaveBeenCalledTimes(3);
  expect(worker.inventory).toHaveBeenCalledTimes(5);
});
