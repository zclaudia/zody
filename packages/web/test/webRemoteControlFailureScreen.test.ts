import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  WebRemoteControlFailureScreen,
  resolveWebRemoteControlScreenCopy,
} from "../src/webRemoteControlFailureScreen.js";

describe("WebRemoteControlFailureScreen", () => {
  it("explains DEVICE_OFFLINE as a desktop disconnected state", () => {
    const copy = resolveWebRemoteControlScreenCopy(
      { reason: "desktop-disconnected", message: "Desktop device is offline." },
      "zh-CN",
    );

    expect(copy.title).toBe("桌面端已离线");
    expect(copy.description).toContain("电脑端已经断开连接");
    expect(copy.action).toBe("重新连接");
  });

  it("explains mobile recovery timeout without blaming desktop offline", () => {
    const copy = resolveWebRemoteControlScreenCopy(
      {
        reason: "connection-recovery-timeout",
        message: "Mobile connection did not recover the RPC bridge in time.",
      },
      "zh-CN",
    );

    expect(copy.title).toBe("连接恢复超时");
    expect(copy.description).toContain("手机端连接没有及时恢复");
    expect(copy.description).not.toContain("电脑端已经断开连接");
  });

  it("explains KICKED as another mobile controller taking over", () => {
    const copy = resolveWebRemoteControlScreenCopy(
      {
        reason: "session-conflict",
        message: "Another mobile controller replaced this one.",
      },
      "zh-CN",
    );

    expect(copy.title).toBe("已被其他设备接管");
    expect(copy.description).toContain("另一台远程控制设备");
  });

  it("renders structured recovery guidance and the relay detail message", () => {
    const html = renderToStaticMarkup(
      createElement(WebRemoteControlFailureScreen, {
        failure: {
          reason: "desktop-disconnected",
          message: "Desktop device is offline.",
        },
        locale: "en-US",
        onReload: () => {},
      }),
    );

    expect(html).toContain("Desktop Offline");
    expect(html).toContain("What happened");
    expect(html).toContain("Desktop device is offline.");
    expect(html).toContain("Try Again");
  });

  it("tells the user to update the phone app when upgrade=mobile", () => {
    const zh = resolveWebRemoteControlScreenCopy(
      { reason: "incompatible-version", upgrade: "mobile" },
      "zh-CN",
    );
    const en = resolveWebRemoteControlScreenCopy(
      { reason: "incompatible-version", upgrade: "mobile" },
      "en-US",
    );

    expect(zh.title).toBe("请更新手机 App");
    expect(zh.nextSteps.join("")).toContain("手机 App");
    expect(en.title).toBe("Update the Phone App");
    expect(en.nextSteps.join("")).toContain("phone app");
  });

  it("tells the user to update the desktop when upgrade=desktop", () => {
    const zh = resolveWebRemoteControlScreenCopy(
      { reason: "incompatible-version", upgrade: "desktop" },
      "zh-CN",
    );
    const en = resolveWebRemoteControlScreenCopy(
      { reason: "incompatible-version", upgrade: "desktop" },
      "en-US",
    );

    expect(zh.title).toBe("请更新电脑端 ZCode");
    expect(zh.nextSteps.join("")).toContain("电脑");
    expect(en.title).toBe("Update Desktop ZCode");
    expect(en.nextSteps.join("")).toContain("desktop");
  });

  it("keeps the generic version copy when upgrade is missing", () => {
    const copy = resolveWebRemoteControlScreenCopy({ reason: "incompatible-version" }, "zh-CN");

    expect(copy.title).toBe("手机与电脑端版本不兼容");
  });

  it("offers settings for an invalid credential and another desktop for backend-unsupported", () => {
    const renderFailure = (failure: {
      reason: "gateway-credential-invalid" | "backend-unsupported";
    }) =>
      renderToStaticMarkup(
        createElement(WebRemoteControlFailureScreen, {
          failure,
          locale: "zh-CN",
          onReload: () => {},
          onOpenSettings: () => {},
          onChooseBackend: () => {},
        }),
      );

    expect(renderFailure({ reason: "gateway-credential-invalid" })).toContain("打开设置");
    expect(renderFailure({ reason: "backend-unsupported" })).toContain("重新选择电脑");
  });
});
