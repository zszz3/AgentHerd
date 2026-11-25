export type Scalar = boolean | number | string;

export type ControlRequest =
  | {
      kind: "property";
      homeId: string;
      deviceId: string;
      siid: number;
      piid: number;
      value: Scalar;
    }
  | {
      kind: "action";
      homeId: string;
      deviceId: string;
      siid: number;
      aiid: number;
      inputs: readonly Scalar[];
    }
  | { kind: "scene"; homeId: string; sceneId: string };

export interface ControlPreview {
  home: string;
  room?: string;
  target: string;
  operation: string;
  arguments: readonly { label: string; value: Scalar; display?: string }[];
  sceneWarning: boolean;
}

export interface ControlProposal {
  id: string;
  expiresAt: number;
  preview: ControlPreview;
}

export type ControlOutcome =
  | { state: "verified" }
  | { state: "acknowledged" }
  | { state: "mismatch"; actual: Scalar }
  | { state: "rejected" }
  | { state: "unknown" }
  | { state: "not-sent"; reason: "stale" | "expired" | "cancelled" | "blocked" | "busy" };

export interface ControlDevice {
  readonly homeId: string;
  readonly deviceId: string;
  readonly urn: string;
  readonly home: string;
  readonly room?: string;
  readonly name: string;
  readonly sharedOnly: boolean;
}

export interface ControlScene {
  readonly homeId: string;
  readonly sceneId: string;
  readonly home: string;
  readonly name: string;
}

export interface ControlInventory {
  readonly devices: readonly ControlDevice[];
  readonly scenes: readonly ControlScene[];
}

export type NumericFormat = "int8" | "uint8" | "int16" | "uint16" | "int32" | "uint32" | "float";

export interface PropertyControl {
  readonly piid: number;
  readonly label: string;
  readonly readable: boolean;
  readonly writable: boolean;
  readonly format: "bool" | "string" | NumericFormat;
  readonly range?: readonly [min: number, max: number, step: number];
  readonly choices?: readonly { readonly value: Scalar; readonly label: string }[];
}

export interface ActionControl {
  readonly aiid: number;
  readonly label: string;
  readonly inputs: readonly PropertyControl[];
}

export interface ServiceControls {
  readonly siid: number;
  readonly label: string;
  readonly properties: readonly PropertyControl[];
  readonly actions: readonly ActionControl[];
}

/** Serializable public descriptor. Member IDs are scoped to their service. */
export interface DeviceControls {
  readonly urn: string;
  readonly services: readonly ServiceControls[];
}

export interface ControlSnapshot {
  readonly inventory: ControlInventory;
  readonly descriptors: ReadonlyMap<string, DeviceControls>;
}

export interface ResolvedCommand {
  readonly request: ControlRequest;
  readonly preview: ControlPreview;
  readonly identity: string;
}
