import { afterEach, describe, expect, it, vi } from "vitest";
import { BarChart3, Blocks, Cable, Package, WandSparkles } from "lucide-react";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

async function loadSettingsPageConfig(env: "test" | "production") {
  vi.resetModules();
  vi.doMock("@zody/shared", async () => {
    const actual = await vi.importActual<typeof import("@zody/shared")>("@zody/shared");
    return {
      ...actual,
      ZODY_ENV: env,
    };
  });

  return import("../src/settings/settingsPageConfig.js");
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("settingsPageConfig", () => {
  it("按设置页心智顺序展示 test 分区", async () => {
    const { createSettingsPageConfig } = await loadSettingsPageConfig("test");
    const { settingsSectionGroups, settingsSections } = createSettingsPageConfig({});

    expect(
      settingsSectionGroups.map((group) => ({
        id: group.id,
        sections: group.sections.map((section) => section.id),
      })),
    ).toEqual([
      {
        id: "basics",
        sections: ["general", "appearance", "modelProvider", "browser", "shortcuts"],
      },
      {
        id: "agentCapabilities",
        sections: ["memory", "subagents", "plugin", "mcp", "skill", "commands", "hooks"],
      },
      {
        id: "dataAndStats",
        sections: ["usage"],
      },
    ]);

    expect(settingsSections.map((section) => section.id)).toEqual([
      "general",
      "appearance",
      "modelProvider",
      "memory",
      "subagents",
      "plugin",
      "mcp",
      "skill",
      "commands",
      "hooks",
      "browser",
      "shortcuts",
      "usage",
    ]);
  });

  it("按设置页心智顺序展示 production 分区并保留 usage", async () => {
    const { createSettingsPageConfig } = await loadSettingsPageConfig("production");
    const { settingsSections } = createSettingsPageConfig({});

    expect(settingsSections.map((section) => section.id)).toEqual([
      "general",
      "appearance",
      "modelProvider",
      "memory",
      "subagents",
      "plugin",
      "mcp",
      "skill",
      "commands",
      "hooks",
      "browser",
      "shortcuts",
      "usage",
    ]);
  });

  it("Plugins 内容标题不再配置 beta 徽标", async () => {
    const { SETTINGS_SECTIONS } = await loadSettingsPageConfig("test");
    const pluginsSection = SETTINGS_SECTIONS.find((section) => section.id === "plugin");

    expect(pluginsSection?.titleBadgeId).toBeUndefined();
  });

  it("Models 与 Plugins 菜单使用统一资源图标", async () => {
    const { SETTINGS_SECTIONS } = await loadSettingsPageConfig("test");
    expect(SETTINGS_SECTIONS.find((section) => section.id === "modelProvider")?.icon).toBe(Package);
    expect(SETTINGS_SECTIONS.find((section) => section.id === "plugin")?.icon).toBe(Blocks);
    expect(SETTINGS_SECTIONS.find((section) => section.id === "mcp")?.icon).toBe(Cable);
    expect(SETTINGS_SECTIONS.find((section) => section.id === "skill")?.icon).toBe(WandSparkles);
  });

  it("Usage 分区文案和头像菜单使用统计入口保持一致", async () => {
    const { SETTINGS_SECTIONS } = await loadSettingsPageConfig("test");
    const usageSection = SETTINGS_SECTIONS.find((section) => section.id === "usage");

    expect(usageSection?.icon).toBe(BarChart3);
    // fork（F4.5）：侧栏「打开用量统计」套餐入口随官方套餐删除，这里只校验设置分区文案存在。
    expect(enUS["settings.usageTitle"]).toBeTruthy();
    expect(enUS["settings.usage.sectionTitle"]).toBeTruthy();
    expect(zhCN["settings.usageTitle"]).toBeTruthy();
  });

  it("手机 Web Remote Control 才出现连接分区，桌面与普通 Web 保持原列表", async () => {
    const { createSettingsPageConfig, resolveSettingsSectionForPlatform } =
      await loadSettingsPageConfig("test");

    const mobile = createSettingsPageConfig({ isWebRemoteControlMobile: true });
    expect(mobile.settingsSectionGroups[0]?.sections.map((section) => section.id)).toEqual([
      "general",
      "appearance",
      "connection",
      "modelProvider",
      "browser",
      "shortcuts",
    ]);
    expect(
      resolveSettingsSectionForPlatform("connection", mobile.settingsSections, "general"),
    ).toBe("connection");

    for (const options of [{}, { isDesktop: true }, { isMacDesktop: true }] as const) {
      const config = createSettingsPageConfig(options);
      expect(config.settingsSections.some((section) => section.id === "connection")).toBe(false);
      expect(
        resolveSettingsSectionForPlatform("connection", config.settingsSections, "general"),
      ).toBe("general");
    }
  });

  it("侧栏分组标题同时提供中英文文案", () => {
    expect(enUS["settings.sidebar.group.basics"]).toBe("Basics");
    expect(enUS["settings.sidebar.group.agentCapabilities"]).toBe("Agent capabilities");
    expect(enUS["settings.sidebar.group.dataAndStats"]).toBe("Data and statistics");
    expect(zhCN["settings.sidebar.group.basics"]).toBe("基础设置");
    expect(zhCN["settings.sidebar.group.agentCapabilities"]).toBe("Agent 能力");
    expect(zhCN["settings.sidebar.group.dataAndStats"]).toBe("数据与统计");
  });

  it.each([
    ["macOS", { isMacDesktop: true }, true],
    ["Windows", { isWindowsDesktop: true }, true],
    ["Linux 桌面", { isDesktop: true }, true],
    ["Web", {}, false],
  ] as const)(
    "%s 的电脑控制入口符合桌面平台边界",
    async (_name, options, expected) => {
      const { createSettingsPageConfig, resolveSettingsSectionForPlatform } =
        await loadSettingsPageConfig("test");
      const { settingsSections } = createSettingsPageConfig(options);

      // 分区显隐按平台呈现（specs/computer-use-settings-unification.md）：
      // 桌面显示入口，分区内容形态（占位说明卡/narrow 开关）由能力信号另行决定。
      expect(settingsSections.some((section) => section.id === "computerUse")).toBe(expected);
      expect(settingsSections.some((section) => section.id === "browser")).toBe(true);
      // 桌面端 composer 入口点击落点必须能回到 computerUse 分区（死胡同修复的验收面）。
      expect(resolveSettingsSectionForPlatform("computerUse", settingsSections, "general")).toBe(
        expected ? "computerUse" : "general",
      );
    },
  );

  it("电脑控制紧跟浏览器，位于快捷键之前", async () => {
    const { createSettingsPageConfig } = await loadSettingsPageConfig("test");
    const { settingsSectionGroups } = createSettingsPageConfig({ isMacDesktop: true });
    const basics = settingsSectionGroups.find((group) => group.id === "basics");

    expect(basics?.sections.map((section) => section.id)).toEqual([
      "general",
      "appearance",
      "modelProvider",
      "browser",
      "computerUse",
      "shortcuts",
      "remoteAccess",
    ]);
    expect(
      settingsSectionGroups
        .find((group) => group.id === "agentCapabilities")
        ?.sections.some((section) => section.id === "computerUse"),
    ).toBe(false);
  });

  it("不可见的电脑控制落点回退到 general", async () => {
    const { createSettingsPageConfig, resolveSettingsSectionForPlatform } =
      await loadSettingsPageConfig("test");
    const { settingsSections } = createSettingsPageConfig({});

    expect(resolveSettingsSectionForPlatform("computerUse", settingsSections, "general")).toBe(
      "general",
    );
  });

  it.each([
    ["macOS", { isMacDesktop: true }, true],
    ["Windows", { isWindowsDesktop: true }, true],
    ["Linux 桌面", { isDesktop: true }, true],
    ["Web", {}, false],
  ] as const)("%s 的远程访问入口符合桌面平台边界", async (_name, options, expected) => {
    const { createSettingsPageConfig } = await loadSettingsPageConfig("test");
    const { settingsSections } = createSettingsPageConfig(options);

    expect(settingsSections.some((section) => section.id === "remoteAccess")).toBe(expected);
  });

  it("Web 的兼容分区列表不包含远程访问", async () => {
    const { SETTINGS_SECTIONS } = await loadSettingsPageConfig("test");

    expect(SETTINGS_SECTIONS.some((section) => section.id === "remoteAccess")).toBe(false);
  });

  it("远程访问分区提供中英文标题", () => {
    expect(zhCN["settings.remoteAccess.title"]).toBe("远程访问");
    expect(enUS["settings.remoteAccess.title"]).toBe("Remote access");
  });
});
