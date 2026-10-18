import { describe, expect, it, beforeEach, vi } from "vitest";
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";

const reportAppTelemetryEventMock = vi.fn(async () => {});
const resolveProviderTelemetryLabelMock = vi.fn((providerId: string) =>
  providerId === ZAI_PROVIDER_ID ? "z.ai" : "bigmodel",
);

vi.mock("@/lib/appTelemetry.js", () => ({
  reportAppTelemetryEvent: reportAppTelemetryEventMock,
  resolveProviderTelemetryLabel: resolveProviderTelemetryLabelMock,
}));

vi.mock("@/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("handleOAuthCallbackSuccess", () => {
  beforeEach(() => {
    reportAppTelemetryEventMock.mockClear();
    resolveProviderTelemetryLabelMock.mockClear();
  });

  it("应用登录回调会更新 user、清理错误并上报登录埋点", async () => {
    const { handleOAuthCallbackSuccess } = await import("@/root/useRootOAuthEffects.js");
    const setUser = vi.fn();
    const setOAuthError = vi.fn();
    const refreshProviderState = vi.fn(async () => {});
    const refreshLatestModelProviderFamilySelection = vi.fn(async () => null);
    const setProviderFamilyDomain = vi.fn(async () => {});
    const platform = {
      reportTelemetryEvent: vi.fn(async () => {}),
    };

    await handleOAuthCallbackSuccess({
      result: {
        kind: "session",
        provider: BIGMODEL_PROVIDER_ID,
        userInfo: {
          id: "user-1",
          username: "bigmodel-user",
          displayName: "BigModel User",
        },
      },
      platform,
      refreshLatestModelProviderFamilySelection,
      refreshProviderState,
      setProviderFamilyDomain,
      setUser,
      setOAuthError,
    });

    expect(setUser).toHaveBeenCalledWith({
      id: "user-1",
      username: "bigmodel-user",
      displayName: "BigModel User",
    });
    expect(setOAuthError).toHaveBeenCalledWith(null);
    expect(setProviderFamilyDomain).toHaveBeenCalledWith(BIGMODEL_PROVIDER_ID);
    expect(refreshLatestModelProviderFamilySelection).toHaveBeenCalledWith(BIGMODEL_PROVIDER_ID);
    expect(refreshProviderState).toHaveBeenCalledOnce();
    expect(reportAppTelemetryEventMock).toHaveBeenCalledTimes(1);
  });

  it("Provider Family 选择校正失败不应阻断 OAuth 登录成功态", async () => {
    const { handleOAuthCallbackSuccess } = await import("@/root/useRootOAuthEffects.js");
    const setUser = vi.fn();
    const setOAuthError = vi.fn();
    const refreshProviderState = vi.fn(async () => {});
    const setProviderFamilyDomain = vi.fn(async () => {});
    const refreshLatestModelProviderFamilySelection = vi.fn(async () => {
      throw new Error("selection failed");
    });
    const platform = {
      reportTelemetryEvent: vi.fn(async () => {}),
    };

    await expect(
      handleOAuthCallbackSuccess({
        result: {
          kind: "session",
          provider: BIGMODEL_PROVIDER_ID,
          userInfo: {
            id: "user-1",
            username: "bigmodel-user",
            displayName: "BigModel User",
          },
        },
        platform,
        refreshLatestModelProviderFamilySelection,
        refreshProviderState,
        setProviderFamilyDomain,
        setUser,
        setOAuthError,
      }),
    ).resolves.toBeUndefined();

    expect(setUser).toHaveBeenCalledWith({
      id: "user-1",
      username: "bigmodel-user",
      displayName: "BigModel User",
    });
    expect(setOAuthError).toHaveBeenCalledWith(null);
    expect(setProviderFamilyDomain).toHaveBeenCalledWith(BIGMODEL_PROVIDER_ID);
    expect(refreshLatestModelProviderFamilySelection).toHaveBeenCalledWith(BIGMODEL_PROVIDER_ID);
    expect(refreshProviderState).toHaveBeenCalledOnce();
    expect(reportAppTelemetryEventMock).toHaveBeenCalledTimes(1);
  });

  it("Team Plan 选择收敛后统一刷新 Provider Runtime", async () => {
    const { handleOAuthCallbackSuccess } = await import("@/root/useRootOAuthEffects.js");
    const events: string[] = [];
    const setUser = vi.fn();
    const setOAuthError = vi.fn();
    const refreshProviderState = vi.fn(async () => {
      events.push("provider-state");
    });
    const refreshAppSettings = vi.fn(async () => {
      events.push("settings");
    });
    const refreshLatestModelProviderFamilySelection = vi.fn(async () => {
      events.push("selection");
      return {
        kind: "team-coding-plan" as const,
        productId: "product-team",
        organizationId: "org-1",
        projectId: "project-1",
      };
    });
    const setProviderFamilyDomain = vi.fn(async () => {});
    const platform = {
      reportTelemetryEvent: vi.fn(async () => {}),
    };

    await handleOAuthCallbackSuccess({
      result: {
        kind: "session",
        provider: BIGMODEL_PROVIDER_ID,
        userInfo: {
          id: "user-1",
          username: "bigmodel-user",
          displayName: "BigModel User",
        },
      },
      platform,
      refreshLatestModelProviderFamilySelection,
      refreshAppSettings,
      refreshProviderState,
      setProviderFamilyDomain,
      setUser,
      setOAuthError,
    });

    expect(events).toEqual(["selection", "settings", "provider-state"]);
  });

  it("个人 Coding Plan 选择收敛后统一刷新 Provider Runtime", async () => {
    const { handleOAuthCallbackSuccess } = await import("@/root/useRootOAuthEffects.js");
    const events: string[] = [];
    const setUser = vi.fn();
    const setOAuthError = vi.fn();
    const refreshProviderState = vi.fn(async () => {
      events.push("provider-state");
    });
    const refreshAppSettings = vi.fn(async () => {
      events.push("settings");
    });
    const refreshLatestModelProviderFamilySelection = vi.fn(async () => {
      events.push("selection");
      return { kind: "individual-coding-plan" as const };
    });
    const setProviderFamilyDomain = vi.fn(async () => {});
    const platform = {
      reportTelemetryEvent: vi.fn(async () => {}),
    };

    await handleOAuthCallbackSuccess({
      result: {
        kind: "session",
        provider: ZAI_PROVIDER_ID,
        userInfo: {
          id: "user-1",
          username: "zai-user",
          displayName: "Z.ai User",
        },
      },
      platform,
      refreshLatestModelProviderFamilySelection,
      refreshAppSettings,
      refreshProviderState,
      setProviderFamilyDomain,
      setUser,
      setOAuthError,
    });

    expect(events).toEqual(["selection", "settings", "provider-state"]);
  });

  it("Start Plan 选择收敛后统一刷新 Provider Runtime", async () => {
    const { handleOAuthCallbackSuccess } = await import("@/root/useRootOAuthEffects.js");
    const events: string[] = [];
    const setUser = vi.fn();
    const setOAuthError = vi.fn();
    const refreshProviderState = vi.fn(async () => {
      events.push("provider-state");
    });
    const refreshAppSettings = vi.fn(async () => {
      events.push("settings");
    });
    const refreshLatestModelProviderFamilySelection = vi.fn(async () => {
      events.push("selection");
      return { kind: "start-plan" as const };
    });
    const setProviderFamilyDomain = vi.fn(async () => {});
    const platform = {
      reportTelemetryEvent: vi.fn(async () => {}),
    };

    await handleOAuthCallbackSuccess({
      result: {
        kind: "session",
        provider: ZAI_PROVIDER_ID,
        userInfo: {
          id: "user-1",
          username: "zai-user",
          displayName: "Z.ai User",
        },
      },
      platform,
      refreshLatestModelProviderFamilySelection,
      refreshAppSettings,
      refreshProviderState,
      setProviderFamilyDomain,
      setUser,
      setOAuthError,
    });

    expect(events).toEqual(["selection", "settings", "provider-state"]);
  });
});
