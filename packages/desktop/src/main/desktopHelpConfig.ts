import { app } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveLocalHelpAppConfig, type HelpAppConfig } from "@zcode/shared";

/**
 * 内置 config/default.json 的解析路径：正式包中 electron-builder 把它放在
 * resources/config（app.asar 之外），开发态继续读仓库根的 config/default.json。
 */
export function resolveLocalAppConfigPath(options?: {
  appPath?: string;
  isPackaged?: boolean;
  resourcesPath?: string;
}): string {
  const isPackaged = options?.isPackaged ?? app.isPackaged;
  if (isPackaged) {
    // app.getAppPath() 在正式包中指向 resources/app.asar，向上两级后会误读
    // Contents/config，必须从 resourcesPath 解析。
    return join(options?.resourcesPath ?? process.resourcesPath, "config/default.json");
  }
  return join(options?.appPath ?? app.getAppPath(), "../../config/default.json");
}

/**
 * fork（F2.7）：帮助与社群配置只读内置 config/default.json。
 * 原实现经 electron net.fetch 请求远端 /api/v1/client/configs（附带 X-Device-Mid
 * 等设备标识，且官方可改写反馈与社群入口），现在不再构造/发起任何远端请求。
 */
export function createDesktopHelpConfigReader(options?: {
  readLocalConfig?: () => Promise<unknown>;
}): () => Promise<HelpAppConfig> {
  return async () => {
    const raw = options?.readLocalConfig
      ? await options.readLocalConfig()
      : JSON.parse(await readFile(resolveLocalAppConfigPath(), "utf-8"));
    return resolveLocalHelpAppConfig(raw);
  };
}
