import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// fork（F4.1b）：WelcomeScreen 改为 BYOK 引导后，本文件改断言「官方账号登录入口不存在、
// 通用 provider 模板 + API Key 表单存在」，并覆盖无 provider / 已配 BYOK 两态。
// 原 OAuth 登录尝试完成判定（shouldComplete*）随 useOAuth 摘除删除。

const providerTemplatesState = vi.hoisted(() => ({
  templates: [] as Array<{
    templateId: string;
    templateNameMap?: Record<string, string>;
    config: { access?: { type: string; apiKeyManagementUrl?: string }; logo?: unknown };
  }>,
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ openExternal: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({
    providerSettingsService: {
      getView: vi.fn().mockResolvedValue({
        providerTemplates: providerTemplatesState.templates,
      }),
      createPersonalProvider: vi.fn(),
    },
    modelSelectionService: {
      getView: vi.fn().mockResolvedValue({ revision: 0, providers: [] }),
    },
  }),
}));

vi.mock("@/hooks/useProviderSettingsView.js", () => ({
  useProviderSettingsView: () => ({
    state: {
      status: "ready",
      view: { revision: 0, providerTemplates: providerTemplatesState.templates, providers: [] },
    },
  }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: (
        { id }: { id: string },
        _values?: Record<string, unknown>,
      ) => id,
    },
    locale: "zh-CN",
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: unknown) => unknown) =>
    selector({
      user: null,
      markApiKeyLoginSuccess: vi.fn(),
    }),
}));

describe("WelcomeScreen（fork BYOK 引导）", () => {
  it("无 provider 时渲染 BYOK 表单，不出现任何官方 OAuth 登录入口", async () => {
    providerTemplatesState.templates = [];
    const { WelcomeScreen } = await import("@/WelcomeScreen.js");
    const html = renderToStaticMarkup(createElement(WelcomeScreen, { onComplete: vi.fn() }));

    // BYOK 表单存在（provider 选择 + API Key 输入 + 继续/跳过）。
    expect(html).toContain("data-testid=\"login-api-key-provider-trigger\"");
    expect(html).toContain("data-testid=\"login-api-key-input\"");
    expect(html).toContain("data-testid=\"login-api-key-continue-button\"");
    expect(html).toContain("data-testid=\"login-api-key-skip-button\"");
    // 官方 OAuth 登录入口不存在。
    expect(html).not.toContain("data-testid=\"oauth-login-button\"");
    expect(html).not.toContain("login.oauth.button");
    expect(html).not.toContain("login.oauth.noProviders");
    // 不再有「使用 API Key」二级切换（表单即默认态）。
    expect(html).not.toContain("data-testid=\"login-use-api-key-button\"");
  });

  it("已配 BYOK（模板可见）时同样不出现官方入口", async () => {
    providerTemplatesState.templates = [
      {
        templateId: "zai-api",
        templateNameMap: { "en-US": "Z.ai", "zh-CN": "智谱 Z.ai" },
        config: {
          access: { type: "api-key", apiKeyManagementUrl: "https://example.com/apikey-list" },
        },
      },
      {
        templateId: "deepseek",
        templateNameMap: { "en-US": "DeepSeek" },
        config: { access: { type: "api-key" } },
      },
      // 官方套餐 Key 模板不得进入 BYOK 引导。
      {
        templateId: "zai-coding-plan",
        templateNameMap: { "en-US": "Z.ai Coding Plan" },
        config: { access: { type: "zhipu-coding-plan-api-key" } },
      },
    ];
    const { WelcomeScreen } = await import("@/WelcomeScreen.js");
    // Radix Select 关闭态不渲染选项；模板列表内容断言见 forkAccountEntryRemoval.test.tsx
    // 的交互用例。这里静态断言表单存在且无官方入口。
    const html = renderToStaticMarkup(createElement(WelcomeScreen, { onComplete: vi.fn() }));

    expect(html).toContain("data-testid=\"login-api-key-provider-trigger\"");
    expect(html).toContain("data-testid=\"login-api-key-input\"");
    // 官方 OAuth 登录入口不存在。
    expect(html).not.toContain("data-testid=\"oauth-login-button\"");
    expect(html).not.toContain("login.oauth.waiting");
    // 获取 API Key 链接跟随所选模板（静态渲染未选择模板时不出现）。
    expect(html).not.toContain("login.apiKey.getApiKey");
  });

  it("保留主题背景与登录面板外壳样式", async () => {
    providerTemplatesState.templates = [];
    const { WelcomeScreen } = await import("@/WelcomeScreen.js");
    const html = renderToStaticMarkup(createElement(WelcomeScreen, { onComplete: vi.fn() }));

    expect(html).toContain("overflow-hidden bg-background");
    expect(html).toContain("absolute inset-0");
    expect(html).toContain("bg-[linear-gradient");
    expect(html).toContain("border-popover-border");
    expect(html).toContain("shadow-md");
    expect(html).toContain("<h1");
    expect(html).not.toContain("DialogTitle");
  });
});
