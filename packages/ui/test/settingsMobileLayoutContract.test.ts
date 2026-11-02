import { describe, expect, it } from "vitest";
import { readSourceText } from "./readSourceText.js";

function read(relativePath: string): string {
  return readSourceText(new URL(relativePath, import.meta.url), "utf8");
}

describe("settings mobile batch 2 source contract", () => {
  it("SettingsPage 通过轻量展示 context 下发 isMobileSettings，业务组件不自建手机判定", () => {
    const settingsPage = read("../src/SettingsPage.tsx");
    expect(settingsPage).toContain("<SettingsPresentationProvider isMobile={isMobileSettings}>");
    expect(settingsPage).toContain('data-mobile-settings={isMobileSettings ? "true" : undefined}');

    expect(read("../src/settings/SettingsPageParts.tsx")).toContain("useSettingsPresentation");
    expect(read("../src/settings/SettingsPageParts.tsx")).toContain(
      'data-settings-row-layout={isMobile ? "stacked" : "inline"}',
    );
  });

  it("Provider 手机列表/详情复用 selectedNodeKey，并通过 breadcrumb 父级返回", () => {
    const layout = read("../src/settings/model-provider-section/SectionLayout.tsx");
    expect(layout).toContain("useSettingsPresentation");
    expect(layout).toContain('data-model-provider-mobile-list="true"');
    expect(layout).toContain('data-model-provider-mobile-detail="true"');
    expect(layout).toContain("SettingsBreadcrumbReporter");
    expect(layout).toContain("onSectionSelect={onCloseMobileDetail}");
    expect(layout).toContain("mobileList");

    const navigation = read("../src/settings/model-provider-section/Navigation.tsx");
    expect(navigation).toContain("mobileList");
    expect(navigation).toContain("min-h-11");
  });

  it("Shortcuts 手机使用纵向卡片，桌面固定表格保留", () => {
    const section = read("../src/settings/ShortcutSettingsSection.tsx");
    expect(section).toContain("useSettingsPresentation");
    expect(section).toContain('data-settings-shortcuts-list={isMobile ? "cards" : "table"}');

    const row = read("../src/settings/ShortcutBindingRow.tsx");
    expect(row).toContain('data-settings-shortcut-layout="card"');
    expect(row).toContain('data-settings-shortcut-layout="table"');
    expect(row).toContain("grid-cols-[minmax(0,1fr)_minmax(0,1fr)_80px_72px]");
  });

  it("Select 选项/触发器、Switch、搜索清除与 header 操作使用 coarse-pointer 命中区", () => {
    const select = read("../src/components/ui/select.tsx");
    expect(select).toContain("TOUCH_MIN_H_11");
    expect(select.match(/TOUCH_MIN_H_11/g)?.length ?? 0).toBeGreaterThanOrEqual(2);

    expect(read("../src/components/ui/switch.tsx")).toContain(
      "[@media(hover:none)_and_(pointer:coarse)]:after:-inset-y-[14px]",
    );
    expect(read("../src/settings/SettingsSearchInput.tsx")).toContain(
      "SETTINGS_TOUCH_MIN_SIZE_11_CLASS",
    );
    expect(read("../src/settings/SettingsResourceHeaderActions.tsx")).toContain(
      "SETTINGS_TOUCH_MIN_SIZE_11_CLASS",
    );
    expect(read("../src/settings/SettingsHeaderBreadcrumb.tsx")).toContain(
      "SETTINGS_TOUCH_MIN_H_11_CLASS",
    );
  });

  it("设置内使用 vh 的弹层迁移到 dvh，并保留内部滚动", () => {
    const files = [
      "../src/settings/ExternalAgentImportDialog.tsx",
      "../src/settings/AutomationEditView.tsx",
      "../src/settings/InstalledPluginManagement.tsx",
      "../src/settings/AddMarketplaceSourceDialog.tsx",
      "../src/settings/PluginStoreSourcesDialog.tsx",
      "../src/settings/SkillsSection.tsx",
      "../src/settings/model-provider-section/ProviderModelMetadataDialog.tsx",
      "../src/settings/model-provider-section/ModelConfigHelp.tsx",
    ];
    for (const file of files) {
      const source = read(file);
      expect(source, file).not.toMatch(/\b(?:40|60|80|84|100)vh\b/);
      expect(source, file).toMatch(/\b(?:40|60|80|84|100)dvh\b/);
    }
    expect(read("../src/settings/ExternalAgentImportDialog.tsx")).toContain("overflow-auto");
    expect(
      read("../src/settings/model-provider-section/ProviderModelMetadataDialog.tsx"),
    ).toContain("grid-rows-[auto_minmax(0,1fr)_auto_auto]");
  });

  it("设置内触屏普通按钮、输入与 Range 统一命中区，Switch 排除且桌面不命中", () => {
    const styles = read("../src/styles.css");
    const touchScopeStart = styles.indexOf("@media (hover: none) and (pointer: coarse)");
    expect(touchScopeStart).toBeGreaterThan(-1);
    const touchScope = styles.slice(touchScopeStart);

    // 普通按钮统一 44×44；switch 有独立伪元素命中区，不能被拉高视觉尺寸。
    expect(touchScope).toContain(
      'button:not([data-slot="switch"]):not([role="radio"]):not([role="tab"]):not(',
    );
    expect(touchScope).toContain("min-width: 44px;");
    expect(touchScope).toContain("min-height: 44px;");

    // 文本输入/Textarea 至少 44 高，并保持 iOS 16px 兼容字号。
    expect(touchScope).toContain(
      ':is(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="hidden"]), textarea)',
    );
    expect(touchScope).toContain("font-size: var(--text-mobile-input-safe)");

    // Range 视觉轨道仍为 6px，命中区 44px。
    expect(touchScope).toContain('input[type="range"]');
    expect(touchScope).toContain("box-sizing: border-box;");
    expect(touchScope).toContain("height: 44px;");
    expect(touchScope).toContain("padding-block: 19px;");
    expect(touchScope).toContain("background-clip: content-box;");
  });
});
