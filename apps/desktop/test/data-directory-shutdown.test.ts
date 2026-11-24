import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostDataPaths } from "@agentherd/host/data-home-paths";
import { expect, test, vi } from "vitest";
import { ensureHost, stopOwnedHost } from "../src/main/host-process.ts";

const { probe, fork } = vi.hoisted(() => ({ probe: vi.fn(), fork: vi.fn() }));
vi.mock("@agentherd/host/server", () => ({ isHostRunning: probe }));
vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => import.meta.dirname },
  utilityProcess: { fork },
}));

test.each(["timeout", "post-failure"])(
  "detaches log writes before %s shutdown completes",
  async (mode) => {
    const home = mkdtempSync(join(tmpdir(), "herd-log-test-"));
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      postMessage() {
        if (mode === "post-failure") throw new Error("inert fixture");
      },
    });
    probe.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    fork.mockReturnValueOnce(child);
    try {
      await ensureHost(home, "fixture", () => false);
      child.stdout.emit("data", Buffer.from("before\n"));
      await stopOwnedHost(0);
      child.stdout.emit("data", Buffer.from("after\n"));
      child.stderr.emit("data", Buffer.from("after\n"));
      expect(child.kill).toHaveBeenCalledOnce();
      expect(readFileSync(join(home, hostDataPaths.hostLog.relative), "utf8")).toBe("before\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test("does not fork after quit begins during the initial probe", async () => {
  fork.mockClear();
  let answer!: (running: boolean) => void;
  probe.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
  );
  let quitting = false;
  const start = ensureHost("never opened", "fixture", () => quitting);
  quitting = true;
  answer(false);
  await start;
  expect(fork).not.toHaveBeenCalled();
});
