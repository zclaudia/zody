import { describe, expect, it, vi } from "vitest";
import {
  MOBILE_REMOTE_NATIVE_HOST_GLOBAL_KEY,
  installMobileRemoteNativeHost,
} from "../src/mobile-remote/mobileRemoteNativeHost.js";

interface InstalledHost {
  onNotificationClick(value: unknown): void;
  onNotificationAction(value: unknown): void;
  onNotificationPermissionChanged(value: unknown): void;
  onAppLifecycle(state: unknown): void;
  onBackPressed(): boolean;
}

function createTarget(withBridge = true): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  if (withBridge) {
    target.ZcodeMobileBridge = {
      secureStoreGet: () => null,
      secureStoreSet: () => {},
      secureStoreRemove: () => {},
    };
  }
  return target;
}

function installedHost(target: Record<string, unknown>): InstalledHost {
  return target[MOBILE_REMOTE_NATIVE_HOST_GLOBAL_KEY] as InstalledHost;
}

describe("mobile remote native host (T6.2)", () => {
  it("does not install event capabilities without the native bridge", () => {
    const target = createTarget(false);

    expect(installMobileRemoteNativeHost({ target })).toBeUndefined();
    expect(target[MOBILE_REMOTE_NATIVE_HOST_GLOBAL_KEY]).toBeUndefined();
  });

  it("installs the page host object and forwards lifecycle events", () => {
    const target = createTarget();
    const binding = installMobileRemoteNativeHost({ target });
    expect(binding).toBeDefined();

    const handler = vi.fn();
    const dispose = binding!.onAppLifecycleChange(handler);

    installedHost(target).onAppLifecycle("background");
    installedHost(target).onAppLifecycle("foreground");
    // 宿主传入未知状态时不能转发给页面。
    installedHost(target).onAppLifecycle("bogus");

    expect(handler.mock.calls).toEqual([["background"], ["foreground"]]);

    dispose();
    installedHost(target).onAppLifecycle("background");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("asks back handlers in reverse registration order", () => {
    const target = createTarget();
    const binding = installMobileRemoteNativeHost({ target })!;
    const fallback = vi.fn(() => false);
    const overlay = vi.fn(() => true);

    const disposeFallback = binding.onBackPressed(fallback);
    const disposeOverlay = binding.onBackPressed(overlay);

    expect(installedHost(target).onBackPressed()).toBe(true);
    // 后注册的 UI 优先，并且命中后不再询问启动流程。
    expect(overlay).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();

    disposeOverlay();
    expect(installedHost(target).onBackPressed()).toBe(false);
    expect(fallback).toHaveBeenCalledTimes(1);

    disposeFallback();
  });

  it("treats throwing handlers as not handled and keeps asking", () => {
    const target = createTarget();
    const binding = installMobileRemoteNativeHost({ target })!;
    const broken = vi.fn(() => {
      throw new Error("component crashed");
    });
    const handled = vi.fn(() => true);

    binding.onBackPressed(broken);
    binding.onBackPressed(handled);

    expect(installedHost(target).onBackPressed()).toBe(true);
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it("keeps one host object and one set of subscriptions per target", () => {
    const target = createTarget();
    const first = installMobileRemoteNativeHost({ target });
    const host = target[MOBILE_REMOTE_NATIVE_HOST_GLOBAL_KEY];
    const second = installMobileRemoteNativeHost({ target });

    expect(second).toBe(first);
    expect(target[MOBILE_REMOTE_NATIVE_HOST_GLOBAL_KEY]).toBe(host);
  });
  it("forwards validated warm clicks and permission results without replaying disposed listeners", () => {
    const target = createTarget();
    const binding = installMobileRemoteNativeHost({ target })!;
    const click = vi.fn();
    const permission = vi.fn();
    const disposeClick = binding.onNotificationClick(click);
    const disposePermission = binding.onNotificationPermissionChanged(permission);
    installedHost(target).onNotificationClick({
      backendId: "backend",
      notificationId: "notification",
    });
    installedHost(target).onNotificationClick({ backendId: "backend", notificationId: "" });
    installedHost(target).onNotificationPermissionChanged(true);
    installedHost(target).onNotificationPermissionChanged("true");
    expect(click).toHaveBeenCalledTimes(1);
    expect(permission).toHaveBeenCalledExactlyOnceWith(true);
    disposeClick();
    disposePermission();
    installedHost(target).onNotificationClick({ backendId: "b", notificationId: "n" });
    installedHost(target).onNotificationPermissionChanged(false);
    expect(click).toHaveBeenCalledTimes(1);
    expect(permission).toHaveBeenCalledTimes(1);
  });
});

describe("mobile remote native host notification action (E4)", () => {
  it("forwards validated action clicks and drops malformed payloads", () => {
    const target = createTarget();
    const binding = installMobileRemoteNativeHost({ target })!;

    const handler = vi.fn();
    binding.onNotificationAction(handler);

    const host = installedHost(target);
    host.onNotificationAction({
      backendId: "b",
      notificationId: "n",
      optionId: "opt",
      optionKind: "deny",
    });
    host.onNotificationAction({ backendId: "b", notificationId: "n", optionId: "opt" });
    host.onNotificationAction({ backendId: "b", notificationId: "n", optionKind: "deny" });
    host.onNotificationAction("bogus");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      backendId: "b",
      notificationId: "n",
      optionId: "opt",
      optionKind: "deny",
    });
  });
});
