import type { BrowserWindow, NativeImage } from "electron";
import { ZCODE_DOWNLOAD_PAGE_URL, type Locale } from "@zcode/shared";

export interface ArchitectureMismatch {
  /** 当前运行的二进制架构，例如 x64。 */
  binaryArch: string;
  /** 推荐安装的原生架构，目前翻译运行只会回退到 arm64。 */
  nativeArch: string;
}

export interface DetectArchitectureMismatchOptions {
  platform?: NodeJS.Platform;
  binaryArch?: string;
  /**
   * Electron 的 app.runningUnderARM64Translation：
   * 当 x64/x86 安装包被翻译到 arm64 硬件上运行时为 true
   * （macOS 上的 Rosetta、Windows on ARM）。这正是“装错架构”的典型场景。
   */
  runningUnderARM64Translation?: boolean;
}

/**
 * 判断当前进程是否在“错误架构”下运行。
 *
 * 之所以以 runningUnderARM64Translation 为准而不是直接比对 process.arch 和 os.arch()：
 * Node 在 Apple Silicon 上跑 x64 包时，os.arch() 同样会返回 "x64"（被 Rosetta 透明翻译），
 * 单纯比对两者无法发现差异。translation 标志是唯一可靠的信号。
 */
export function detectArchitectureMismatch(
  options: DetectArchitectureMismatchOptions = {},
): ArchitectureMismatch | null {
  const platform = options.platform ?? process.platform;
  const binaryArch = options.binaryArch ?? process.arch;
  const translated = options.runningUnderARM64Translation ?? false;

  if (!translated) {
    return null;
  }
  // 仅 macOS / Windows 存在 ARM64 翻译运行；其余平台直接放行，避免误报。
  if (platform !== "darwin" && platform !== "win32") {
    return null;
  }

  return { binaryArch, nativeArch: "arm64" };
}

// fork（F2.5）：删除 resolveArchitectureDownloadUrl——它按应用语言拼官方下载页
// （{origin}/cn、{origin}/en），fork 的手动升级入口统一改为构建期
// ZCODE_DOWNLOAD_PAGE_URL（阶段 2 细则「强制升级 gate（删除）」规则 4），
// 代码里不再出现官方下载页形式，下载页地址只由构建配置提供。

interface ArchitectureMismatchDialogText {
  title: string;
  message: string;
  detail: string;
  downloadButton: string;
  dismissButton: string;
}

export function formatArchitectureMismatchDialogText(
  mismatch: ArchitectureMismatch,
  locale: Locale,
): ArchitectureMismatchDialogText {
  const isZh = locale === "zh-CN";
  if (isZh) {
    return {
      title: "架构不匹配",
      message: "当前安装的不是适配本机的版本",
      detail:
        `你正在运行 ${mismatch.binaryArch} 版本，但本机是 ${mismatch.nativeArch}（Apple 芯片）架构，` +
        `当前通过系统转译运行，会更慢、更耗电。\n\n` +
        `建议前往官网下载并安装 ${mismatch.nativeArch} 原生版本以获得最佳性能。`,
      downloadButton: "前往下载",
      dismissButton: "暂不处理",
    };
  }

  return {
    title: "Architecture Mismatch",
    message: "The installed build does not match your machine",
    detail:
      `You are running the ${mismatch.binaryArch} build, but this machine is ${mismatch.nativeArch}. ` +
      `It is currently running through system translation, which is slower and less power-efficient.\n\n` +
      `Please download and install the native ${mismatch.nativeArch} build for the best performance.`,
    downloadButton: "Download",
    dismissButton: "Not now",
  };
}

export interface ArchitectureGuardLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/**
 * 启动时检测架构是否匹配；若用户装了错误架构的版本，弹框说明情况。
 * 「前往下载」仅在构建期配置了 ZCODE_DOWNLOAD_PAGE_URL 时显示，点击后用系统浏览器
 * 打开该地址（fork 手动升级入口，阶段 2 细则「强制升级 gate（删除）」规则 4）；
 * 未配置时弹框只做说明，不提供下载入口。
 * 非阻塞：检测命中后异步弹框，不影响主界面继续加载。
 */
export async function maybeWarnArchitectureMismatch(options: {
  locale: Locale;
  logger: ArchitectureGuardLogger;
  parentWindow?: BrowserWindow | null;
  icon?: NativeImage;
  /** 仅供测试注入，缺省读当前进程；语义与 detectArchitectureMismatch 的同名参数一致。 */
  platform?: NodeJS.Platform;
  binaryArch?: string;
}): Promise<void> {
  const { app, dialog, shell } = await import("electron");

  const mismatch = detectArchitectureMismatch({
    platform: options.platform,
    binaryArch: options.binaryArch,
    runningUnderARM64Translation: app.runningUnderARM64Translation,
  });
  if (!mismatch) {
    return;
  }

  options.logger.warn(
    `[architecture] 检测到架构不匹配：运行 ${mismatch.binaryArch}，本机为 ${mismatch.nativeArch}（转译运行）`,
  );

  // 构建期常量（经 define 注入，build-time-config 已做 https 校验与 trim）；空串表示未配置。
  const downloadPageUrl = ZCODE_DOWNLOAD_PAGE_URL.trim();
  const text = formatArchitectureMismatchDialogText(mismatch, options.locale);
  const buttons = downloadPageUrl
    ? [text.downloadButton, text.dismissButton]
    : // 未配置下载页：不显示「前往下载」，弹框只做说明。
      [text.dismissButton];
  const dialogOptions = {
    type: "warning" as const,
    buttons,
    defaultId: 0,
    // Esc/关闭落在「暂不处理」：配置了下载页时它是第 2 个按钮，未配置时是唯一按钮。
    cancelId: buttons.length - 1,
    title: text.title,
    message: text.message,
    detail: text.detail,
    ...(options.icon && !options.icon.isEmpty() ? { icon: options.icon } : {}),
  };

  const { response } =
    options.parentWindow && !options.parentWindow.isDestroyed()
      ? await dialog.showMessageBox(options.parentWindow, dialogOptions)
      : await dialog.showMessageBox(dialogOptions);

  // 未配置 downloadPageUrl 时 buttons 只有一个「暂不处理」，response 恒为 0，
  // 条件保证此时不会打开任何地址。
  if (response === 0 && downloadPageUrl) {
    options.logger.info(`[architecture] 用户选择前往下载：${downloadPageUrl}`);
    await shell.openExternal(downloadPageUrl);
  }
}
