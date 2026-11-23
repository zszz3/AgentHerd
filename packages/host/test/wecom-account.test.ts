import { describe, expect, it, vi } from "vitest";
import { WecomAccount, type WecomCliPort } from "../src/wecom-account.ts";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  let signedIn = false;
  const scanned = deferred();
  const cli: WecomCliPort = {
    login: vi.fn(async (qr, signal) => {
      qr("data:image/png;base64,ZmFrZQ==");
      await Promise.race([
        scanned.promise,
        new Promise<void>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      ]);
      signal.throwIfAborted();
      signedIn = true;
    }),
    logout: vi.fn(async () => {
      signedIn = false;
    }),
    status: vi.fn(async () => signedIn),
    run: vi.fn(async () => ({})),
  };
  const call = vi.fn(async () => ({}));
  const discover = vi.fn(async () => ({
    capabilities: [
      { id: "calendar", name: "日程", toolCount: 1 },
      { id: "meeting", name: "会议", toolCount: 1 },
    ],
    list: async () => [
      { name: "wecom_calendar_list", inputSchema: { type: "object" } },
      { name: "wecom_meeting_list", inputSchema: { type: "object" } },
    ],
    describe: async () => new Map(),
    call,
  }));
  return { cli, scanned, call, discover, account: new WecomAccount(cli, discover) };
}

describe("WeCom account", () => {
  it("scans once and restores an account with tools from multiple capabilities", async () => {
    const { account, cli, scanned, discover, call } = fixture();
    expect(await account.view()).toEqual({ state: "disconnected", capabilities: [] });
    await account.startLogin();
    expect(await account.view()).toMatchObject({
      state: "connecting",
      qr: expect.stringMatching(/^data:image\/png/),
    });
    await account.startLogin();
    expect(cli.login).toHaveBeenCalledTimes(1);
    scanned.resolve();
    await expect.poll(async () => (await account.view()).state).toBe("connected");
    expect((await account.view()).qr).toBeUndefined();
    expect((await account.view()).capabilities.map((x) => x.id)).toEqual(["calendar", "meeting"]);
    const tools = account.apps();
    expect((await tools.list()).map((x) => x.name)).toEqual([
      "wecom_calendar_list",
      "wecom_meeting_list",
    ]);
    const restored = new WecomAccount(cli, discover);
    expect((await restored.view()).state).toBe("connected");
    expect(cli.login).toHaveBeenCalledTimes(1);
    await account.disconnect();
    await expect(tools.call("wecom_calendar_list", {})).rejects.toThrow(/企业微信/);
    expect(call).not.toHaveBeenCalled();
  });

  it("does not reuse local credentials after a failed disconnect", async () => {
    const { account, cli, scanned, discover } = fixture();
    await account.startLogin();
    scanned.resolve();
    await expect.poll(async () => (await account.view()).state).toBe("connected");
    vi.mocked(cli.logout).mockRejectedValueOnce(new Error("credential file is locked"));
    expect(await account.disconnect()).toMatchObject({ state: "failed" });
    expect(await account.startLogin()).toMatchObject({ state: "failed" });
    expect(await account.apps().list()).toEqual([]);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(await account.disconnect()).toMatchObject({ state: "disconnected" });
  });

  it("cancels a pending scan and hides its QR without reviving a canceled session", async () => {
    const { account, cli, scanned, discover } = fixture();
    await account.startLogin();
    expect(await account.cancelLogin()).toEqual({ state: "disconnected", capabilities: [] });
    scanned.resolve();
    expect(await account.view()).toEqual({ state: "disconnected", capabilities: [] });
    expect(await cli.status()).toBe(false);
    expect(discover).not.toHaveBeenCalled();
  });
});
