import { describe, expect, it, vi } from "vitest";
import {
  MOBILE_REMOTE_NATIVE_HOST_GLOBAL_KEY,
  installMobileRemoteNativeHost,
} from "../src/mobile-remote/mobileRemoteNativeHost.js";

const SESSION_ID = "session-1";

interface InstalledHost {
  onNotificationClick(sessionId: unknown, value: unknown): void;
  onNotificationAction(sessionId: unknown, value: unknown): void;
  onNotificationPermissionChanged(sessionId: unknown, value: unknown): void;
  onAppLifecycle(sessionId: unknown, state: unknown): void;
  onBackPressed(sessionId: unknown): boolean;
}

function createTarget(withBridge = true): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  if (withBridge) {
    target.ZodyRemoteBridge = {
      getSessionContext: () => "{}",
      returnShell: () => {},
    };
  }
  return target;
}

function installedHost(target: Record<string, unknown>): InstalledHost {
  return target[MOBILE_REMOTE_NATIVE_HOST_GLOBAL_KEY] as InstalledHost;
}

function install(target: Record<string, unknown>, sessionId = SESSION_ID) {
  return installMobileRemoteNativeHost({ target, sessionId });
}

describe("mobile remote native host (T6.2 / M2-T2)", () => {
  it("does not install event capabilities without the native bridge", () => {
    const target = createTarget(false);

    expect(install(target)).toBeUndefined();
    expect(target[MOBILE_REMOTE_NATIVE_HOST_GLOBAL_KEY]).toBeUndefined();
  });

  it("installs the page host object and forwards lifecycle events with sessionId", () => {
    const target = createTarget();
    const binding = install(target);
    expect(binding).toBeDefined();

    const handler = vi.fn();
    const dispose = binding!.onAppLifecycleChange(handler);

    installedHost(target).onAppLifecycle(SESSION_ID, "background");
    installedHost(target).onAppLifecycle(SESSION_ID, "foreground");
    // 宿主传入未知状态时不能转发给页面。
    installedHost(target).onAppLifecycle(SESSION_ID, "bogus");
    // 旧 session 的迟到事件直接丢弃。
    installedHost(target).onAppLifecycle("stale-session", "background");

    expect(handler.mock.calls).toEqual([["background"], ["foreground"]]);

    dispose();
    installedHost(target).onAppLifecycle(SESSION_ID, "background");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("asks back handlers in reverse registration order", () => {
    const target = createTarget();
    const binding = install(target)!;
    const fallback = vi.fn(() => false);
    const overlay = vi.fn(() => true);

    const disposeFallback = binding.onBackPressed(fallback);
    const disposeOverlay = binding.onBackPressed(overlay);

    expect(installedHost(target).onBackPressed(SESSION_ID)).toBe(true);
    // 后注册的 UI 优先，并且命中后不再询问启动流程。
    expect(overlay).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    // stale session 不消费返回键。
    expect(installedHost(target).onBackPressed("stale-session")).toBe(false);

    disposeOverlay();
    expect(installedHost(target).onBackPressed(SESSION_ID)).toBe(false);
    expect(fallback).toHaveBeenCalledTimes(1);

    disposeFallback();
  });

  it("treats throwing handlers as not handled and keeps asking", () => {
    const target = createTarget();
    const binding = install(target)!;
    const broken = vi.fn(() => {
      throw new Error("component crashed");
    });
    const handled = vi.fn(() => true);

    binding.onBackPressed(broken);
    binding.onBackPressed(handled);

    expect(installedHost(target).onBackPressed(SESSION_ID)).toBe(true);
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it("keeps one host object and one set of subscriptions per target/session", () => {
    const target = createTarget();
    const first = install(target);
    const host = target[MOBILE_REMOTE_NATIVE_HOST_GLOBAL_KEY];
    const second = install(target);

    expect(second).toBe(first);
    expect(target[MOBILE_REMOTE_NATIVE_HOST_GLOBAL_KEY]).toBe(host);
  });

  it("forwards validated warm clicks and permission results without replaying disposed listeners", () => {
    const target = createTarget();
    const binding = install(target)!;
    const click = vi.fn();
    const permission = vi.fn();
    const disposeClick = binding.onNotificationClick(click);
    const disposePermission = binding.onNotificationPermissionChanged(permission);
    installedHost(target).onNotificationClick(SESSION_ID, {
      backendId: "backend",
      notificationId: "notification",
    });
    installedHost(target).onNotificationClick(SESSION_ID, {
      backendId: "backend",
      notificationId: "",
    });
    // stale session 的 pending 通知不能进入新文档。
    installedHost(target).onNotificationClick("stale-session", {
      backendId: "backend",
      notificationId: "notification",
    });
    installedHost(target).onNotificationPermissionChanged(SESSION_ID, true);
    installedHost(target).onNotificationPermissionChanged(SESSION_ID, "true");
    installedHost(target).onNotificationPermissionChanged("stale-session", true);
    expect(click).toHaveBeenCalledTimes(1);
    expect(permission).toHaveBeenCalledExactlyOnceWith(true);
    disposeClick();
    disposePermission();
    installedHost(target).onNotificationClick(SESSION_ID, {
      backendId: "b",
      notificationId: "n",
    });
    installedHost(target).onNotificationPermissionChanged(SESSION_ID, false);
    expect(click).toHaveBeenCalledTimes(1);
    expect(permission).toHaveBeenCalledTimes(1);
  });
});

describe("mobile remote native host M2-T5 dispatch shape", () => {
  it("accepts single-payload events from MobileBridgeEventDispatcher", () => {
    const target = createTarget();
    const binding = install(target)!;
    const lifecycle = vi.fn();
    const click = vi.fn();
    binding.onAppLifecycleChange(lifecycle);
    binding.onNotificationClick(click);

    const host = installedHost(target) as unknown as {
      onAppLifecycle(state: unknown): void;
      onNotificationClick(value: unknown): void;
      onBackPressed(): boolean;
    };
    host.onAppLifecycle("foreground");
    host.onNotificationClick({ backendId: "b", notificationId: "n" });

    expect(lifecycle).toHaveBeenCalledExactlyOnceWith("foreground");
    expect(click).toHaveBeenCalledExactlyOnceWith({
      backendId: "b",
      notificationId: "n",
    });
    expect(host.onBackPressed()).toBe(false);
    expect(target[MOBILE_REMOTE_NATIVE_HOST_GLOBAL_KEY]).toBeDefined();
  });
});

describe("mobile remote native host notification action (E4)", () => {
  it("forwards validated action clicks and drops malformed payloads", () => {
    const target = createTarget();
    const binding = install(target)!;

    const handler = vi.fn();
    binding.onNotificationAction(handler);

    const host = installedHost(target);
    host.onNotificationAction(SESSION_ID, {
      backendId: "b",
      notificationId: "n",
      optionId: "opt",
      optionKind: "deny",
    });
    host.onNotificationAction(SESSION_ID, {
      backendId: "b",
      notificationId: "n",
      optionId: "opt",
    });
    host.onNotificationAction(SESSION_ID, {
      backendId: "b",
      notificationId: "n",
      optionKind: "deny",
    });
    host.onNotificationAction(SESSION_ID, "bogus");
    host.onNotificationAction("stale-session", {
      backendId: "b",
      notificationId: "n",
      optionId: "opt",
      optionKind: "deny",
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      backendId: "b",
      notificationId: "n",
      optionId: "opt",
      optionKind: "deny",
    });
  });
});
