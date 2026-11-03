// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { showWebRemoteControlVersionNotice } from "../src/webRemoteControlVersionNotice.js";
import { showMobileNotificationNotice } from "../src/mobile-remote/mobileNotificationNotice.js";

/**
 * 手机端弹层表面的触控/字号回归：
 * - settings-5：版本弹窗「重新加载」是唯一且必须执行的动作，命中区 ≥44px 且通栏；
 * - dialogs-2（本批次归属部分）：通知失败弹窗正文收敛到 text-ui-sm；
 * - notify-4：bootstrap 通知 action 提交被拒路径必须先渲染目标任务页再弹结果条。
 *   该路径位于 startGatewaySession 闭包内部，现网没有可注入的 session 级测试缝
 *   （现有测试只覆盖 queue/navigation/config 等独立模块），按本仓对 bootstrap 单体的
 *   既有做法做源码结构断言，防止「不渲染目的地」的旧实现回潮。
 */

afterEach(() => {
  document.body.innerHTML = "";
});

// 当前 jsdom 未实现 <dialog> 的 showModal/close；这两个原生方法在本仓弹层实现里
// 只负责打开/关闭语义，测试环境注入最小桩（open 属性切换）即可验证渲染与回调。
if (typeof HTMLDialogElement.prototype.showModal !== "function") {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
}
if (typeof HTMLDialogElement.prototype.close !== "function") {
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}

describe("web remote control version notice (settings-5)", () => {
  it("gives the mandatory reload action a full-width 44px hit area", async () => {
    const onReload = vi.fn();
    const dispose = showWebRemoteControlVersionNotice("9.9.9-test", onReload);
    try {
      await waitFor(() => expect(document.querySelector("dialog button")).toBeTruthy());
      const button = document.querySelector("dialog button") as HTMLButtonElement;
      expect(button.className).toContain("w-full");
      expect(button.className).toContain("h-11");
      expect(button.className).not.toContain("self-end");
      fireEvent.click(button);
      expect(onReload).toHaveBeenCalledOnce();
    } finally {
      dispose();
    }
  });
});

describe("mobile notification notice dialog (dialogs-2)", () => {
  it("sets the notice body to the secondary copy size", async () => {
    const retry = vi.fn();
    const dismiss = vi.fn();
    const dispose = showMobileNotificationNotice({ retry, dismiss });
    try {
      await waitFor(() => expect(document.querySelector("dialog p")).toBeTruthy());
      const body = document.querySelector("dialog p") as HTMLElement;
      expect(body.className).toContain("text-ui-sm");
    } finally {
      dispose();
    }
    expect(retry).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });
});

describe("bootstrap notification action rejected path (notify-4)", () => {
  it("renders the target task root before the rejected toast in the submit catch", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/web/src/mobile-remote/bootstrap.tsx"),
      "utf8",
    );
    const submitStart = source.indexOf(
      "await result.services.zodyTaskService.respondPermission",
    );
    const warnMarker = source.indexOf("notification action submit rejected");
    expect(submitStart).toBeGreaterThan(-1);
    expect(warnMarker).toBeGreaterThan(submitStart);
    const segment = source.slice(submitStart, warnMarker);
    // 提交被拒但目标仍当前：必须先 renderExternalRelayRoot 落到目标任务（可达目的地），
    // 再 showMobileNotificationActionResult("rejected")；旧实现的顺序是只弹结果条不渲染。
    const renderAt = segment.indexOf("renderExternalRelayRoot(result.services, result.bridge");
    const toastAt = segment.indexOf('showMobileNotificationActionResult("rejected")');
    expect(renderAt).toBeGreaterThan(-1);
    expect(toastAt).toBeGreaterThan(renderAt);
    // 与代码事实矛盾的旧注释（「页面停在目标任务」）不允许回潮。
    expect(segment).not.toContain("页面停在目标任务");
  });
});
