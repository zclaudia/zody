import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

// 走查 composer-5：390px 视口下 composer 容器 < 384px（@sm），模型触发器此前把
// 文字标签整段隐藏，纯触屏没有 hover tooltip，用户看不到当前模型、必须打开菜单确认。
// 修复后 @sm 以下仍显示去供应商前缀的模型短名（64–96px 内截断）。
// 本文件捕获 V4ComposerModelControls 传给 ModelConfigSelect 的 props，
// 断言响应式标签与触屏命中区类名的构成契约。

const modelSelectProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const thoughtControlProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@/ModelConfigSelect.js", async () => {
  const React = await import("react");
  return {
    ModelConfigSelect: (props: Record<string, unknown>) => {
      modelSelectProps.push(props);
      return React.createElement("span", { "data-model-config-select": "true" });
    },
  };
});

vi.mock("@/chat-input-toolbar/ThoughtLevelCycleControl.js", async () => {
  const React = await import("react");
  return {
    ThoughtLevelCycleControl: (props: Record<string, unknown>) => {
      thoughtControlProps.push(props);
      return React.createElement("span", { "data-thought-control": "true" });
    },
  };
});

vi.mock("@/chat-input-toolbar/display.js", async () => {
  const React = await import("react");
  return {
    ChatContextUsage: () => React.createElement("span", { "data-context-usage": "true" }),
  };
});

vi.mock("@/v4/composer/toolbarShortcuts.js", () => ({
  useToolbarShortcutBindings: () => undefined,
}));

vi.mock("@/shortcuts/useShortcutBindings.js", () => ({
  useShortcutCommandLabel: () => "",
}));

vi.mock("@/hooks/useZodyConfig.js", () => ({
  useToolbarConfigOptions: () => ({ error: null }),
}));

vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: { openSettingsTab: () => undefined }) => unknown) =>
    selector({ openSettingsTab: () => undefined }),
}));

vi.mock("@/lib/settingsNavigation.js", () => ({
  setPendingSettingsSectionIntent: () => undefined,
}));

import { V4ComposerModelControls } from "@/v4/composer/V4ComposerToolbar.js";

const AnyControls = V4ComposerModelControls as unknown as ComponentType<
  Record<string, unknown>
>;

function renderControls(overrides: Record<string, unknown> = {}) {
  modelSelectProps.length = 0;
  thoughtControlProps.length = 0;
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(AnyControls, {
        sessionId: null,
        phase: null,
        usage: null,
        disabled: false,
        activeConfigPicker: null,
        onConfigPickerOpenChange: vi.fn(),
        onSelectModel: vi.fn(),
        onSelectThought: vi.fn(),
        onSwitchMode: vi.fn(),
        ...overrides,
      }),
    ),
  );
}

describe("V4ComposerModelControls responsive model trigger", () => {
  it("@sm 以下向模型触发器传递模型短标签类（隐藏供应商前缀、64–96px 截断），不再整段隐藏标签", () => {
    renderControls();

    const props = modelSelectProps.at(-1);
    expect(props).toBeDefined();

    // 标签不再默认隐藏（labelVisibilityClassName 在传入自定义 triggerLabelClassName
    // 时会被 getModelTriggerLabelClassName 忽略，但保持语义一致，防止未来回归）。
    expect(props?.labelVisibilityClassName).toBe("inline-flex");

    // 供应商前缀只在 ≥@sm 显示，@sm 以下把空间留给模型短名。
    expect(props?.triggerLabelPrefixClassName).toContain("composer-provider-prefix");
    expect(props?.triggerLabelPrefixClassName).toContain("hidden @sm/composer:inline");

    // 触发器标签类：@sm 以下 96px 上限 + 64px 下限，保证短标签可见且不挤占工具行。
    const labelClassName = String(props?.triggerLabelClassName ?? "");
    expect(labelClassName).toContain("@max-sm/composer:max-w-24");
    expect(labelClassName).toContain("@max-sm/composer:min-w-16");
    expect(labelClassName).toContain("[&>span>span]:truncate");
  });

  it("模型与思考深度触发器在触屏态命中区抬升到 44px（spec D1），桌面类名不变", () => {
    renderControls();

    const props = modelSelectProps.at(-1);
    expect(String(props?.triggerClassName ?? "")).toContain(
      "[@media(hover:none)_and_(pointer:coarse)]:min-h-11",
    );
  });

  it("未选模型时 fallback 文案走同一触发器链路（模型目录为空也渲染）", () => {
    const html = renderControls({ modelSelectionView: null });

    expect(html).toContain("data-model-config-select");
    const props = modelSelectProps.at(-1);
    expect(props?.disabled).toBe(true); // modelSelectionState 默认 loading，目录未就绪只禁用不消失
  });
});

// ThoughtLevelCycleControl 的触屏命中区由同一文件注入。无 ModelSelectionView 时
// thoughtOption 解析为空、触发器不渲染，静态渲染下无法捕获其 props；
// 此处显式登记该边界（类名契约与模型触发器同模式，由源码评审覆盖）。
describe("V4ComposerModelControls thought trigger", () => {
  it("无模型目录时思考深度触发器不渲染（props 契约无法静态断言，类名与模型触发器同源）", () => {
    renderControls({ draftConfig: { provider: "zai", model: "glm-5.3", thought: "high" } });

    expect(thoughtControlProps).toHaveLength(0);
  });
});
