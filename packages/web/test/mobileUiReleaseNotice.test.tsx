// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileUiReleaseControllerStatus } from "../src/mobile-remote/mobileUiReleaseController.js";
import { showMobileUiReleaseNotice } from "../src/mobile-remote/mobileUiReleaseNotice.js";

interface FakeController {
  status: MobileUiReleaseControllerStatus;
  listeners: Set<(status: MobileUiReleaseControllerStatus) => void>;
  getStatus(): MobileUiReleaseControllerStatus;
  subscribe(listener: (status: MobileUiReleaseControllerStatus) => void): () => void;
  requestSafeReload(): Promise<unknown>;
  emit(status: MobileUiReleaseControllerStatus): void;
}

function createFakeController(status: MobileUiReleaseControllerStatus): FakeController {
  const listeners = new Set<(status: MobileUiReleaseControllerStatus) => void>();
  const controller: FakeController = {
    status,
    listeners,
    getStatus: () => controller.status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    requestSafeReload: vi.fn(async () => ({ kind: "blocked" })),
    emit(next) {
      controller.status = next;
      for (const listener of listeners) listener(next);
    },
  };
  return controller;
}

beforeEach(() => {
  vi.stubGlobal("navigator", { language: "zh-CN", languages: ["zh-CN"] });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("mobile UI release notice", () => {
  it("shows the ready banner, lists blockers and reuses the safe reload path", async () => {
    const controller = createFakeController({
      kind: "ready",
      releaseId: "0123456789abcdef01234567",
      desktopVersion: "0.2.0",
      blockedReasons: ["composer-draft", "unsaved-settings"],
    });
    const dispose = showMobileUiReleaseNotice(controller);
    try {
      await waitFor(() => expect(document.body.textContent).toContain("新版已就绪"));
      expect(
        document.querySelector('[data-mobile-release-blocked-reason="composer-draft"]'),
      ).toBeTruthy();
      expect(
        document.querySelector('[data-mobile-release-blocked-reason="unsaved-settings"]'),
      ).toBeTruthy();

      const button = document.querySelector<HTMLButtonElement>("[data-mobile-release-reload]");
      expect(button).toBeTruthy();
      fireEvent.click(button!);
      expect(controller.requestSafeReload).toHaveBeenCalledOnce();
    } finally {
      dispose();
    }
  });

  it("shows native veto reasons without offering a bypass", async () => {
    const controller = createFakeController({
      kind: "ready",
      releaseId: "0123456789abcdef01234567",
      desktopVersion: "0.2.0",
      blockedReasons: [],
      nativeVeto: "native-busy",
    });
    const dispose = showMobileUiReleaseNotice(controller);
    try {
      await waitFor(() => expect(document.body.textContent).toContain("系统文件选择"));
      expect(
        document.querySelector('[data-mobile-release-native-veto="native-busy"]'),
      ).toBeTruthy();
      // 仍只提供一个安全刷新入口，没有“强制刷新”旁路。
      expect(document.querySelectorAll("[data-mobile-release-reload]")).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it("hides when the page becomes up-to-date and removes the host on dispose", async () => {
    const controller = createFakeController({
      kind: "ready",
      releaseId: "0123456789abcdef01234567",
      desktopVersion: "0.2.0",
      blockedReasons: [],
    });
    const dispose = showMobileUiReleaseNotice(controller);
    await waitFor(() => expect(document.body.textContent).toContain("新版已就绪"));

    act(() => {
      controller.emit({ kind: "up-to-date", checkedAt: 1 });
    });
    await waitFor(() =>
      expect(document.querySelector("[data-mobile-release-notice]")?.hasAttribute("hidden")).toBe(
        true,
      ),
    );

    dispose();
    expect(document.querySelector("[data-mobile-release-notice]")).toBeNull();
  });

  it("renders an upgrade prompt for an incompatible release", async () => {
    const controller = createFakeController({
      kind: "incompatible",
      releaseId: "0123456789abcdef01234567",
      supportedBridgeVersions: [2],
    });
    const dispose = showMobileUiReleaseNotice(controller);
    try {
      await waitFor(() => expect(document.body.textContent).toContain("需要更新 Zody App"));
      expect(document.querySelector("[data-mobile-release-reload]")).toBeNull();
    } finally {
      dispose();
    }
  });
});
