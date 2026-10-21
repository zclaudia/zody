import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Locale } from "@zcode/shared";
import type { DesktopShellIntegrationIdentity } from "./desktopShellIntegrationIdentity.js";

// 修复原因：上游键名 `ZCode.OpenInZCode` 与文案写死，Zody 会覆盖/冒用上游菜单项，
// Preview 也会覆盖正式版。键名与文字按产品身份生成：正式版 `Zody.OpenInZody`，
// Preview/Dev 为 `ZodyPreview.OpenInZodyPreview`，两者互不覆盖。
export function getWindowsOpenFolderMenuKeyName(identity: DesktopShellIntegrationIdentity): string {
  const compactName = identity.productName.replace(/\s+/g, "");
  return `${compactName}.OpenIn${compactName}`;
}

type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

export interface WindowsOpenFolderRegistryOperation {
  args: string[];
}

export function getWindowsOpenFolderMenuName(
  locale: Locale,
  identity: DesktopShellIntegrationIdentity,
): string {
  return locale === "zh-CN"
    ? `在 ${identity.productName} 中打开`
    : `Open in ${identity.productName}`;
}

function quoteWindowsCommandArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function buildWindowsOpenFolderCommand(
  executablePath: string,
  appArgs: readonly string[] = [],
): string {
  return [
    quoteWindowsCommandArg(executablePath),
    ...appArgs.map(quoteWindowsCommandArg),
    "--open-workspace",
    '"%1"',
  ].join(" ");
}

export function buildWindowsOpenFolderRegistryOperations(options: {
  executablePath: string;
  appArgs?: readonly string[];
  locale: Locale;
  identity: DesktopShellIntegrationIdentity;
}): WindowsOpenFolderRegistryOperation[] {
  const command = buildWindowsOpenFolderCommand(options.executablePath, options.appArgs ?? []);
  const menuName = getWindowsOpenFolderMenuName(options.locale, options.identity);
  const menuKeyName = getWindowsOpenFolderMenuKeyName(options.identity);
  const menuKeys = [
    `HKCU\\Software\\Classes\\Directory\\shell\\${menuKeyName}`,
    `HKCU\\Software\\Classes\\Drive\\shell\\${menuKeyName}`,
  ];

  return menuKeys.flatMap((menuKey) => [
    { args: ["add", menuKey, "/ve", "/d", menuName, "/f"] },
    { args: ["add", menuKey, "/v", "MUIVerb", "/t", "REG_SZ", "/d", menuName, "/f"] },
    { args: ["add", menuKey, "/v", "Icon", "/t", "REG_SZ", "/d", options.executablePath, "/f"] },
    { args: ["add", `${menuKey}\\command`, "/ve", "/d", command, "/f"] },
  ]);
}

function runRegAdd(args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("reg.exe", [...args], {
      stdio: "ignore",
      windowsHide: true,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      reject(new Error(`reg.exe exited with code ${code ?? "unknown"}`));
    });
  });
}

export async function installWindowsOpenFolderContextMenu(options: {
  platform: NodeJS.Platform;
  executablePath: string;
  argv: readonly string[];
  isDefaultApp: boolean;
  locale: Locale;
  identity: DesktopShellIntegrationIdentity;
  logger: Logger;
}): Promise<void> {
  if (options.platform !== "win32") {
    return;
  }

  const appArgs =
    // 开发态 Windows 的 process.execPath 是 Electron 可执行文件。
    // 注册表命令必须同时带上应用入口，否则 Explorer 右键菜单只能启动空 Electron。
    options.isDefaultApp && options.argv[1] ? [resolve(options.argv[1])] : [];
  const operations = buildWindowsOpenFolderRegistryOperations({
    executablePath: options.executablePath,
    appArgs,
    locale: options.locale,
    identity: options.identity,
  });

  try {
    await Promise.all(operations.map((operation) => runRegAdd(operation.args)));

    options.logger.info("[open-folder] Windows Explorer 右键菜单已安装或更新", {
      executablePath: options.executablePath,
      hasDefaultAppEntry: appArgs.length > 0,
      locale: options.locale,
    });
  } catch (error) {
    options.logger.warn("[open-folder] Windows Explorer 右键菜单安装失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
