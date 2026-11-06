import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDesktopRemoteProdEnv,
  resolvePnpmCommand,
  resolveProductionRemoteAssetCacheDir,
} from "../../../scripts/dev-desktop-remote-prod.mjs";

const rootPackageJsonPath = resolve(import.meta.dirname, "../../../package.json");
const rootPackageJson = JSON.parse(readFileSync(rootPackageJsonPath, "utf8")) as {
  scripts: Record<string, string | undefined>;
};

describe("dev desktop remote production-like script", () => {
  it("根 package.json 应提供生产态 remote 行为的 desktop dev 启动脚本", () => {
    expect(rootPackageJson.scripts["dev:desktop:remote-prod"]).toBe(
      "node scripts/dev-desktop-remote-prod.mjs",
    );
  });

  it("macOS 默认应复用正式版 Zody remote cache", () => {
    expect(resolveProductionRemoteAssetCacheDir({}, "darwin", "/Users/alice")).toBe(
      "/Users/alice/.zody/desktop/Zody/remote-assets-cache",
    );
  });

  it("Linux 默认应复用正式版 Zody remote cache，且不再跟随 XDG_CONFIG_HOME", () => {
    expect(resolveProductionRemoteAssetCacheDir({}, "linux", "/home/alice")).toBe(
      "/home/alice/.zody/desktop/Zody/remote-assets-cache",
    );
    expect(
      resolveProductionRemoteAssetCacheDir(
        { XDG_CONFIG_HOME: "/home/alice/.config-custom" },
        "linux",
        "/home/alice",
      ),
    ).toBe("/home/alice/.zody/desktop/Zody/remote-assets-cache");
  });

  it("Windows 默认应复用正式版 Zody remote cache", () => {
    expect(
      resolveProductionRemoteAssetCacheDir(
        { APPDATA: "C:\\Users\\Alice\\AppData\\Roaming" },
        "win32",
        "C:\\Users\\Alice",
      ),
    ).toBe("C:\\Users\\Alice\\.zody\\desktop\\Zody\\remote-assets-cache");
  });

  it("启动 env 应强制走 CDN，并允许显式 cache 覆盖", () => {
    const env = buildDesktopRemoteProdEnv(
      {
        ZODY_ENV: "test",
        ZCODE_DEV_REMOTE_ASSET_USE_CDN: "0",
        ZODY_REMOTE_ASSET_CACHE_DIR: "/tmp/custom-cache",
      },
      "darwin",
      "/Users/alice",
    );

    expect(env.ZODY_ENV).toBe("production");
    expect(env.ZCODE_DEV_REMOTE_ASSET_USE_CDN).toBe("0");
    expect(env.ZODY_REMOTE_ASSET_CACHE_DIR).toBe("/tmp/custom-cache");
  });

  it("Windows 下应使用 pnpm.cmd 启动", () => {
    expect(resolvePnpmCommand("win32")).toBe("pnpm.cmd");
    expect(resolvePnpmCommand("darwin")).toBe("pnpm");
  });
});
