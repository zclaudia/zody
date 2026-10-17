import { join } from "node:path";
import { DesktopCommandIds, PlatformChannels, type Locale } from "@zcode/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import localDefaultAppConfig from "../../../config/default.json" with { type: "json" };

// fork（F2.7）：帮助与社群配置只读内置 config/default.json。这个桩模拟原远端
// /api/v1/client/configs 的返回（链接与内置值完全不同），断言整条菜单/托盘命令链路
// 不会再调用它；若未来有人重新接上远端拉取，本用例会失败。
const remoteHelpConfigStub = vi.hoisted(() =>
  vi.fn(async () =>
    Response.json({
      code: 0,
      data: {
        configs: {
          feedbackUrl: {
            feedback_url: "https://remote-stub.example.com/feedback",
            feedback_use_external_form: true,
            community_urls: {
              "zh-CN": "https://remote-stub.example.com/community-zh",
              "en-US": "https://remote-stub.example.com/community-en",
            },
          },
        },
      },
    }),
  ),
);

const appMock = vi.hoisted(() => ({
  isPackaged: false,
  // 开发态路径约定：packages/desktop 相对上两级即仓库根的 config/default.json。
  getAppPath: vi.fn(() => join(import.meta.dirname, "..")),
}));

vi.mock("electron", () => ({
  app: appMock,
  BrowserWindow: Object.assign(vi.fn(), {
    getFocusedWindow: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  }),
  dialog: {
    showMessageBox: vi.fn(),
  },
  net: {
    // 原实现经 electron net.fetch 拉取远端帮助配置；现在保留桩以证明无人调用。
    fetch: remoteHelpConfigStub,
    request: vi.fn(),
  },
  nativeTheme: {
    shouldUseDarkColors: true,
  },
  session: {
    fromPartition: vi.fn(),
  },
  shell: {
    openExternal: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock("electron-updater", () => {
  class ProviderMock {
    constructor() {}
    get isUseMultipleRangeRequest() {
      return false;
    }
    setRequestHeaders() {}
  }

  return {
    // Bugfix: desktopCommandHandlers 的导入链会加载 autoUpdater 的 manifest provider，
    // mock 必须包含 Provider，否则 Vitest 在模块初始化阶段报缺少 electron-updater 命名导出。
    Provider: ProviderMock,
    default: {
      autoUpdater: {
        autoDownload: false,
        autoInstallOnAppQuit: false,
        logger: undefined,
        on: vi.fn(),
        checkForUpdates: vi.fn(() => Promise.resolve()),
        quitAndInstall: vi.fn(),
      },
    },
  };
});

describe("desktopHelpConfig 只读内置值", () => {
  beforeEach(() => {
    vi.resetModules();
    appMock.getAppPath.mockClear();
    remoteHelpConfigStub.mockClear();
  });

  it("读取仓库内置 config/default.json 并解析为帮助配置", async () => {
    const { createDesktopHelpConfigReader } = await import("../src/main/desktopHelpConfig.js");

    const readHelpConfig = createDesktopHelpConfigReader();
    await expect(readHelpConfig()).resolves.toEqual({
      community_urls: {
        "zh-CN": localDefaultAppConfig.community_urls["zh-CN"],
        "en-US": localDefaultAppConfig.community_urls["en-US"],
      },
      feedback_url: localDefaultAppConfig.feedback_url,
      feedback_use_external_form: localDefaultAppConfig.feedback_use_external_form,
    });
    expect(remoteHelpConfigStub).not.toHaveBeenCalled();
  });

  it("支持注入本地配置来源，非法内容逐字段降级", async () => {
    const { createDesktopHelpConfigReader } = await import("../src/main/desktopHelpConfig.js");

    const readHelpConfig = createDesktopHelpConfigReader({
      readLocalConfig: async () => null,
    });
    await expect(readHelpConfig()).resolves.toEqual({
      community_urls: { "zh-CN": undefined, "en-US": undefined },
      feedback_url: undefined,
      feedback_use_external_form: false,
    });
  });

  // 菜单（desktopApplicationMenu）与托盘（desktopTray）都经 executeDesktopCommand 分发
  // 反馈/社群命令（index.ts 中两处绑定同一 executeDesktopCommandForApp），
  // 这里直接驱动该入口验证两条链路都只使用内置链接。
  it("桩返回不同链接时，社群与反馈命令仍使用内置值，且远端拉取未被调用", async () => {
    const { createDesktopHelpConfigReader } = await import("../src/main/desktopHelpConfig.js");
    const { executeDesktopCommand } = await import("../src/main/desktopCommandHandlers.js");
    const { shell } = await import("electron");

    const readHelpConfig = createDesktopHelpConfigReader();

    for (const locale of ["zh-CN", "en-US"] as const satisfies readonly Locale[]) {
      await executeDesktopCommand({
        ...createCommandOptions(),
        command: DesktopCommandIds.OpenCommunity,
        currentApplicationLocale: locale,
        readHelpConfig,
      });
    }
    expect(shell.openExternal).toHaveBeenNthCalledWith(
      1,
      localDefaultAppConfig.community_urls["zh-CN"],
    );
    expect(shell.openExternal).toHaveBeenNthCalledWith(
      2,
      localDefaultAppConfig.community_urls["en-US"],
    );

    // 内置 feedback_use_external_form=false：反馈走应用内弹窗，不打开任何外链。
    const senderWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    } as never;
    await executeDesktopCommand({
      ...createCommandOptions(),
      command: DesktopCommandIds.OpenFeedback,
      senderWindow,
      readHelpConfig,
    });
    expect(senderWindow.webContents.send).toHaveBeenCalledWith(
      PlatformChannels.OpenFeedbackDialog,
    );

    expect(shell.openExternal).toHaveBeenCalledTimes(2);
    expect(shell.openExternal).not.toHaveBeenCalledWith(
      "https://remote-stub.example.com/community-zh",
    );
    expect(shell.openExternal).not.toHaveBeenCalledWith(
      "https://remote-stub.example.com/feedback",
    );
    // 任务验收点：远端帮助配置桩（含不同链接）从未被调用。
    expect(remoteHelpConfigStub).not.toHaveBeenCalled();
  });

  it("CanOpenCommunity 的取值核心同样只读内置配置", async () => {
    const { createDesktopHelpConfigReader } = await import("../src/main/desktopHelpConfig.js");
    const { resolveCommunityUrl } = await import("../src/main/desktopCommandHandlers.js");

    const communityUrl = await resolveCommunityUrl({
      locale: "zh-CN",
      readHelpConfig: createDesktopHelpConfigReader(),
      logger: { warn: vi.fn() },
    });

    expect(communityUrl).toBe(localDefaultAppConfig.community_urls["zh-CN"]);
    expect(remoteHelpConfigStub).not.toHaveBeenCalled();
  });

  it("正式包从 resources/config 读取内置配置，开发态继续读取仓库配置", async () => {
    const { resolveLocalAppConfigPath } = await import("../src/main/desktopHelpConfig.js");

    // Bugfix：resolveLocalAppConfigPath 用宿主 path.join 拼接，Windows 上分隔符是 `\`，
    // 断言用宿主 join 组装期望值（原断言随实现从 desktopCommandHandlers 迁移到这里）。
    expect(
      resolveLocalAppConfigPath({
        isPackaged: true,
        resourcesPath: "/Applications/ZCode.app/Contents/Resources",
        appPath: "/Applications/ZCode.app/Contents/Resources/app.asar",
      }),
    ).toBe(join("/Applications/ZCode.app/Contents/Resources", "config/default.json"));
    expect(
      resolveLocalAppConfigPath({
        isPackaged: false,
        appPath: "/repo/packages/desktop",
      }),
    ).toBe(join("/repo", "config", "default.json"));
  });
});

function createCommandOptions() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    updateZCodeStdioTapDevMenuState: vi.fn(),
    onZCodeEndpointChanged: vi.fn(),
    onRelaunchApp: vi.fn(async () => undefined),
    settingService: {
      get: vi.fn(async () => ({})),
      update: vi.fn(async () => undefined),
    },
    credentialsDir: "/tmp/zcode-test",
  };
}
