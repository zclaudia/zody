import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectArchitectureMismatch,
  formatArchitectureMismatchDialogText,
  maybeWarnArchitectureMismatch,
} from "../src/main/desktopArchitectureGuard.js";

// fork（F2.5）：「前往下载」改读构建期 ZCODE_DOWNLOAD_PAGE_URL（阶段 2 细则
// 「强制升级 gate（删除）」规则 4）。单测环境没有 define 注入，常量恒为空串；
// 用 getter 桩在「未配置 / 已配置」场景间切换——mock 工厂只在首次导入时执行，
// getter 保证函数调用时读到 beforeEach 里设置的当前值。
const downloadPageUrlState = vi.hoisted(() => ({ value: "" }));

vi.mock("@zcode/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zcode/shared")>()),
  get ZCODE_DOWNLOAD_PAGE_URL() {
    return downloadPageUrlState.value;
  },
}));

const electronDialogMocks = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
}));
const electronShellMocks = vi.hoisted(() => ({
  openExternal: vi.fn(async () => {}),
}));

vi.mock("electron", () => ({
  // 架构守卫只读 runningUnderARM64Translation；置 true 即命中弹框分支。
  app: { runningUnderARM64Translation: true },
  dialog: { showMessageBox: electronDialogMocks.showMessageBox },
  shell: { openExternal: electronShellMocks.openExternal },
}));

const logger = { info: vi.fn(), warn: vi.fn() };

// 未注入 parentWindow 时守卫走单参重载，第一个参数即 dialog options。
const lastDialogOptions = () =>
  electronDialogMocks.showMessageBox.mock.calls.at(-1)?.[0] as {
    buttons: string[];
  };

describe("detectArchitectureMismatch", () => {
  it("Apple 芯片上运行 x64 包（Rosetta 转译）应判定为不匹配", () => {
    expect(
      detectArchitectureMismatch({
        platform: "darwin",
        binaryArch: "x64",
        runningUnderARM64Translation: true,
      }),
    ).toEqual({ binaryArch: "x64", nativeArch: "arm64" });
  });

  it("Windows on ARM 上转译运行也应判定为不匹配", () => {
    expect(
      detectArchitectureMismatch({
        platform: "win32",
        binaryArch: "x64",
        runningUnderARM64Translation: true,
      }),
    ).toEqual({ binaryArch: "x64", nativeArch: "arm64" });
  });

  it("原生运行（未转译）应返回 null", () => {
    expect(
      detectArchitectureMismatch({
        platform: "darwin",
        binaryArch: "arm64",
        runningUnderARM64Translation: false,
      }),
    ).toBeNull();
  });

  it("非 macOS/Windows 平台即使报告转译也不误报", () => {
    expect(
      detectArchitectureMismatch({
        platform: "linux",
        binaryArch: "x64",
        runningUnderARM64Translation: true,
      }),
    ).toBeNull();
  });
});

describe("formatArchitectureMismatchDialogText", () => {
  const mismatch = { binaryArch: "x64", nativeArch: "arm64" } as const;

  it("中文文案包含运行架构与推荐架构", () => {
    const text = formatArchitectureMismatchDialogText(mismatch, "zh-CN");
    expect(text.title).toBe("架构不匹配");
    expect(text.detail).toContain("x64");
    expect(text.detail).toContain("arm64");
    expect(text.downloadButton).toBe("前往下载");
  });

  it("英文文案包含运行架构与推荐架构", () => {
    const text = formatArchitectureMismatchDialogText(mismatch, "en-US");
    expect(text.title).toBe("Architecture Mismatch");
    expect(text.detail).toContain("x64");
    expect(text.detail).toContain("arm64");
    expect(text.downloadButton).toBe("Download");
  });
});

describe("maybeWarnArchitectureMismatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    downloadPageUrlState.value = "";
  });

  it("未配置 ZCODE_DOWNLOAD_PAGE_URL 时弹框只有「暂不处理」，不调用 shell.openExternal", async () => {
    electronDialogMocks.showMessageBox.mockResolvedValue({ response: 0 });

    await maybeWarnArchitectureMismatch({
      locale: "zh-CN",
      logger,
      platform: "darwin",
      binaryArch: "x64",
    });

    expect(lastDialogOptions().buttons).toEqual(["暂不处理"]);
    expect(electronShellMocks.openExternal).not.toHaveBeenCalled();
  });

  it("配置后弹框出现「前往下载」，点击时 shell.openExternal 参数等于配置值", async () => {
    const downloadPageUrl = "https://example.com/download";
    downloadPageUrlState.value = downloadPageUrl;
    electronDialogMocks.showMessageBox.mockResolvedValue({ response: 0 });

    await maybeWarnArchitectureMismatch({
      locale: "en-US",
      logger,
      platform: "win32",
      binaryArch: "x64",
    });

    expect(lastDialogOptions().buttons).toEqual(["Download", "Not now"]);
    expect(electronShellMocks.openExternal).toHaveBeenCalledTimes(1);
    expect(electronShellMocks.openExternal).toHaveBeenCalledWith(downloadPageUrl);
    // 阶段 2 细则验收 3：打开的只能是配置值，不得回落到官方下载页。
    expect(electronShellMocks.openExternal).not.toHaveBeenCalledWith(
      expect.stringMatching(/zcode\.z\.ai/),
    );
  });

  it("配置后选择「暂不处理」不打开下载页", async () => {
    downloadPageUrlState.value = "https://example.com/download";
    electronDialogMocks.showMessageBox.mockResolvedValue({ response: 1 });

    await maybeWarnArchitectureMismatch({
      locale: "zh-CN",
      logger,
      platform: "darwin",
      binaryArch: "x64",
    });

    expect(lastDialogOptions().buttons).toEqual(["前往下载", "暂不处理"]);
    expect(electronShellMocks.openExternal).not.toHaveBeenCalled();
  });
});
