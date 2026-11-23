import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

async function renderWecom(view: object) {
  vi.stubGlobal("window", { location: { hash: "#connections" } });
  const { WecomRow } = await import("../src/renderer/src/components/WecomSection.js");
  return renderToStaticMarkup(
    createElement(WecomRow, {
      view: view as Parameters<typeof WecomRow>[0]["view"],
      onView: () => {},
    }),
  );
}

it("renders a scan-login button by default", async () => {
  const html = await renderWecom({ state: "disconnected", capabilities: [] });
  expect(html).toMatch(/<button[^>]*>[^<]*扫码登录<\/button>/);
  expect(html).not.toMatch(/MCP|<input/);
});

it("renders the active QR as an image and offers cancellation without showing credentials", async () => {
  const html = await renderWecom({
    state: "connecting",
    capabilities: [],
    qr: "data:image/png;base64,cHJldmlldy1vbmx5",
  });
  expect(html).toMatch(/<img[^>]*alt="企业微信登录二维码"/);
  expect(html).toContain("取消登录");
  expect(html).toContain("写入操作须在飞书审批");
  expect(html).not.toMatch(/<input|复制/);
});

it("uses fixed retry copy rather than showing raw upstream errors or stale QR", async () => {
  const html = await renderWecom({
    state: "failed",
    capabilities: [],
    error: "opaque-upstream-details",
    qr: "data:image/png;base64,cHJldmlldy1vbmx5",
  });
  expect(html).toContain("重新扫码");
  expect(html).not.toMatch(/opaque-upstream-details|cHJldmlldy1vbmx5/);
});

it("offers to finish disconnecting when local logout failed", async () => {
  const html = await renderWecom({
    state: "failed",
    capabilities: [],
    error: "无法清除本地企业微信登录，请重试断开。",
  });
  expect(html).toContain("重试断开");
  expect(html).not.toContain("重新扫码");
});

async function preview(search = "?sim=ready") {
  const location = { search };
  vi.stubGlobal("location", location);
  vi.stubGlobal("window", { location });
  vi.resetModules();
  await import("../src/renderer/src/dev-bridge.js");
  return window.agentherd.host;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("previews an enterprise QR login, then exposes only granted capabilities", async () => {
  vi.useFakeTimers();
  const host = await preview();
  const disconnected = { state: "disconnected", capabilities: [] };
  const initial = host.wecom();
  await vi.runAllTimersAsync();
  expect(await initial).toEqual(disconnected);

  const start = host.startWecomLogin();
  await vi.advanceTimersByTimeAsync(200);
  expect(await start).toEqual({
    state: "connecting",
    qr: expect.stringMatching(/^data:image\//),
    capabilities: [],
  });

  await vi.runAllTimersAsync();
  const status = host.wecom();
  await vi.runAllTimersAsync();
  expect(await status).toEqual({
    state: "connected",
    capabilities: [
      { id: "doc", name: "文档", toolCount: 3 },
      { id: "calendar", name: "日程", toolCount: 3 },
    ],
  });

  const disconnect = host.disconnectWecom();
  await vi.runAllTimersAsync();
  expect(await disconnect).toEqual(disconnected);
});

it("clears the pending QR on cancel without reconnecting when the simulated scan finishes", async () => {
  vi.useFakeTimers();
  const host = await preview();
  const start = host.startWecomLogin();
  await vi.advanceTimersByTimeAsync(200);
  expect((await start).state).toBe("connecting");

  const cancel = host.cancelWecomLogin();
  await vi.runAllTimersAsync();
  expect(await cancel).toEqual({ state: "disconnected", capabilities: [] });
  const status = host.wecom();
  await vi.runAllTimersAsync();
  expect(await status).toEqual({ state: "disconnected", capabilities: [] });
});

it("clears an expired preview QR and lets the owner retry", async () => {
  vi.useFakeTimers();
  const host = await preview("?sim=ready&fail=wecom");
  const start = host.startWecomLogin();
  await vi.runAllTimersAsync();
  await start;
  const status = host.wecom();
  await vi.runAllTimersAsync();
  expect(await status).toEqual({ state: "failed", capabilities: [] });

  const retry = host.startWecomLogin();
  await vi.advanceTimersByTimeAsync(200);
  expect(await retry).toEqual({
    state: "connecting",
    qr: expect.stringMatching(/^data:image\//),
    capabilities: [],
  });
});
