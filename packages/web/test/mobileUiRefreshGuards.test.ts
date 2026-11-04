import { describe, expect, it } from "vitest";
import {
  MOBILE_UI_REFRESH_BLOCK_REASONS,
  createMobileUiRefreshGuardRegistry,
  type MobileUiRefreshGuard,
} from "../src/mobile-remote/mobileUiRefreshGuards.js";

function guard(id: string, getBlockReason: () => unknown): MobileUiRefreshGuard {
  return { id, getBlockReason: getBlockReason as MobileUiRefreshGuard["getBlockReason"] };
}

describe("MobileUiRefreshGuardRegistry", () => {
  it("没有 guard 时允许刷新", () => {
    const registry = createMobileUiRefreshGuardRegistry();
    expect(registry.evaluate()).toEqual({
      allowed: true,
      reasons: [],
      unknownGuardIds: [],
    });
  });

  it("稳定 reason 集合覆盖 M3 的阻塞来源", () => {
    expect(MOBILE_UI_REFRESH_BLOCK_REASONS).toEqual([
      "composer-draft",
      "pending-optimistic-overlay",
      "unsaved-settings",
      "file-operation",
      "active-overlay",
      "native-operation",
      "background-task",
      "unknown-guard-state",
    ]);
  });

  it("注册返回释放函数，释放后不再阻塞；重复释放无副作用", () => {
    const registry = createMobileUiRefreshGuardRegistry();
    const release = registry.register(guard("composer", () => "composer-draft"));

    expect(registry.evaluate().allowed).toBe(false);
    release();
    release();
    expect(registry.evaluate()).toEqual({
      allowed: true,
      reasons: [],
      unknownGuardIds: [],
    });
  });

  it("多个阻塞原因按注册顺序去重返回", () => {
    const registry = createMobileUiRefreshGuardRegistry();
    registry.register(guard("file", () => "file-operation"));
    registry.register(guard("composer", () => "composer-draft"));
    registry.register(guard("overlay", () => "active-overlay"));
    registry.register(guard("composer-again", () => "composer-draft"));

    expect(registry.evaluate()).toEqual({
      allowed: false,
      reasons: ["file-operation", "composer-draft", "active-overlay"],
      unknownGuardIds: [],
    });
  });

  it("显式 null 表示不阻塞，允许其它 guard 继续评估", () => {
    const registry = createMobileUiRefreshGuardRegistry();
    registry.register(guard("idle", () => null));
    registry.register(guard("file", () => "file-operation"));

    expect(registry.evaluate()).toEqual({
      allowed: false,
      reasons: ["file-operation"],
      unknownGuardIds: [],
    });
  });

  it.each([
    ["undefined", undefined],
    ["非法的未知 reason", "future-blocker"],
    ["非字符串", 1],
    ["返回对象", { blocked: true }],
  ])("%s 属于未知状态，默认阻塞", (_label, value) => {
    const registry = createMobileUiRefreshGuardRegistry();
    registry.register(guard("mystery", () => value));

    expect(registry.evaluate()).toEqual({
      allowed: false,
      reasons: ["unknown-guard-state"],
      unknownGuardIds: ["mystery"],
    });
  });

  it("guard 抛错时默认阻塞，不把异常传播给刷新流程", () => {
    const registry = createMobileUiRefreshGuardRegistry();
    registry.register(
      guard("broken", () => {
        throw new Error("state owner unavailable");
      }),
    );

    expect(registry.evaluate()).toEqual({
      allowed: false,
      reasons: ["unknown-guard-state"],
      unknownGuardIds: ["broken"],
    });
  });

  it("clear 释放全部注册；之后可重新注册", () => {
    const registry = createMobileUiRefreshGuardRegistry();
    const release = registry.register(guard("file", () => "file-operation"));
    registry.clear();
    expect(registry.evaluate().allowed).toBe(true);

    // 旧释放函数在 clear 后仍应幂等。
    release();
    registry.register(guard("composer", () => "composer-draft"));
    expect(registry.evaluate().reasons).toEqual(["composer-draft"]);
  });
});
