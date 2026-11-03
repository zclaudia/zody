import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * M3-T2 发布日志边界：
 * - `packages/web` 只能通过公开子入口 `@zcode/ui/logger` 使用现有 UI logger；
 * - 复用 `[ui]` 前缀与生产 no-op 门控；
 * - controller 的诊断 context 不得包含凭证、session、gateway URL。
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("mobile UI release logger", () => {
  it("is importable through the public @zcode/ui/logger subpath", async () => {
    const { logger } = await import("@zcode/ui/logger");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("uses the shared UI logger format and forwards non-sensitive context", async () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.resetModules();
    const { createMobileUiReleaseLogger } =
      await import("../src/mobile-remote/mobileUiReleaseLogger.js");
    const releaseLogger = createMobileUiReleaseLogger();

    releaseLogger.info("mobile-ui release check failed; keeping current document.", {
      reason: "network-error",
      status: 503,
    });

    expect(info).toHaveBeenCalledOnce();
    const args = info.mock.calls[0]!;
    expect(String(args[0])).toContain("ui");
    expect(args).toContain("[mobile-ui-release]");
    expect(args).toContain("mobile-ui release check failed; keeping current document.");
    expect(args).toContainEqual({ reason: "network-error", status: 503 });

    const serialized = JSON.stringify(args);
    expect(serialized).not.toContain("zgd_");
    expect(serialized).not.toMatch(/credential|authorization|sessionId|gatewayUrl/i);
  });

  it("keeps production logging gated by the shared UI logger", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.resetModules();
    const { createMobileUiReleaseLogger } =
      await import("../src/mobile-remote/mobileUiReleaseLogger.js");

    createMobileUiReleaseLogger().error("mobile-ui reload failed to start.", {
      releaseId: "0123456789abcdef01234567",
    });

    expect(error).not.toHaveBeenCalled();
  });
});
