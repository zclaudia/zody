import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

function pathApiForPlatform(platform) {
  return platform === "win32" ? win32 : posix;
}

/**
 * 正式版 Zody 的 remote assets cache 目录。
 *
 * 修改原因：正式版 Electron userData 已不在系统 `Application Support/ZCode` 等目录，而是
 * `{dataBaseDir}/.zody/desktop/<应用名>`（见 packages/desktop/src/main/desktopRuntimeEnv.ts 的
 * runtimeUserDataPath），cache 位于其下的 `remote-assets-cache`，各平台一致。这里按默认
 * dataBaseDir（用户 home）与正式应用名 `Zody` 推导；正式版配置了自定义 dataBaseDir 时，
 * 用 ZODY_REMOTE_ASSET_CACHE_DIR 显式指定。
 */
export function resolveProductionRemoteAssetCacheDir(
  _env = process.env,
  platform = process.platform,
  homeDir = homedir(),
) {
  const pathApi = pathApiForPlatform(platform);
  return pathApi.join(homeDir, ".zody", "desktop", "Zody", "remote-assets-cache");
}

export function buildDesktopRemoteProdEnv(
  baseEnv = process.env,
  platform = process.platform,
  homeDir = homedir(),
) {
  const cacheDir =
    baseEnv.ZODY_REMOTE_ASSET_CACHE_DIR?.trim() ||
    resolveProductionRemoteAssetCacheDir(baseEnv, platform, homeDir);

  return {
    ...baseEnv,
    // Desktop 已固定 local-only；该命令只复用生产环境与可写 cache，不再启用 CDN 下载。
    ZODY_ENV: "production",
    ZODY_REMOTE_ASSET_CACHE_DIR: cacheDir,
  };
}

export function resolvePnpmCommand(platform = process.platform) {
  return platform === "win32" ? "pnpm.cmd" : "pnpm";
}

export function runDesktopRemoteProdDev() {
  const repoRoot = resolve(import.meta.dirname, "..");
  const child = spawn(resolvePnpmCommand(), ["--filter", "@zody/desktop", "dev"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: buildDesktopRemoteProdEnv(),
    windowsHide: true,
  });

  child.on("close", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    console.error("[dev:desktop:remote-prod] failed to start pnpm:", error);
    process.exit(1);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDesktopRemoteProdDev();
}
