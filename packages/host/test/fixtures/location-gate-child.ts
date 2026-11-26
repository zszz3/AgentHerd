import {
  acquireLocationLease,
  type LocationLease,
  type LocationMode,
} from "../../src/location-gate.ts";

const [base, mode] = process.argv.slice(2);
if (!base || (mode !== "shared" && mode !== "exclusive")) throw new Error("Expected base and mode");

function run(base: string, mode: LocationMode): void {
  let lease: LocationLease | undefined;
  process.on("message", (message: unknown) => {
    if (message === "acquire") {
      try {
        lease = acquireLocationLease(base, mode);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("in use")) throw error;
        process.send?.("busy");
        process.disconnect();
        return;
      }
      process.send?.("held");
    } else if (message === "release") {
      if (!lease) throw new Error("No lease to release");
      lease.release();
      process.disconnect();
    }
  });
  process.on("disconnect", () => lease?.release());
  process.send?.("ready");
}

run(base, mode);
