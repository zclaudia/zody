// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { WebRemoteControlMobileConnectionSettingsSection } from "@/settings/WebRemoteControlMobileConnectionSettingsSection.js";
import type { WebRemoteControlMobileConnectionSettingsApi } from "@/settings/WebRemoteControlMobileConnectionSettingsSection.js";

const initial = {
  gatewayUrl: "https://gateway.example.com",
  namespace: "zody",
  // 测试用 fake 凭证；分区只读取 credentialConfigured，不得回显原文。
  credentialConfigured: true,
};

function renderSection(overrides: Partial<WebRemoteControlMobileConnectionSettingsApi> = {}) {
  const save =
    overrides.save ??
    vi.fn(async () => ({
      scopeChanged: false,
    }));
  const reconnect = overrides.reconnect ?? vi.fn();
  const onBack = vi.fn();
  const onSaved = vi.fn();
  const settings: WebRemoteControlMobileConnectionSettingsApi = {
    initial,
    allowInsecureTransport: true,
    save,
    reconnect,
    ...overrides,
  };

  const view = render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(WebRemoteControlMobileConnectionSettingsSection, {
        settings,
        onBack,
        onSaved,
      }),
    ),
  );

  return { ...view, save, reconnect, onBack, onSaved };
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

/** 模拟浏览器完成 go/back：改写当前 state 并派发 popstate（jsdom 不遍历历史）。 */
function settleOnPopState(state: unknown) {
  act(() => {
    window.history.replaceState(state, "");
    window.dispatchEvent(new PopStateEvent("popstate", { state }));
  });
}

describe("WebRemoteControlMobileConnectionSettingsSection", () => {
  let backSpy: ReturnType<typeof vi.spyOn>;
  let goSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.history.replaceState(
      {
        zcodeMobilePage: "home",
        zcodeMobileSettings: { view: "section", section: "connection" },
      },
      "",
    );
    backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    goSpy = vi.spyOn(window.history, "go").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.history.replaceState(null, "");
  });

  it("复用连接字段且已保存凭证不回显", () => {
    renderSection();

    expect(screen.getByLabelText("Gateway address")).toBeTruthy();
    expect(screen.getByLabelText("Namespace")).toBeTruthy();
    const credential = screen.getByLabelText("Device credential") as HTMLInputElement;
    expect(credential.type).toBe("password");
    expect(credential.value).toBe("");
    expect(screen.getByPlaceholderText("Credential saved; leave empty to keep it")).toBeTruthy();
    expect(document.body.textContent).not.toContain("zgd_");
  });

  it("取消只返回设置首页，不保存也不重连", () => {
    const view = renderSection();

    fireEvent.change(screen.getByLabelText("Gateway address"), {
      target: { value: "https://unsaved.example.com" },
    });
    fireEvent.change(screen.getByLabelText("Device credential"), {
      target: { value: "zgd_unsaved" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(view.onBack).toHaveBeenCalledTimes(1);
    expect(view.save).not.toHaveBeenCalled();
    expect(view.onSaved).not.toHaveBeenCalled();
    expect(view.reconnect).not.toHaveBeenCalled();
    expect(backSpy).not.toHaveBeenCalled();
    // 分区在设置首页下只隐藏不卸载，取消必须主动丢弃本次未保存输入。
    expect((screen.getByLabelText("Gateway address") as HTMLInputElement).value).toBe(
      initial.gatewayUrl,
    );
    expect((screen.getByLabelText("Device credential") as HTMLInputElement).value).toBe("");
  });

  it("保存失败留在分区并保留本次草稿，不重连", async () => {
    const view = renderSection({
      save: vi.fn(async () => {
        throw new Error("persist failed");
      }),
    });

    fireEvent.change(screen.getByLabelText("Gateway address"), {
      target: { value: "https://gateway-2.example.com" },
    });
    fireEvent.change(screen.getByLabelText("Device credential"), {
      target: { value: "zgd_test" },
    });
    submit();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("persist failed");
    expect((screen.getByLabelText("Gateway address") as HTMLInputElement).value).toBe(
      "https://gateway-2.example.com",
    );
    expect((screen.getByLabelText("Device credential") as HTMLInputElement).value).toBe("zgd_test");
    expect(view.onSaved).not.toHaveBeenCalled();
    expect(view.reconnect).not.toHaveBeenCalled();
    expect(backSpy).not.toHaveBeenCalled();
  });

  it("无有效变化保存成功只回设置首页，不重连并丢弃草稿", async () => {
    const view = renderSection();

    fireEvent.change(screen.getByLabelText("Device credential"), {
      target: { value: "zgd_rotated" },
    });
    submit();

    await waitFor(() => expect(view.onSaved).toHaveBeenCalledOnce());
    expect(view.save).toHaveBeenCalledWith({
      gatewayUrl: initial.gatewayUrl,
      namespace: initial.namespace,
      credential: "zgd_rotated",
    });
    expect((screen.getByLabelText("Device credential") as HTMLInputElement).value).toBe("");
    expect(view.reconnect).not.toHaveBeenCalled();
    expect(backSpy).not.toHaveBeenCalled();
    // 无变化路径不回收 history：返回动作仍由设置页的正常逐层返回处理。
    expect(window.history.state.zcodeMobileSettings).toBeTruthy();
  });

  it("有效变化先回退设置分区/首页条目，落回宿主后只重连一次", async () => {
    let stateAtReconnect: unknown;
    const view = renderSection({
      save: vi.fn(async () => ({ scopeChanged: true })),
      reconnect: vi.fn(() => {
        stateAtReconnect = window.history.state;
      }),
    });

    fireEvent.change(screen.getByLabelText("Gateway address"), {
      target: { value: "https://gateway-2.example.com" },
    });
    submit();

    await waitFor(() => expect(view.save).toHaveBeenCalledOnce());
    // 保存成功也必须先回收设置条目；分区下方是设置首页，因此一次退两层。
    expect(view.reconnect).not.toHaveBeenCalled();
    expect(goSpy).toHaveBeenCalledWith(-2);
    expect(backSpy).not.toHaveBeenCalled();
    expect(view.onSaved).not.toHaveBeenCalled();

    // 落在中间的设置首页条目时不重连，继续等宿主条目。
    settleOnPopState({ zcodeMobilePage: "home", zcodeMobileSettings: { view: "index" } });
    expect(view.reconnect).not.toHaveBeenCalled();

    settleOnPopState({ zcodeMobilePage: "home" });
    expect(view.reconnect).toHaveBeenCalledOnce();
    expect(stateAtReconnect).toEqual({ zcodeMobilePage: "home" });

    // 后续 popstate 不再触发第二次重连。
    settleOnPopState({ zcodeMobilePage: "home" });
    expect(view.reconnect).toHaveBeenCalledOnce();
  });

  it("从设置首页保存有效变化只回退一层", async () => {
    window.history.replaceState(
      { zcodeMobilePage: "home", zcodeMobileSettings: { view: "index" } },
      "",
    );
    const view = renderSection({
      save: vi.fn(async () => ({ scopeChanged: true })),
    });

    fireEvent.change(screen.getByLabelText("Gateway address"), {
      target: { value: "https://gateway-2.example.com" },
    });
    submit();

    await waitFor(() => expect(goSpy).toHaveBeenCalledWith(-1));
    expect(view.reconnect).not.toHaveBeenCalled();

    settleOnPopState({ zcodeMobilePage: "home" });
    expect(view.reconnect).toHaveBeenCalledOnce();
  });

  it("提交前归一化 gateway/namespace 并保留已保存凭证", async () => {
    const view = renderSection();

    fireEvent.change(screen.getByLabelText("Gateway address"), {
      target: { value: "  https://gateway.example.com/  " },
    });
    fireEvent.change(screen.getByLabelText("Namespace"), {
      target: { value: "  team  " },
    });
    submit();

    await waitFor(() => expect(view.save).toHaveBeenCalledOnce());
    expect(view.save).toHaveBeenCalledWith({
      gatewayUrl: "https://gateway.example.com/",
      namespace: "team",
      credential: "",
    });
  });
});
