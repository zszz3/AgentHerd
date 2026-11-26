import type {
  ControlInventory,
  ControlProposal,
  ControlRequest,
  DesktopControlOutcome,
  DeviceControls,
  MijiaDesktopBridge,
  PropertyControl,
  Scalar,
} from "@agentherd/host/api";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { Bridge } from "../../../shared/bridge";

const field = "rounded border border-line bg-surface px-2 py-1 text-ink";
const button = `${field} disabled:opacity-50`;
const unavailable = "桌面控制不可用：需要由此桌面应用启动的本地 Host；仍可查看设备列表。";
const unknown = "结果未知。请先检查设备，未自动重试。";
const outcomes: Record<DesktopControlOutcome["state"], string> = {
  verified: "已执行并核实。",
  acknowledged: "已收到执行回执，未核实结果。",
  mismatch: "已收到执行回执，但设备状态与预览不一致。",
  rejected: "设备拒绝了此操作。",
  unknown,
  "not-sent": "操作未发送。若仍需要操作，请重新预览。",
};

type Choice = {
  key: string;
  label: string;
  fields: readonly PropertyControl[];
  request(values: readonly Scalar[]): ControlRequest;
};

// Renderer memory only: the warning survives keyed panels and settings navigation, not reload.
let uncertain = false;
const outcomeListeners = new Set<() => void>();
function subscribeOutcome(listener: () => void) {
  outcomeListeners.add(listener);
  return () => {
    outcomeListeners.delete(listener);
  };
}
function setUncertain(value: boolean) {
  if (uncertain === value) return;
  uncertain = value;
  for (const listener of outcomeListeners) listener();
}

export function MijiaUncertainOutcome() {
  const visible = useSyncExternalStore(
    subscribeOutcome,
    () => uncertain,
    () => false,
  );
  return (
    visible && (
      <div className="space-y-2 text-sm">
        <p role="alert">{unknown}</p>
        <button className={button} type="button" onClick={() => setUncertain(false)}>
          关闭提示
        </button>
      </div>
    )
  );
}

export function MijiaControls({
  bridge,
  showOutcome = true,
}: {
  bridge: Bridge;
  showOutcome?: boolean;
}) {
  const [document, setDocument] = useState({ ready: false, generation: 0 });
  const control = bridge.mijiaControl;
  useEffect(() => {
    let revision = 0;
    const refresh = () => {
      const generation = ++revision;
      setDocument({ generation, ready: false });
      void control
        ?.available()
        .then((ready) => {
          if (revision === generation) setDocument({ generation, ready });
        })
        .catch(() => {});
    };
    const unsubscribe = bridge.onMijiaControlChange?.(refresh);
    refresh();
    return () => {
      revision++;
      unsubscribe?.();
    };
  }, [bridge, control]);
  return (
    <section aria-label="米家桌面控制" className="space-y-2 text-sm">
      <h3 className="font-medium text-ink">桌面控制</h3>
      {showOutcome && <MijiaUncertainOutcome />}
      {control && document.ready ? (
        <Panel key={document.generation} control={control} />
      ) : (
        <p>{unavailable}</p>
      )}
    </section>
  );
}

function Panel({ control }: { control: MijiaDesktopBridge }) {
  const [data, setData] = useState<ControlInventory>();
  const [error, setError] = useState(false);
  const [target, setTarget] = useState("");
  useEffect(() => {
    let current = true;
    void control.inventory().then(
      (result) => {
        if (current) setData(result);
      },
      () => {
        if (current) setError(true);
      },
    );
    return () => {
      current = false;
    };
  }, [control]);
  const identifier = useId();
  if (error) return <p role="status">无法读取控制清单。仍可查看设备列表。</p>;
  if (!data) return <p role="status">正在读取控制清单…</p>;
  const entries = [
    ...data.devices.map((device) => ({
      device,
      key: JSON.stringify(["device", device.homeId, device.deviceId]),
      label: [device.home, device.room, device.name].filter(Boolean).join(" · "),
    })),
    ...data.scenes.map((scene) => ({
      scene,
      key: JSON.stringify(["scene", scene.homeId, scene.sceneId]),
      label: `${scene.home} · 场景：${scene.name}`,
    })),
  ];
  const selected = target === "" ? undefined : entries[Number(target)];
  const label = (entry: (typeof entries)[number], index: number) =>
    entries.some((other, i) => i !== index && other.label === entry.label)
      ? `${entry.label} (${index + 1})`
      : entry.label;
  return (
    <>
      <p>仅可操作已核验的设备功能和场景；其他设备仍可只读查看。</p>
      {entries.length > 0 && (
        <>
          <label htmlFor={identifier}>控制目标</label>{" "}
          <select
            id={identifier}
            className={field}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="">请选择设备或场景</option>
            {entries.map((entry, index) => (
              <option key={entry.key} value={index}>
                {label(entry, index)}
              </option>
            ))}
          </select>
        </>
      )}
      {selected && "device" in selected && (
        <Device key={target} control={control} {...selected.device} />
      )}
      {selected && "scene" in selected && (
        <Command
          key={target}
          control={control}
          choice={{
            key: selected.key,
            label: "运行场景",
            fields: [],
            request: () => ({
              kind: "scene",
              homeId: selected.scene.homeId,
              sceneId: selected.scene.sceneId,
            }),
          }}
        />
      )}
    </>
  );
}

function Device({
  control,
  homeId,
  deviceId,
}: {
  control: MijiaDesktopBridge;
  homeId: string;
  deviceId: string;
}) {
  const [descriptor, setDescriptor] = useState<DeviceControls>();
  const [error, setError] = useState(false);
  const [index, setIndex] = useState("");
  const identifier = useId();
  useEffect(() => {
    let current = true;
    void control.capabilities(homeId, deviceId).then(
      (result) => {
        if (current) setDescriptor(result);
      },
      () => {
        if (current) setError(true);
      },
    );
    return () => {
      current = false;
    };
  }, [control, homeId, deviceId]);
  if (error) return <p role="status">未能读取此设备的控制功能。</p>;
  if (!descriptor) return <p role="status">正在读取控制功能…</p>;
  const choices: Choice[] = descriptor.services.flatMap(({ siid, label, properties, actions }) => [
    ...properties
      .filter((property) => property.writable)
      .map(
        (property): Choice => ({
          key: `${siid}:property:${property.piid}`,
          label: `${label} · ${property.label}`,
          fields: [property],
          request: ([value]) => {
            if (value === undefined) throw new Error("Missing property value");
            return { kind: "property", homeId, deviceId, siid, piid: property.piid, value };
          },
        }),
      ),
    ...actions.map(
      (action): Choice => ({
        key: `${siid}:action:${action.aiid}`,
        label: `${label} · ${action.label}`,
        fields: action.inputs,
        request: (inputs) => ({
          kind: "action",
          homeId,
          deviceId,
          siid,
          aiid: action.aiid,
          inputs,
        }),
      }),
    ),
  ]);
  const choice = index === "" ? undefined : choices[Number(index)];
  if (!choices.length) return <p>此设备没有已核验的控制功能，仅可只读查看。</p>;
  return (
    <div className="space-y-2">
      <label htmlFor={identifier}>设备操作</label>{" "}
      <select
        id={identifier}
        className={field}
        value={index}
        onChange={(event) => setIndex(event.target.value)}
      >
        <option value="">请选择操作</option>
        {choices.map(({ key, label }, i) => (
          <option key={key} value={i}>
            {label}
          </option>
        ))}
      </select>
      {choice && <Command key={index} control={control} choice={choice} />}
    </div>
  );
}

function discard(control: MijiaDesktopBridge, proposal: ControlProposal | undefined) {
  if (proposal) void control.cancel(proposal.id).catch(() => {});
}

function Command({ control, choice }: { control: MijiaDesktopBridge; choice: Choice }) {
  const [values, setValues] = useState<readonly (Scalar | undefined)[]>([]);
  const [proposal, setProposal] = useState<ControlProposal>();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const live = useRef({
    mounted: false,
    busy: false,
    proposal: undefined as ControlProposal | undefined,
  });
  const identifier = useId();
  useEffect(() => {
    const state = live.current;
    state.mounted = true;
    return () => {
      state.mounted = false;
      if (!state.busy) discard(control, state.proposal);
      state.proposal = undefined;
    };
  }, [control]);
  const valid = choice.fields.every((_, i) => values[i] !== undefined);
  async function preview() {
    const state = live.current;
    if (!valid || state.busy || state.proposal) return;
    state.busy = true;
    setBusy(true);
    setStatus("");
    try {
      const result = await control.prepare(choice.request(values as readonly Scalar[]));
      if (state.mounted) {
        state.proposal = result;
        setProposal(result);
      } else discard(control, result);
    } catch {
      if (state.mounted) setStatus("无法预览此操作，未发送任何指令。");
    } finally {
      state.busy = false;
      if (state.mounted) setBusy(false);
    }
  }
  function cancel() {
    const state = live.current;
    if (state.busy) return;
    const previous = state.proposal;
    state.proposal = undefined;
    setProposal(undefined);
    discard(control, previous);
  }
  async function confirm() {
    const state = live.current;
    const previous = state.proposal;
    if (!previous || state.busy) return;
    state.busy = true;
    state.proposal = undefined;
    setProposal(undefined);
    setStatus("");
    setBusy(true);
    try {
      const result = await control.confirm(previous.id);
      if (result.state === "unknown") setUncertain(true);
      else if (state.mounted) setStatus(outcomes[result.state]);
    } catch {
      setUncertain(true);
    } finally {
      state.busy = false;
      if (state.mounted) setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      {choice.fields.map((property, i) => (
        <div key={property.piid}>
          <label htmlFor={`${identifier}-${i}`}>{property.label}</label>{" "}
          <ValueInput
            id={`${identifier}-${i}`}
            property={property}
            disabled={busy || proposal !== undefined}
            onValue={(value) => {
              if (live.current.busy || live.current.proposal) return;
              setValues((old) => Object.assign([...old], { [i]: value }));
            }}
          />
        </div>
      ))}
      <button
        className={button}
        type="button"
        disabled={!valid || busy || !!proposal}
        onClick={(event) => {
          if (event.isTrusted) void preview();
        }}
      >
        预览操作
      </button>
      {proposal && (
        <section aria-label="操作预览" className="space-y-2 rounded border border-line p-2">
          <p>
            {[proposal.preview.home, proposal.preview.room, proposal.preview.target]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <p>{proposal.preview.operation}</p>
          {proposal.preview.arguments.map(({ label, value, display }, i) => (
            // The Host-provided argument tuple is immutable for this proposal.
            // biome-ignore lint/suspicious/noArrayIndexKey: argument position is part of the tuple contract
            <p key={i}>
              {label}：{display === undefined ? String(value) : `${display} (${String(value)})`}
            </p>
          ))}
          {proposal.preview.sceneWarning && <p>场景可能执行多个操作，回执不能确认每一步的结果。</p>}
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={(event) => {
              if (event.isTrusted) void confirm();
            }}
          >
            确认
          </button>{" "}
          <button type="button" className={button} disabled={busy} onClick={cancel}>
            取消
          </button>
        </section>
      )}
      {status && <p role="status">{status}</p>}
    </div>
  );
}

function ValueInput({
  id,
  property,
  disabled,
  onValue,
}: {
  id: string;
  property: PropertyControl;
  disabled: boolean;
  onValue(value: Scalar | undefined): void;
}) {
  const choices =
    property.choices ??
    (property.format === "bool"
      ? [
          { label: "开启", value: true },
          { label: "关闭", value: false },
        ]
      : undefined);
  if (choices)
    return (
      <select
        id={id}
        className={field}
        disabled={disabled}
        onChange={(event) => {
          const value = event.target.value;
          onValue(value === "" ? undefined : choices[Number(value)]?.value);
        }}
      >
        <option value="">请选择</option>
        {choices.map(({ label, value }, i) => (
          <option key={JSON.stringify(value)} value={i}>
            {label}
          </option>
        ))}
      </select>
    );
  return (
    <input
      id={id}
      className={field}
      type="number"
      disabled={disabled}
      min={property.range?.[0]}
      max={property.range?.[1]}
      step={property.range?.[2] ?? (property.format === "float" ? "any" : 1)}
      onChange={(event) => {
        const input = event.currentTarget;
        onValue(
          input.validity.valid && Number.isFinite(input.valueAsNumber)
            ? input.valueAsNumber
            : undefined,
        );
      }}
    />
  );
}
