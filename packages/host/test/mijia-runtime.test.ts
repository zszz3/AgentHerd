import { EventEmitter, once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { expect, it, type TestContext, vi } from "vitest";
import * as runtime from "../src/mijia-runtime.ts";
import { stdioClient } from "../src/plugin-mcp.ts";

it("stops a direct worker if a call times out", async () => {
  const client = stdioClient({
    command: process.execPath,
    args: [
      "-e",
      `
      require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
        const message = JSON.parse(line);
        if (message.method === 'initialize') {
          console.log(JSON.stringify({ id: message.id, result: { serverInfo: { name: 'fixture', version: '1' } } }));
        } else if (message.params?.name === 'ping') {
          console.log(JSON.stringify({ id: message.id, result: 'alive' }));
        }
      });
    `,
    ],
    env: {},
    cwd: tmpdir(),
    direct: { timeout: 600, maxLine: 2048, server: { name: "fixture", version: "1" } },
  });
  try {
    expect(await client.call("ping", {})).toBe("alive");
    await expect(client.call("hang", {})).rejects.toThrow();
    await expect(client.call("ping", {})).rejects.toThrow();
  } finally {
    await client.closeAndWait();
  }
});

it("rejects non-PNG QR responses and disables redirects", async () => {
  const { mijiaPicture } = await import("../src/mijia-runtime.ts");
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("not a PNG"));
  await expect(mijiaPicture("https://account.xiaomi.com/pass/qr/fixture", fetch)).rejects.toThrow(
    "not a PNG",
  );
  expect(fetch).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ redirect: "error" }),
  );
});

const descriptorUrn = "urn:miot-spec-v2:device:light:0000A001:fixture-lamp:1";
const descriptorUrl =
  "https://miot-spec.org/miot-spec-v2/instance?type=urn%3Amiot-spec-v2%3Adevice%3Alight%3A0000A001%3Afixture-lamp%3A1";

async function descriptorServer({ onTestFinished }: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  onTestFinished(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

function descriptorFetch(origin: string): typeof fetch {
  return (input, init) => {
    expect(String(input)).toBe(descriptorUrl);
    return fetch(`${origin}/descriptor`, init);
  };
}

it("parses a descriptor at the decoded byte limit", async (context) => {
  const type = descriptorUrn;
  const padding = "é".repeat(100_000);
  const descriptor = { type, padding };
  const json = JSON.stringify(descriptor);
  const body = json.padEnd(json.length + 512 * 1024 - Buffer.byteLength(json));
  const origin = await descriptorServer(context, (_req, res) => res.end(body));

  expect(runtime.mijiaDescriptor).toBeTypeOf("function");
  await expect(runtime.mijiaDescriptor(type, descriptorFetch(origin))).resolves.toEqual(descriptor);
});

it.each([
  ["URL instead of a URN", "https://example.invalid"],
  ["non-device URN", "urn:miot-spec-v2:service:light:0000A001"],
  ["query delimiter", `${descriptorUrn}&extra=1`],
  ["newline suffix", `${descriptorUrn}\n`],
  ["overlong URN", `urn:miot-spec-v2:device:light:${"x".repeat(229)}`],
])("rejects an invalid descriptor URN (%s) before fetching", async (_name, urn) => {
  const fetchFn = vi.fn<typeof fetch>();

  expect(runtime.mijiaDescriptor).toBeTypeOf("function");
  await expect(runtime.mijiaDescriptor(urn, fetchFn)).rejects.toThrow("invalid device URN");
  expect(fetchFn).not.toHaveBeenCalled();
});

it("rejects a 307 on headers without following it or leaving its body open", async (context) => {
  const responseEvents = new EventEmitter();
  const responseClosed = once(responseEvents, "closed");
  const paths: Array<string | undefined> = [];
  const origin = await descriptorServer(context, (req, res) => {
    paths.push(req.url);
    if (req.url === "/descriptor") {
      res.once("close", () => responseEvents.emit("closed"));
      res.writeHead(307, { Location: "/redirect-target" });
      // Keep the body unfinished so draining it would block.
      res.write("partial redirect body");
    } else {
      res.end("{}");
    }
  });

  expect(runtime.mijiaDescriptor).toBeTypeOf("function");
  await expect(runtime.mijiaDescriptor(descriptorUrn, descriptorFetch(origin))).rejects.toThrow(
    "descriptor was unavailable",
  );
  await responseClosed;
  expect(paths).toEqual(["/descriptor"]);
});

it("rejects a successful status other than 200", async (context) => {
  const origin = await descriptorServer(context, (_req, res) => {
    res.writeHead(201);
    res.end(JSON.stringify({ type: descriptorUrn }));
  });

  expect(runtime.mijiaDescriptor).toBeTypeOf("function");
  await expect(runtime.mijiaDescriptor(descriptorUrn, descriptorFetch(origin))).rejects.toThrow(
    "descriptor was unavailable",
  );
});

it("rejects a gzipped descriptor one decoded byte over the limit", async (context) => {
  const json = JSON.stringify({ type: descriptorUrn });
  const wire = gzipSync(json.padEnd(512 * 1024 + 1));
  const origin = await descriptorServer(context, (_req, res) => {
    res.writeHead(200, { "Content-Encoding": "gzip", "Content-Length": wire.length });
    res.end(wire);
  });

  expect(runtime.mijiaDescriptor).toBeTypeOf("function");
  await expect(runtime.mijiaDescriptor(descriptorUrn, descriptorFetch(origin))).rejects.toThrow(
    "descriptor was too large",
  );
});

it("aborts a stalled descriptor body with the same deadline set before fetch", async (context) => {
  const responseEvents = new EventEmitter();
  const responseClosed = once(responseEvents, "closed");
  const origin = await descriptorServer(context, (_req, res) => {
    res.once("close", () => responseEvents.emit("closed"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"type":');
  });
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  context.onTestFinished(() => {
    timeout.mockRestore();
  });
  const deadlineError = new DOMException("test deadline elapsed", "TimeoutError");
  const localFetch = descriptorFetch(origin);
  const fetchFn: typeof fetch = async (input, init) => {
    expect(timeout.mock.calls).toEqual([[8000]]);
    expect(init?.signal).toBe(deadline.signal);
    const response = await localFetch(input, init);
    // Trigger the deadline only after Node Fetch has delivered real body bytes.
    const body = response.body;
    if (!body) throw new Error("expected a response body");
    const getReader = body.getReader.bind(body);
    Object.defineProperty(body, "getReader", {
      value: () => {
        const reader = getReader();
        const read = reader.read.bind(reader);
        let receivedBytes = false;
        reader.read = async () => {
          const pending = read();
          if (receivedBytes) deadline.abort(deadlineError);
          const result = await pending;
          receivedBytes = !result.done && result.value.byteLength > 0;
          return result;
        };
        return reader;
      },
    });
    return response;
  };

  expect(runtime.mijiaDescriptor).toBeTypeOf("function");
  await expect(runtime.mijiaDescriptor(descriptorUrn, fetchFn)).rejects.toMatchObject({
    name: "TimeoutError",
  });
  expect(timeout.mock.calls).toEqual([[8000]]);
  await responseClosed;
});
