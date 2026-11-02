// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON } from "@zcode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ModelProviderSection } from "@/settings/ModelProviderSection.js";
import { ModelProviderSectionDetail } from "@/settings/model-provider-section/Detail.js";
import { useModelProviders } from "@/hooks/useModelProviders.js";

vi.mock("@/hooks/useModelProviders.js", () => ({ useModelProviders: vi.fn() }));
vi.mock("@/hooks/useConfirmDialog.js", () => ({
  useConfirmDialog: () => async () => true,
}));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => ({ openExternal: vi.fn() }) }));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/settings/model-provider-section/InlineEditableProviderCard.js", () => ({
  InlineEditableProviderCard: ({ provider }: { provider: ProviderSettingsFormProvider }) =>
    createElement("div", { "data-testid": "provider-detail" }, provider.providerId),
}));

afterEach(cleanup);

const provider: ProviderSettingsFormProvider = {
  providerId: "empty-state-regression",
  providerName: "Regression Provider",
  enabled: true,
  executable: false,
  hasPersonalConfig: true,
  personalConfig: { group: "standard-personal" },
  config: { group: "standard-personal" },
  models: [],
};

function setView({ loading = false, providers = [] as ProviderSettingsFormProvider[] } = {}) {
  vi.mocked(useModelProviders).mockReturnValue({
    loading,
    loadError: null,
    refreshing: false,
    modelProviders: providers,
    providerTemplates: [],
    refresh: vi.fn(),
  } as unknown as ReturnType<typeof useModelProviders>);
}

function section(locale: "en-US" | "zh-CN" = "en-US") {
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: locale },
    createElement(ModelProviderSection),
  );
}

describe("模型设置空状态", () => {
  it.each([
    [
      "en-US",
      "No custom model providers yet",
      "Connect your own API endpoint to use its models in chat.",
      "Add provider",
    ],
    [
      "zh-CN",
      "暂无自定义模型供应商",
      "连接你自己的 API 地址，即可在对话中使用其模型。",
      "添加供应商",
    ],
  ] as const)(
    "%s：加载完成的空列表显示全宽空状态和唯一添加入口",
    (locale, emptyLabel, emptyDescription, addLabel) => {
      setView();
      const { container } = render(section(locale));
      expect(screen.getByText(emptyLabel)).toBeTruthy();
      expect(screen.getByText(emptyDescription)).toBeTruthy();
      expect(screen.getAllByRole("button", { name: addLabel })).toHaveLength(1);
      expect(screen.getByRole("button", { name: addLabel }).getAttribute("data-testid")).toBe(
        TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON,
      );
      const emptyState = container.querySelector('[data-model-provider-empty="true"]');
      expect(emptyState).toBeTruthy();
      expect(emptyState!.querySelectorAll("button")).toHaveLength(0);
      expect(container.querySelector('[data-model-provider-split-panel="true"]')).toBeNull();
      expect(container.querySelector('[data-model-provider-navigation-scroll="true"]')).toBeNull();
      expect(container.querySelector(".animate-spin")).toBeNull();
    },
  );

  it("首次读取完成后从 Loading 切换为空状态", () => {
    setView({ loading: true });
    const view = render(section());
    expect(screen.getByText("Loading...")).toBeTruthy();
    expect(screen.queryByText("No custom model providers yet")).toBeNull();
    setView();
    view.rerender(section());
    expect(screen.getByText("No custom model providers yet")).toBeTruthy();
    expect(screen.queryByText("Loading...")).toBeNull();
  });

  it("空状态只通过页头添加入口打开现有选择器，返回后恢复空状态", () => {
    setView();
    render(section());
    fireEvent.click(screen.getByTestId(TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON));
    expect(screen.queryByText("No custom model providers yet")).toBeNull();
    expect(document.querySelector('[data-testid="model-provider-template-picker"]')).toBeTruthy();
    expect(document.querySelector('[data-model-provider-navigation-scroll="true"]')).toBeNull();
    fireEvent.click(document.querySelector('[data-testid="model-provider-template-back-button"]')!);
    expect(screen.getByText("No custom model providers yet")).toBeTruthy();
    expect(screen.queryByText("Loading...")).toBeNull();
  });

  it("有 Provider 时展示详情，最后一个 Provider 删除后的新 View 恢复空状态", async () => {
    setView({ providers: [provider] });
    const view = render(section());
    await waitFor(() =>
      expect(screen.getByTestId("provider-detail").textContent).toBe(provider.providerId),
    );
    expect(screen.queryByText("No custom model providers yet")).toBeNull();
    setView();
    view.rerender(section());
    expect(screen.getByText("No custom model providers yet")).toBeTruthy();
    expect(screen.queryByTestId("provider-detail")).toBeNull();
    expect(screen.queryByText("Loading...")).toBeNull();
  });

  it("已有 Provider 但导航选择尚未收敛时不提前显示空状态", () => {
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(ModelProviderSectionDetail, {
          selectedNavItem: null,
          onSave: vi.fn(),
          onDelete: vi.fn(),
          onTestModel: vi.fn(),
          onOpenApiKeyUrl: vi.fn(),
        }),
      ),
    );
    expect(screen.getByText("Loading...")).toBeTruthy();
    expect(screen.queryByText("No custom model providers yet")).toBeNull();
  });
});
