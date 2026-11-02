// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TID_MODEL_PROVIDER_TEMPLATE_ITEM,
  TID_MODEL_PROVIDER_TEMPLATE_PICKER,
  testId,
} from "@zody/shared";
import { ProviderTemplatePicker } from "@/settings/model-provider-section/ProviderTemplatePicker.js";
import { ProviderDetailFeedbackBoundary } from "@/settings/model-provider-section/ProviderDetailFeedback.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

const loggerMock = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("@/logger.js", () => ({ logger: loggerMock }));

afterEach(cleanup);

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string>) => {
        const message =
          {
            "settings.modelProvider.templatePickerTitle": "添加供应商",
            "settings.modelProvider.templatePickerBack": "返回供应商详情",
            "settings.modelProvider.createCustomProvider": "创建自定义供应商",
            "settings.modelProvider.templateCreateFailed": "创建供应商失败：个人供应商配置格式无效",
            "settings.modelProvider.templateCreateRetry": "重试",
          }[id] ?? id;
        return message.replace("{reason}", values?.reason ?? "");
      },
    },
  }),
}));

describe("ProviderTemplatePicker", () => {
  it("按 Settings View 顺序展示本地化 Template，并提供同页自定义入口", () => {
    const html = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(ProviderTemplatePicker, {
          templates: [
            {
              templateId: "deepseek",
              templateNameMap: { "zh-CN": "深度求索", "en-US": "DeepSeek" },
              config: { logo: { type: "builtin", key: "deepseek" } },
            },
            {
              templateId: "long-name",
              templateNameMap: { "en-US": "Alibaba Model Studio (International)" },
              config: {},
            },
          ],
          onBack: vi.fn(),
          onCreateFromTemplate: vi.fn(),
          onCreateCustom: vi.fn(),
          creating: false,
        }),
      ),
    );

    expect(html).toContain("添加供应商");
    expect(html).toContain(`data-testid="${TID_MODEL_PROVIDER_TEMPLATE_PICKER}"`);
    expect(html).toContain(`data-testid="${testId(TID_MODEL_PROVIDER_TEMPLATE_ITEM, "custom")}"`);
    expect(html).toContain(`data-testid="${testId(TID_MODEL_PROVIDER_TEMPLATE_ITEM, "deepseek")}"`);
    expect(html).toContain("创建自定义供应商");
    expect(html).toContain("深度求索");
    expect(html).toContain("Alibaba Model Studio (International)");
    expect(html.indexOf("深度求索")).toBeLessThan(
      html.indexOf("Alibaba Model Studio (International)"),
    );
    expect(html).toContain("h-16");
    expect(html).toContain("break-words");
    expect(html).toContain("lucide-chevron-right");
    expect(html).not.toContain("h-20");
    expect(html).not.toContain("line-clamp-2");
    expect(html).not.toContain('type="search"');
  });

  it("MiMo API 与 Token Plan 以两个独立模板出现在添加列表并可分别创建", async () => {
    // 设置页回归读取正式 Built-in 配置，防止模板拆分后只剩一个入口或端点串用。
    // 路径从测试文件定位仓库根：不能用 process.cwd()（`pnpm --dir packages/ui` 会落到包目录），
    // 也不能在 jsdom 环境对相对 URL 做 resolve（Vite 会改写成 http://localhost/@fs/...）。
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const builtin = JSON.parse(
      await readFile(resolve(repoRoot, "config/provider/zcode-builtin.json"), "utf8"),
    );
    const templates = builtin.config.providerConfigRules.templateRules.filter(
      (template: { templateId: string }) =>
        template.templateId === "xiaomi-mimo" || template.templateId === "xiaomi-mimo-token-plan",
    );
    expect(templates.map((template: { templateId: string }) => template.templateId)).toEqual([
      "xiaomi-mimo",
      "xiaomi-mimo-token-plan",
    ]);
    const onCreateFromTemplate = vi.fn<(templateId: string) => Promise<void>>().mockResolvedValue();

    render(
      createElement(
        TooltipProvider,
        null,
        createElement(ProviderTemplatePicker, {
          templates,
          onBack: vi.fn(),
          onCreateFromTemplate,
          onCreateCustom: vi.fn(),
          creating: false,
        }),
      ),
    );

    expect(await screen.findByRole("button", { name: "Xiaomi MiMo API" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Xiaomi MiMo Token Plan" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Xiaomi MiMo API" }));
    await waitFor(() => expect(onCreateFromTemplate).toHaveBeenLastCalledWith("xiaomi-mimo"));
    fireEvent.click(screen.getByRole("button", { name: "Xiaomi MiMo Token Plan" }));
    await waitFor(() =>
      expect(onCreateFromTemplate).toHaveBeenLastCalledWith("xiaomi-mimo-token-plan"),
    );
  });

  it("Template 创建失败时在详情底部显示错误并允许重试", async () => {
    const onCreateFromTemplate = vi
      .fn<(templateId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("写入失败"))
      .mockResolvedValueOnce();

    render(
      createElement(
        ProviderDetailFeedbackBoundary,
        null,
        createElement(
          TooltipProvider,
          null,
          createElement(ProviderTemplatePicker, {
            templates: [
              {
                templateId: "deepseek",
                templateNameMap: { "zh-CN": "DeepSeek" },
                config: { logo: { type: "builtin", key: "deepseek" } },
              },
            ],
            onBack: vi.fn(),
            onCreateFromTemplate,
            onCreateCustom: vi.fn(),
            creating: false,
          }),
        ),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "DeepSeek" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "创建供应商失败：个人供应商配置格式无效",
    );
    expect(loggerMock.error).toHaveBeenCalledWith(
      "[ProviderTemplatePicker] 创建供应商失败",
      expect.any(Error),
    );

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(onCreateFromTemplate).toHaveBeenCalledTimes(2));
    expect(onCreateFromTemplate).toHaveBeenLastCalledWith("deepseek");
  });
});
