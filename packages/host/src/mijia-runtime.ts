import { statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { MijiaRuntime } from "./mijia-account.ts";
import { stdioClient } from "./plugin-mcp.ts";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_QR_BYTES = 512 * 1024;
const MAX_DESCRIPTOR_BYTES = 512 * 1024;
const DEVICE_URN =
  /^urn:miot-spec-v2:device:[a-zA-Z0-9_.-]+:[a-zA-Z0-9_.-]+(?::[a-zA-Z0-9_.-]+){0,3}$/;
const WORKER = fileURLToPath(new URL("../bin/mijia-worker.py", import.meta.url));

export async function mijiaPicture(url: string, fetchFn = fetch): Promise<string> {
  const response = await fetchFn(url, { redirect: "error", signal: AbortSignal.timeout(8000) });
  if (!response.ok || !response.body) throw new Error("the QR image was unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_QR_BYTES) throw new Error("the QR image was too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const image = Buffer.concat(chunks);
  if (!image.subarray(0, PNG.length).equals(PNG)) throw new Error("the QR image was not a PNG");
  return `data:image/png;base64,${image.toString("base64")}`;
}

export async function mijiaDescriptor(urn: string, fetchFn = fetch): Promise<unknown> {
  if (typeof urn !== "string" || urn.length > 256 || !DEVICE_URN.test(urn)) {
    throw new Error("invalid device URN");
  }
  const url = new URL("https://miot-spec.org/miot-spec-v2/instance");
  url.searchParams.set("type", urn);
  const signal = AbortSignal.timeout(8000);
  const { body, status } = await fetchFn(url, { redirect: "manual", signal });
  if (status !== 200 || !body) {
    await body?.cancel().catch(() => {});
    throw new Error("the descriptor was unavailable");
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Node Fetch yields decoded bytes, even when Content-Length describes a compressed body.
      size += value.byteLength;
      if (size > MAX_DESCRIPTOR_BYTES) throw new Error("the descriptor was too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
}

export function mijiaRuntime(python: string | undefined): MijiaRuntime | undefined {
  if (
    python === undefined ||
    !isAbsolute(python) ||
    !statSync(python, { throwIfNoEntry: false })?.isFile()
  ) {
    return undefined;
  }
  return {
    picture: mijiaPicture,
    descriptor: mijiaDescriptor,
    open(authPath, onFailure) {
      const dir = dirname(authPath);
      const env: Record<string, string> = {
        HOME: dir,
        USERPROFILE: dir,
        APPDATA: dir,
        LOCALAPPDATA: dir,
      };
      if (process.env.SystemRoot !== undefined) env.SystemRoot = process.env.SystemRoot;
      const client = stdioClient({
        command: python,
        args: ["-I", "-X", "utf8", WORKER, authPath],
        cwd: dir,
        env,
        direct: {
          timeout: 20_000,
          maxLine: 2 * 1024 * 1024,
          server: { name: "mijia-api", version: "5.0.0" },
          onFailure,
        },
      });
      return { call: client.call, close: client.closeAndWait };
    },
  };
}
