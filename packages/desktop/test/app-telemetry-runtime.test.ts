import { describe, expect, it, vi } from "vitest";

describe("app telemetry runtime", () => {
  it("按 renderer id 返回对应的埋点上下文", async () => {
    const { createAppTelemetryRuntime } = await import("../src/main/appTelemetryRuntime.js");
    const runtime = createAppTelemetryRuntime({
      telemetryCore: {
        reportAppLaunch: vi.fn(async () => {}),
        reportAppDailyActive: vi.fn(async () => {}),
      },
      appLaunchCoordinator: {
        onRendererReady: () => false,
      },
    });
    const firstContext = {
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "3024x1964",
    };
    const secondContext = {
      clientTimezone: "Europe/Berlin",
      clientLanguage: "de-DE",
      screenResolution: "1920x1080",
    };

    runtime.syncRendererContext({ rendererId: 1, context: firstContext });
    runtime.syncRendererContext({ rendererId: 2, context: secondContext });

    expect(runtime.getRendererContext(1)).toEqual(firstContext);
    expect(runtime.getRendererContext(2)).toEqual(secondContext);
    expect(runtime.getRendererContext(3)).toBeNull();
  });

  it("waits for renderer context before reporting startup telemetry", async () => {
    const { createAppTelemetryRuntime } = await import("../src/main/appTelemetryRuntime.js");
    const reportAppLaunch = vi.fn(async () => {});
    const reportAppDailyActive = vi.fn(async () => {});
    const runtime = createAppTelemetryRuntime({
      telemetryCore: {
        reportAppLaunch,
        reportAppDailyActive,
      },
      appLaunchCoordinator: {
        onRendererReady: () => true,
      },
    });

    runtime.onRendererReady({ rendererId: 1 });

    expect(reportAppLaunch).not.toHaveBeenCalled();
    expect(reportAppDailyActive).not.toHaveBeenCalled();

    runtime.syncRendererContext({
      rendererId: 1,
      context: {
        clientTimezone: "Asia/Shanghai",
        clientLanguage: "zh-CN",
        screenResolution: "3024x1964",
      },
    });

    await Promise.resolve();

    expect(reportAppLaunch).toHaveBeenCalledWith({
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "3024x1964",
    });
    expect(reportAppDailyActive).toHaveBeenCalledWith({
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "3024x1964",
    });
  });

  it("reports daily active when the app becomes interactive again", async () => {
    const { createAppTelemetryRuntime } = await import("../src/main/appTelemetryRuntime.js");
    const reportAppLaunch = vi.fn(async () => {});
    const reportAppDailyActive = vi.fn(async () => {});
    const runtime = createAppTelemetryRuntime({
      telemetryCore: {
        reportAppLaunch,
        reportAppDailyActive,
      },
      appLaunchCoordinator: {
        onRendererReady: () => false,
      },
    });

    runtime.syncRendererContext({
      rendererId: 1,
      context: {
        clientTimezone: "Asia/Shanghai",
        clientLanguage: "zh-CN",
        screenResolution: "3024x1964",
      },
    });

    runtime.setInteractive(false);
    runtime.setInteractive(true);
    runtime.setInteractive(true);

    await Promise.resolve();

    expect(reportAppLaunch).not.toHaveBeenCalled();
    expect(reportAppDailyActive).toHaveBeenCalledTimes(1);
    expect(reportAppDailyActive).toHaveBeenCalledWith({
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "3024x1964",
    });
  });

  it("uses the daily active heartbeat only while interactive", async () => {
    const { createAppTelemetryRuntime } = await import("../src/main/appTelemetryRuntime.js");
    const reportAppLaunch = vi.fn(async () => {});
    const reportAppDailyActive = vi.fn(async () => {});
    let intervalHandler: (() => void) | null = null;
    const runtime = createAppTelemetryRuntime({
      telemetryCore: {
        reportAppLaunch,
        reportAppDailyActive,
      },
      appLaunchCoordinator: {
        onRendererReady: () => false,
      },
      setInterval: (handler) => {
        intervalHandler = handler;
        return 1;
      },
      clearInterval: vi.fn(),
    });

    runtime.syncRendererContext({
      rendererId: 1,
      context: {
        clientTimezone: "Asia/Shanghai",
        clientLanguage: "zh-CN",
        screenResolution: "3024x1964",
      },
    });

    intervalHandler?.();
    runtime.setInteractive(true);
    intervalHandler?.();
    runtime.setInteractive(false);
    intervalHandler?.();

    await Promise.resolve();

    expect(reportAppLaunch).not.toHaveBeenCalled();
    expect(reportAppDailyActive).toHaveBeenCalledTimes(2);
  });
});
