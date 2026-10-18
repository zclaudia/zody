import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Settings usage provider tabs", () => {
  // fork（F4.1b）：用量页 Coding Plan tab 摘除（sources 恒为空），
  // 原「connected Coding Plan source 保留」源码断言用例随之删除。

  it("reuses the plugin store Public and Personal segment pill style", async () => {
    const settingsPageSource = await readFile("packages/ui/src/SettingsPage.tsx", "utf8");
    const pluginStoreSource = await readFile(
      "packages/ui/src/settings/PluginStoreListView.tsx",
      "utf8",
    );
    const start = settingsPageSource.indexOf("function SettingsUsageProviderTabs");
    const end = settingsPageSource.indexOf("function isTeamCodingPlanUsageSource", start);
    const usageTabsSource = settingsPageSource.slice(start, end);

    expect(pluginStoreSource).toContain("export function SegmentPill");
    expect(usageTabsSource).toContain("<SegmentPill");
    expect(usageTabsSource).toContain('active={visibleActiveTab === item.id}');
    expect(usageTabsSource).toContain("onClick={() => onTabChange(item.id)}");
    expect(usageTabsSource).toContain('className="flex items-center gap-1.5"');
    expect(usageTabsSource).not.toContain("TabsList");
    expect(usageTabsSource).not.toContain("TabsTrigger");
  });
});
