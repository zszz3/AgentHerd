import { parentPort, workerData } from "node:worker_threads";
import { type LocationContext, LocationError } from "@agentherd/host/data-location";
import { applyLocationRequest } from "@agentherd/host/location-apply";

const port = parentPort;
if (port === null) throw new Error("Expected a data-directory worker.");
const ctx: LocationContext = workerData;
try {
  const result = await applyLocationRequest(ctx, (files) => port.postMessage({ files }));
  port.postMessage({ result });
} catch (error) {
  port.postMessage({
    error: error instanceof LocationError ? error.code : "location-error",
    // Gate and filesystem messages name only local paths and the failed check.
    message: error instanceof Error ? error.message : String(error),
  });
}
