import { afterEach, describe, expect, it, vi } from "vitest";

async function importFreshEnvModule() {
  vi.resetModules();
  return await import("../src/env.js");
}

describe("shared runtime env", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("构建期可选能力未注入时关闭，事件上报端点取测试注入值", async () => {
    const env = await importFreshEnvModule();

    // 单测不注入 ARMS 与自动更新；事件上报端点由 vitest.config.ts 固定注入。
    // fork（F3.2）：测试端点使用预留域名 example.invalid，不指向官方服务。
    expect(env.ZODY_ARMS_RUM_ENDPOINT).toBe("");
    expect(env.ZODY_AUTO_UPDATE_ENABLED).toBe(false);
    expect(env.ZODY_TELEMETRY_REPORT_ENDPOINT).toBe("https://example.invalid/api/v1/event/report");
    // 下载页地址未注入时为空串，消费方据此不展示下载入口
    expect(env.ZODY_DOWNLOAD_PAGE_URL).toBe("");
    // fork 反馈地址未注入时为空串，反馈入口不展示「打开反馈地址」（F2.9 入口显隐）
    expect(env.ZODY_FEEDBACK_ISSUE_URL).toBe("");
  });

  it("注入下载页 define 时常量取构建期值", async () => {
    vi.stubGlobal("__ZODY_DOWNLOAD_PAGE_URL__", "https://example.com/download");

    const env = await importFreshEnvModule();

    expect(env.ZODY_DOWNLOAD_PAGE_URL).toBe("https://example.com/download");
  });

  it("注入 fork 反馈地址 define 时常量取构建期值", async () => {
    vi.stubGlobal("__ZODY_FEEDBACK_ISSUE_URL__", "https://example.com/feedback");

    const env = await importFreshEnvModule();

    expect(env.ZODY_FEEDBACK_ISSUE_URL).toBe("https://example.com/feedback");
  });

  // isDesktopAutoUpdateActive 是自动更新唯一判定（production 身份 + 构建期启用，两者缺一不可）
  it("isDesktopAutoUpdateActive 在 production 且构建期启用时才生效", async () => {
    vi.stubGlobal("__ZODY_ENV__", "production");
    vi.stubGlobal("__ZODY_PRODUCT_FLAVOR__", "production");
    vi.stubGlobal("__ZODY_AUTO_UPDATE_ENABLED__", true);
    expect((await importFreshEnvModule()).isDesktopAutoUpdateActive()).toBe(true);

    vi.stubGlobal("__ZODY_PRODUCT_FLAVOR__", "preview");
    vi.stubGlobal("__ZODY_AUTO_UPDATE_ENABLED__", true);
    expect((await importFreshEnvModule()).isDesktopAutoUpdateActive()).toBe(false);

    vi.stubGlobal("__ZODY_PRODUCT_FLAVOR__", "production");
    vi.stubGlobal("__ZODY_AUTO_UPDATE_ENABLED__", false);
    expect((await importFreshEnvModule()).isDesktopAutoUpdateActive()).toBe(false);
  });

  it("未注入 ZODY_ENV 时默认 test 并映射为 local", async () => {
    vi.stubGlobal("__ZODY_ENV__", undefined);

    const env = await importFreshEnvModule();

    expect(env.ZODY_ENV).toBe("test");
    expect(env.normalizeZodyEnv("development")).toBe("test");
    expect(env.mapZodyEnvToArmsRumEnv("production")).toBe("local");
  });

  it("未注入身份 define 时 flavor 跟随 ZODY_ENV", async () => {
    vi.stubGlobal("__ZODY_ENV__", "production");
    vi.stubGlobal("__ZODY_PRODUCT_FLAVOR__", undefined);

    const env = await importFreshEnvModule();

    expect(env.ZODY_PRODUCT_FLAVOR).toBe("production");
    expect(env.normalizeZodyProductFlavor(undefined, "test")).toBe("preview");
    expect(env.normalizeZodyProductFlavor("bogus", "production")).toBe("production");
  });

  it("显式注入 preview 身份时生产后端构建仍是 Preview", async () => {
    vi.stubGlobal("__ZODY_ENV__", "production");
    vi.stubGlobal("__ZODY_PRODUCT_FLAVOR__", "preview");

    const env = await importFreshEnvModule();

    expect(env.ZODY_ENV).toBe("production");
    expect(env.ZODY_PRODUCT_FLAVOR).toBe("preview");
  });

  it("mapZodyEnvToArmsRumEnv 将非本地 production 映射为 prod", async () => {
    vi.stubGlobal("__ZODY_ENV__", "production");

    const env = await importFreshEnvModule();

    expect(env.mapZodyEnvToArmsRumEnv("production")).toBe("prod");
  });

  it("mapZodyEnvToArmsRumEnv 在本地开发态忽略 production 产品环境并映射为 local", async () => {
    vi.stubGlobal("__ZODY_ENV__", "production");

    const env = await importFreshEnvModule();

    expect(env.mapZodyEnvToArmsRumEnv("development")).toBe("local");
  });
});
