import type { ApplyFailure } from "@agentherd/host/location-apply";

export type RecoveryChoice = "retry" | "previous" | "pick";

export interface DataDirectoryView {
  state: "starting" | "ready" | "override" | "unavailable" | "moving" | "failed";
  home?: string;
  previous?: string;
  canCopy: boolean;
  failure?: ApplyFailure;
}

export type DataDirectoryResult =
  | { ok: true; state: "cancelled" | "restarting" | "recovered" }
  | { ok: false; code: string };

export interface DataDirectoryBridge {
  status(): Promise<DataDirectoryView>;
  change(): Promise<DataDirectoryResult>;
  recover(choice: RecoveryChoice): Promise<DataDirectoryResult>;
  onProgress(cb: (files: number) => void): () => void;
}
