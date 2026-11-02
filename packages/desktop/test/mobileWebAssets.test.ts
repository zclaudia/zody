import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  resolveMobileWebRootDir,
  resolveMobileWebSourceDir,
  verifyMobileWebReleaseDirectory,
} from "../scripts/mobile-web-assets.mjs";

describe("移动 Remote UI 根路径解析", () => {
  it("开发态指向 packages/web/dist-mobile-remote", () => {
    expect(
      resolveMobileWebSourceDir({
        desktopPackageRoot: path.resolve("/repo/packages/desktop"),
      }),
    ).toBe(path.resolve("/repo/packages/web/dist-mobile-remote"));
  });

  it("打包态只读 process.resourcesPath/mobile-web", () => {
    expect(
      resolveMobileWebRootDir({
        isPackaged: true,
        resourcesPath: path.resolve("/repo/dist/mac/Zody.app/Contents/Resources"),
        desktopPackageRoot: path.resolve("/repo/packages/desktop"),
      }),
    ).toBe(path.resolve("/repo/dist/mac/Zody.app/Contents/Resources/mobile-web"));
  });

  it("开发态忽略 resourcesPath", () => {
    expect(
      resolveMobileWebRootDir({
        isPackaged: false,
        resourcesPath: "/ignored",
        desktopPackageRoot: path.resolve("/repo/packages/desktop"),
      }),
    ).toBe(path.resolve("/repo/packages/web/dist-mobile-remote"));
  });

  it("打包态缺少 resourcesPath 时 fail closed", () => {
    expect(() =>
      resolveMobileWebRootDir({
        isPackaged: true,
        desktopPackageRoot: path.resolve("/repo/packages/desktop"),
      }),
    ).toThrow(/resourcesPath/);
  });

  it("Windows 路径使用平台分隔符", () => {
    expect(
      resolveMobileWebSourceDir({
        desktopPackageRoot: "C:\\repo\\packages\\desktop",
        pathApi: path.win32,
      }),
    ).toBe("C:\\repo\\packages\\web\\dist-mobile-remote");
    expect(
      resolveMobileWebRootDir({
        isPackaged: true,
        resourcesPath: "C:\\Program Files\\Zody\\resources",
        pathApi: path.win32,
      }),
    ).toBe("C:\\Program Files\\Zody\\resources\\mobile-web");
  });
});

describe("移动 Remote UI 发布校验委派", () => {
  it("把 rootDir 作为 distDir 交给 M1-T1 的唯一 verifier", async () => {
    const verifyRelease = vi.fn(async ({ distDir }) => ({
      releaseId: "0123456789abcdef01234567",
      distDir,
    }));

    const result = await verifyMobileWebReleaseDirectory({
      rootDir: "/repo/packages/web/dist-mobile-remote",
      verifyRelease,
    });

    expect(verifyRelease).toHaveBeenCalledTimes(1);
    expect(verifyRelease).toHaveBeenCalledWith({
      distDir: "/repo/packages/web/dist-mobile-remote",
    });
    expect(result).toMatchObject({
      releaseId: "0123456789abcdef01234567",
      distDir: "/repo/packages/web/dist-mobile-remote",
    });
  });

  it("verifier 失败时不吞错，保持打包 fail closed", async () => {
    const verifyRelease = vi.fn(async () => {
      throw new Error("Mobile UI artifact is missing release.json");
    });

    await expect(
      verifyMobileWebReleaseDirectory({
        rootDir: "/repo/packages/web/dist-mobile-remote",
        verifyRelease,
      }),
    ).rejects.toThrow(/release\.json/);
  });

  it("缺少 rootDir 时在调用 verifier 前失败", async () => {
    const verifyRelease = vi.fn();

    await expect(verifyMobileWebReleaseDirectory({ verifyRelease })).rejects.toThrow(/rootDir/);
    expect(verifyRelease).not.toHaveBeenCalled();
  });
});
