// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backOutOfWebRemoteControlMobileConnectionSettingsHistory,
  backOutOfWebRemoteControlMobileOverlayHistory,
  clearWebRemoteControlMobileConnectionSettingsHistoryState,
  clearWebRemoteControlMobileOverlayHistoryState,
  clearWebRemoteControlMobileSettingsHistoryState,
  isWebRemoteControlMobileChatHistoryState,
  isWebRemoteControlMobileConnectionSettingsHistoryState,
  isWebRemoteControlMobileOverlayHistoryState,
  isWebRemoteControlMobileSettingsHistoryState,
  planInitialWebRemoteControlMobileSettingsHistory,
  pushWebRemoteControlMobileConnectionSettingsHistory,
  pushWebRemoteControlMobileOverlayHistory,
  pushWebRemoteControlMobileSettingsIndexHistory,
  pushWebRemoteControlMobileSettingsSectionHistory,
} from "@/mobileNavigationHistory.js";

/**
 * 走查 shell-1 的 history 契约单测：功能浮层/目录选择器打开时压入 overlay 条目，
 * UI/Android 桥关闭时回退回收，页面加载时剥掉刷新残留的 overlay 标识。
 * jsdom 提供真实 history API；popstate 由真实 back() 异步派发。
 */
describe("mobileNavigationHistory", () => {
  beforeEach(() => {
    window.history.replaceState(null, "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "");
  });

  describe("isWebRemoteControlMobileChatHistoryState", () => {
    it("识别 chat 基础条目、浮层叠在 chat 上的条目，拒绝其余值", () => {
      expect(isWebRemoteControlMobileChatHistoryState({ zcodeMobilePage: "chat" })).toBe(true);
      expect(
        isWebRemoteControlMobileChatHistoryState({
          zcodeMobilePage: "chat",
          zcodeMobileOverlay: "search",
        }),
      ).toBe(true);
      expect(isWebRemoteControlMobileChatHistoryState({ zcodeMobilePage: "home" })).toBe(false);
      expect(isWebRemoteControlMobileChatHistoryState(null)).toBe(false);
      expect(isWebRemoteControlMobileChatHistoryState("chat")).toBe(false);
    });
  });

  describe("isWebRemoteControlMobileOverlayHistoryState", () => {
    it("只认已知浮层标识，未知值/页面条目/非对象均为 false", () => {
      expect(isWebRemoteControlMobileOverlayHistoryState({ zcodeMobileOverlay: "files" })).toBe(
        true,
      );
      expect(
        isWebRemoteControlMobileOverlayHistoryState({ zcodeMobileOverlay: "workspacePicker" }),
      ).toBe(true);
      expect(isWebRemoteControlMobileOverlayHistoryState({ zcodeMobilePage: "chat" })).toBe(false);
      expect(isWebRemoteControlMobileOverlayHistoryState({ zcodeMobileOverlay: "bogus" })).toBe(
        false,
      );
      expect(isWebRemoteControlMobileOverlayHistoryState(null)).toBe(false);
    });
  });

  describe("pushWebRemoteControlMobileOverlayHistory", () => {
    it("在 chat 基础条目上压入浮层条目并记录宿主页面", () => {
      window.history.replaceState({ zcodeMobilePage: "chat" }, "");

      pushWebRemoteControlMobileOverlayHistory("search");

      expect(window.history.state).toEqual({
        zcodeMobilePage: "chat",
        zcodeMobileOverlay: "search",
      });
    });

    it("无 state 的首页条目上压入时宿主页面记为 home", () => {
      pushWebRemoteControlMobileOverlayHistory("notifications");

      expect(window.history.state).toEqual({
        zcodeMobilePage: "home",
        zcodeMobileOverlay: "notifications",
      });
    });

    it("已在浮层条目上时不重复叠加，避免 history 深度虚增", () => {
      pushWebRemoteControlMobileOverlayHistory("files");
      const overlayState = window.history.state;
      const pushSpy = vi.spyOn(window.history, "pushState");

      pushWebRemoteControlMobileOverlayHistory("search");

      expect(pushSpy).not.toHaveBeenCalled();
      expect(window.history.state).toBe(overlayState);
    });
  });

  describe("backOutOfWebRemoteControlMobileOverlayHistory", () => {
    it("当前条目是浮层时回退 history 并落到基础条目", async () => {
      window.history.replaceState({ zcodeMobilePage: "chat" }, "");
      pushWebRemoteControlMobileOverlayHistory("files");
      const popped = new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
      });

      backOutOfWebRemoteControlMobileOverlayHistory();
      await popped;

      expect(window.history.state).toEqual({ zcodeMobilePage: "chat" });
    });

    it("当前条目不是浮层时不触发回退", () => {
      const backSpy = vi.spyOn(window.history, "back");

      backOutOfWebRemoteControlMobileOverlayHistory();

      expect(backSpy).not.toHaveBeenCalled();
    });
  });

  describe("clearWebRemoteControlMobileOverlayHistoryState", () => {
    it("剥掉刷新残留的 overlay 标识并保留宿主页面标识", () => {
      window.history.replaceState({ zcodeMobilePage: "chat", zcodeMobileOverlay: "files" }, "");

      clearWebRemoteControlMobileOverlayHistoryState();

      expect(window.history.state).toEqual({ zcodeMobilePage: "chat" });
      expect(isWebRemoteControlMobileOverlayHistoryState(window.history.state)).toBe(false);
      expect(isWebRemoteControlMobileChatHistoryState(window.history.state)).toBe(true);
    });

    it("非浮层条目时不改写 history", () => {
      window.history.replaceState({ zcodeMobilePage: "chat" }, "");
      const replaceSpy = vi.spyOn(window.history, "replaceState");

      clearWebRemoteControlMobileOverlayHistoryState();

      expect(replaceSpy).not.toHaveBeenCalled();
    });
  });

  describe("mobile application settings history", () => {
    it("显式深链保留设置首页作为上一次返回落点", async () => {
      window.history.replaceState({ zcodeMobilePage: "chat" }, "");

      pushWebRemoteControlMobileSettingsSectionHistory("modelProvider");
      expect(window.history.state).toEqual({
        zcodeMobilePage: "chat",
        zcodeMobileSettings: { view: "section", section: "modelProvider" },
      });

      const popped = new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
      });
      window.history.back();
      await popped;
      expect(window.history.state).toEqual({
        zcodeMobilePage: "chat",
        zcodeMobileSettings: { view: "index" },
      });
    });

    it("从设置首页进入分区时 push，分区间深链 replace，保证返回先到首页", () => {
      pushWebRemoteControlMobileSettingsIndexHistory();
      const pushSpy = vi.spyOn(window.history, "pushState");
      pushWebRemoteControlMobileSettingsSectionHistory("appearance");
      expect(pushSpy).toHaveBeenCalledTimes(1);

      const replaceSpy = vi.spyOn(window.history, "replaceState");
      pushWebRemoteControlMobileSettingsSectionHistory("hooks");
      expect(pushSpy).toHaveBeenCalledTimes(1);
      expect(replaceSpy).toHaveBeenCalledTimes(1);
      expect(isWebRemoteControlMobileSettingsHistoryState(window.history.state)).toBe(true);
      expect(window.history.state.zcodeMobileSettings).toEqual({
        view: "section",
        section: "hooks",
      });
    });

    it("识别独立连接设置条目，不把它当作应用设置", () => {
      const state = { zcodeMobilePage: "home", zcodeMobileConnectionSettings: true };
      expect(isWebRemoteControlMobileConnectionSettingsHistoryState(state)).toBe(true);
      expect(isWebRemoteControlMobileSettingsHistoryState(state)).toBe(false);
    });

    it("普通打开只规划设置首页，显式 intent 规划目标分区", () => {
      expect(
        planInitialWebRemoteControlMobileSettingsHistory({
          state: null,
          explicitSection: false,
          section: "appearance",
          initialized: false,
        }),
      ).toEqual({ kind: "push-index" });

      expect(
        planInitialWebRemoteControlMobileSettingsHistory({
          state: { zcodeMobilePage: "chat" },
          explicitSection: true,
          section: "modelProvider",
          initialized: false,
        }),
      ).toEqual({ kind: "push-section", section: "modelProvider" });
    });

    it("已有 settings 条目时只恢复视图，已初始化后不再重复 push", () => {
      expect(
        planInitialWebRemoteControlMobileSettingsHistory({
          state: { zcodeMobilePage: "chat", zcodeMobileSettings: { view: "index" } },
          explicitSection: true,
          section: "appearance",
          initialized: false,
        }),
      ).toEqual({ kind: "restore", view: "index" });

      expect(
        planInitialWebRemoteControlMobileSettingsHistory({
          state: {
            zcodeMobilePage: "chat",
            zcodeMobileSettings: { view: "section", section: "hooks" },
          },
          explicitSection: false,
          section: "appearance",
          initialized: true,
        }),
      ).toEqual({ kind: "restore", view: "section", section: "hooks" });

      expect(
        planInitialWebRemoteControlMobileSettingsHistory({
          state: { zcodeMobilePage: "home" },
          explicitSection: true,
          section: "appearance",
          initialized: true,
        }),
      ).toEqual({ kind: "none" });
    });

    it("卸载回收 settings 条目时只改 state，不新增历史深度", () => {
      window.history.replaceState(
        { zcodeMobilePage: "chat", zcodeMobileSettings: { view: "section", section: "hooks" } },
        "",
      );
      const beforeLength = window.history.length;
      const backSpy = vi.spyOn(window.history, "back");
      const pushSpy = vi.spyOn(window.history, "pushState");

      clearWebRemoteControlMobileSettingsHistoryState();

      expect(window.history.state).toEqual({ zcodeMobilePage: "chat" });
      expect(isWebRemoteControlMobileSettingsHistoryState(window.history.state)).toBe(false);
      expect(window.history.length).toBe(beforeLength);
      expect(backSpy).not.toHaveBeenCalled();
      expect(pushSpy).not.toHaveBeenCalled();
    });
  });

  describe("mobile connection settings overlay history (spec §4.1)", () => {
    it("打开时压入连接设置条目并记录宿主页面，已在条目上时不重复叠加", () => {
      window.history.replaceState({ zcodeMobilePage: "chat" }, "");

      pushWebRemoteControlMobileConnectionSettingsHistory();
      expect(window.history.state).toEqual({
        zcodeMobilePage: "chat",
        zcodeMobileConnectionSettings: true,
      });

      const pushSpy = vi.spyOn(window.history, "pushState");
      pushWebRemoteControlMobileConnectionSettingsHistory();
      expect(pushSpy).not.toHaveBeenCalled();
    });

    it("关闭时只回退连接设置条目，落在宿主条目", async () => {
      window.history.replaceState({ zcodeMobilePage: "chat" }, "");
      pushWebRemoteControlMobileConnectionSettingsHistory();
      const popped = new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
      });

      backOutOfWebRemoteControlMobileConnectionSettingsHistory();
      await popped;

      expect(window.history.state).toEqual({ zcodeMobilePage: "chat" });
      expect(isWebRemoteControlMobileConnectionSettingsHistoryState(window.history.state)).toBe(
        false,
      );
    });

    it("当前条目不是连接设置时不触发回退", () => {
      const backSpy = vi.spyOn(window.history, "back");

      backOutOfWebRemoteControlMobileConnectionSettingsHistory();

      expect(backSpy).not.toHaveBeenCalled();
    });

    it("刷新/卸载回收条目只改 state，不 back/push", () => {
      window.history.replaceState(
        { zcodeMobilePage: "home", zcodeMobileConnectionSettings: true },
        "",
      );
      const beforeLength = window.history.length;
      const backSpy = vi.spyOn(window.history, "back");
      const pushSpy = vi.spyOn(window.history, "pushState");

      clearWebRemoteControlMobileConnectionSettingsHistoryState();

      expect(window.history.state).toEqual({ zcodeMobilePage: "home" });
      expect(window.history.length).toBe(beforeLength);
      expect(backSpy).not.toHaveBeenCalled();
      expect(pushSpy).not.toHaveBeenCalled();
    });
  });
});
