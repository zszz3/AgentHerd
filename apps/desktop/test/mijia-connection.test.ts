import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { MijiaRow } from "../src/renderer/src/components/MijiaSection";

vi.mock("../src/renderer/src/store", () => ({ host: vi.fn() }));

function render(props: Parameters<typeof MijiaRow>[0]) {
  return renderToStaticMarkup(createElement(MijiaRow, props));
}

it("explains the external runtime requirement without offering Connect when unavailable", () => {
  const html = render({ view: { state: "unavailable", message: "private diagnostic" } });
  expect(html).toContain("米家");
  expect(html).toContain("实验性只读");
  expect(html).toContain("未安装 Do1e 外部运行时");
  expect(html).not.toContain(">连接</button>");
  expect(html).not.toContain("private diagnostic");
});

it("offers cleanup rather than a new scan when temporary credentials could not be removed", () => {
  const html = render({ view: { state: "cleanup-required" } });
  expect(html).toContain("未能清理米家登录文件");
  expect(html).toContain(">重试清理</button>");
  expect(html).not.toContain(">连接</button>");
});

it("offers the account Connect action when disconnected", () => {
  const html = render({ view: { state: "disconnected" } });
  expect(html).toContain("未连接");
  expect(html).toContain(">连接</button>");
});

it("shows a pending QR only as an image, and offers cancellation", () => {
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZkwAAAAASUVORK5CYII=";
  const html = render({ view: { state: "waiting", qrDataUrl: png } });
  expect(html).toMatch(/<img[^>]+alt="米家登录二维码"/);
  expect(html).toContain(`src="${png}"`);
  expect(html).not.toContain(`>${png}<`);
  expect(html).not.toContain(`<a `);
  expect(html).toContain(">取消扫码</button>");
  const cancelling = render({ view: { state: "waiting", qrDataUrl: png }, busy: true });
  expect(cancelling).not.toContain(png);
  expect(cancelling).toMatch(/<button[^>]*disabled=""[^>]*>取消扫码<\/button>/);
});

it("does not render external QR URLs or raw authentication diagnostics", () => {
  const url = "https://example.invalid/private-auth";
  const unsafe = render({ view: { state: "waiting", qrDataUrl: url, message: url } });
  expect(unsafe).not.toContain(url);
  expect(unsafe).not.toContain("<img");
  const failure = render({ view: { state: "error", qrDataUrl: url, message: url } });
  expect(failure).toContain('role="alert"');
  expect(failure).toContain(">连接</button>");
  expect(failure).not.toContain(url);
});

it("shows only read-only device metadata and hides the list after disconnect", () => {
  const devices = [
    { id: "private-device-id", name: "插座", home: "家", room: "客厅", online: false },
    { id: "another-device-id", name: "灯" },
  ];
  const connected = render({ view: { state: "connected" }, devices });
  expect(connected).toContain("设备列表");
  expect(connected).toContain("家 · 客厅");
  expect(connected).toContain("离线");
  expect(connected).toContain("插座");
  expect(connected).toContain("灯");
  expect(connected).not.toContain("private-device-id");
  expect(connected).toContain(">断开连接</button>");
  const disconnected = render({ view: { state: "disconnected" }, devices });
  expect(disconnected).not.toContain("插座");
});

it("distinguishes an empty device list from a list still loading", () => {
  expect(render({ view: { state: "connected" } })).toContain("正在读取设备列表…");
  expect(render({ view: { state: "connected" }, devices: [] })).toContain("没有可显示的设备");
});
