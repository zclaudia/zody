import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
} from "@zcode/shared";
import {
  LOCAL_MODEL_CONTEXT_BUDGET_STRATEGY,
  resolveLocalDynamicWorkflowClientConfig,
  resolveLocalRequestVerificationConfig,
} from "../src/client-config/localClientConfig.js";
import { createClientConfigService } from "../src/client-config/clientConfigService.js";

// fork（F2.6b）client-config 本地值（阶段 2 细则 D1b）：/api/v1/client/configs 不再被请求，
// 动态工作流 offer、请求验证与上下文预算的取值与改造前「远端缺省 / 断网」回落一致。

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveLocalDynamicWorkflowClientConfig", () => {
  it("无覆盖时固定提供 onDemand，来源 default（fork 产品决策）", async () => {
    await expect(resolveLocalDynamicWorkflowClientConfig({ env: {} })).resolves.toEqual({
      mode: "onDemand",
      enabled: true,
      source: "default",
      offeredMode: "onDemand",
    });
  });

  it.each([
    ["disabled", "disabled", false],
    ["onDemand", "onDemand", true],
    ["alwaysOn", "alwaysOn", true],
  ])("ZCODE_DYNAMIC_WORKFLOW_MODE=%s 覆盖缺省值（三档规则不变，来源 override）", async (raw, mode, enabled) => {
    await expect(
      resolveLocalDynamicWorkflowClientConfig({ env: { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: raw } }),
    ).resolves.toEqual({
      mode,
      enabled,
      source: "override",
      offeredMode: mode,
    });
  });

  it("非法覆盖被忽略，落到缺省 onDemand/default", async () => {
    await expect(
      resolveLocalDynamicWorkflowClientConfig({ env: { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: "on" } }),
    ).resolves.toMatchObject({ mode: "onDemand", source: "default" });
  });

  it("用户选择叠加在提供值上：offeredMode 保持 onDemand，mode 记生效值", async () => {
    await expect(
      resolveLocalDynamicWorkflowClientConfig({
        env: {},
        resolveUserMode: async () => "alwaysOn",
      }),
    ).resolves.toEqual({
      mode: "alwaysOn",
      enabled: true,
      source: "default",
      offeredMode: "onDemand",
      userMode: "alwaysOn",
    });
  });

  it("用户选择 disabled 时功能生效值为关，但提供仍在（可再次选择）", async () => {
    await expect(
      resolveLocalDynamicWorkflowClientConfig({
        env: {},
        resolveUserMode: async () => "disabled",
      }),
    ).resolves.toMatchObject({ mode: "disabled", enabled: false, offeredMode: "onDemand" });
  });

  it("没有注入用户选择权威时只返回提供值（desktop-attached-remote 由 desktop 推送）", async () => {
    await expect(resolveLocalDynamicWorkflowClientConfig({})).resolves.toEqual({
      mode: "onDemand",
      enabled: true,
      source: "default",
      offeredMode: "onDemand",
    });
  });
});

describe("client-config 其余本地值", () => {
  it("请求验证配置与远端缺省回落一致（shared 裁决恒 null）", () => {
    expect(resolveLocalRequestVerificationConfig()).toBeNull();
  });

  it("上下文预算策略与改造前固定值一致（preflight-v1）", () => {
    expect(LOCAL_MODEL_CONTEXT_BUDGET_STRATEGY).toBe(
      DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    );
    expect(LOCAL_MODEL_CONTEXT_BUDGET_STRATEGY).toBe("preflight-v1");
  });
});

describe("createClientConfigService（纯本地实现）", () => {
  it("getSnapshot 恒返回远端缺省回落值，且不发起任何请求（无网络依赖可注入）", async () => {
    const service = createClientConfigService();
    await expect(service.getSnapshot()).resolves.toEqual({
      pluginStoreOrder: null,
      zsrcUrl: null,
    });
    // 快照是本地常量：多次读取返回等值副本，不共享可变引用。
    const [a, b] = await Promise.all([service.getSnapshot(), service.getSnapshot()]);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it("getSnapshot 拒绝非法读取选项（保留入参契约）", async () => {
    const service = createClientConfigService();
    await expect(
      service.getSnapshot({ forceRefresh: "yes" } as unknown as { forceRefresh?: boolean }),
    ).rejects.toThrow();
  });

  it("getDynamicWorkflowClientConfig 缺省委托本地解析；注入的解析器优先（装配可换设置权威）", async () => {
    const injected = vi.fn(async () => ({
      mode: "alwaysOn" as const,
      enabled: true,
      source: "override" as const,
      offeredMode: "alwaysOn",
    }));
    const injectedService = createClientConfigService({
      resolveDynamicWorkflowClientConfig: injected,
    });
    await expect(injectedService.getDynamicWorkflowClientConfig()).resolves.toMatchObject({
      mode: "alwaysOn",
    });
    expect(injected).toHaveBeenCalledTimes(1);

    const localService = createClientConfigService();
    await expect(localService.getDynamicWorkflowClientConfig()).resolves.toMatchObject({
      mode: "onDemand",
      source: "default",
    });
  });
});
