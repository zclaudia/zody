import path from "node:path";

export const MOBILE_WEB_RESOURCE_DIR_NAME = "mobile-web";

export function resolveMobileWebSourceDir({ desktopPackageRoot, pathApi = path } = {}) {
  if (typeof desktopPackageRoot !== "string" || desktopPackageRoot.trim() === "") {
    throw new Error("desktopPackageRoot is required to resolve the mobile web source directory");
  }
  return pathApi.resolve(desktopPackageRoot, "..", "web", "dist-mobile-remote");
}

/**
 * 开发态读取构建源目录，打包态只读 process.resourcesPath/mobile-web。
 * 路径解析保持纯函数，调用方注入 Electron 的 app.isPackaged / process.resourcesPath。
 */
export function resolveMobileWebRootDir({
  isPackaged,
  resourcesPath,
  desktopPackageRoot,
  pathApi = path,
} = {}) {
  if (!isPackaged) {
    return resolveMobileWebSourceDir({ desktopPackageRoot, pathApi });
  }
  if (typeof resourcesPath !== "string" || resourcesPath.trim() === "") {
    throw new Error(
      "resourcesPath is required when resolving the packaged mobile web root directory",
    );
  }
  return pathApi.resolve(resourcesPath, MOBILE_WEB_RESOURCE_DIR_NAME);
}

// M1-T1 的 verifyMobileWebRelease 是发布完整性的唯一规则：manifest schema、HTML meta、
// 资源引用、sourcemap 排除与摘要复核都由它负责。桌面层只把 rootDir 映射为 distDir。
async function defaultVerifyMobileWebRelease({ rootDir }) {
  const { verifyMobileWebRelease } = await import("../../../scripts/build-mobile-web-release.mjs");
  return verifyMobileWebRelease({ distDir: rootDir });
}

/**
 * 桌面构建/打包调用的统一入口。focused 测试可注入 verifyRelease，
 * 避免在 T1 脚本尚未进入当前分支时复制第二套校验逻辑。
 */
export async function verifyMobileWebReleaseDirectory({
  rootDir,
  verifyRelease = defaultVerifyMobileWebRelease,
} = {}) {
  if (typeof rootDir !== "string" || rootDir.trim() === "") {
    throw new Error("rootDir is required to verify the mobile web release directory");
  }
  return verifyRelease({ distDir: rootDir });
}
