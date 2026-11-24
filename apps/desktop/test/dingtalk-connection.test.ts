import { HOST_METHODS } from "@agentherd/host/api";
import { Link2 } from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { applyDingTalkView, DingTalkRow } from "../src/renderer/src/components/DingTalkSection";
import { Button } from "../src/renderer/src/components/ui";

vi.mock("../src/renderer/src/store", () => ({ host: vi.fn() }));

it("shows the standard account Connect action for a disconnected DingTalk account", () => {
  const html = renderToStaticMarkup(
    createElement(DingTalkRow, {
      view: { state: "disconnected", capabilities: [] },
      onView: () => {},
    }),
  );
  const standardAction = renderToStaticMarkup(
    createElement(Button, { size: "sm" }, createElement(Link2, { size: 12 }), "连接"),
  );
  expect(html).toContain(standardAction);
});

it("shows the connection error but still offers Connect after a pre-authorization failure", () => {
  const html = renderToStaticMarkup(
    createElement(DingTalkRow, {
      view: { state: "disconnected", error: "钉钉无法写入本地授权目录。", capabilities: [] },
      onView: () => {},
    }),
  );
  expect(html).toContain('role="alert"');
  expect(html).toContain("钉钉无法写入本地授权目录。");
  expect(html).toContain("连接失败");
  expect(html).not.toContain("清除连接");
});

it("registers only the account lifecycle IPC methods for DingTalk", () => {
  expect(HOST_METHODS.filter((method) => method.toLowerCase().includes("dingtalk"))).toEqual([
    "dingtalk",
    "startDingTalkLogin",
    "cancelDingTalkLogin",
    "disconnectDingTalk",
  ]);
});

it("does not let an old browser authorization status overwrite a cancelled login", () => {
  const disconnected = { state: "disconnected", capabilities: [] } as const;
  expect(applyDingTalkView(2, 1, { state: "connected", capabilities: [] })).toBeUndefined();
  expect(applyDingTalkView(2, 2, { ...disconnected, capabilities: [] })).toMatchObject(
    disconnected,
  );
});
