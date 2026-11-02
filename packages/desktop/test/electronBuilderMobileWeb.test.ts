import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  MOBILE_WEB_RESOURCE_DIR_NAME,
  resolveMobileWebSourceDir,
} from "../scripts/mobile-web-assets.mjs";

const desktopPackageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

// electron-builder 配置在 darwin/arm64 会默认选中已 pin 的 CUA narrow 资源；
// 这些资源不在普通单测环境构建。固定为非默认目标，只验证移动 UI 资源映射。
vi.stubEnv("ZCODE_TARGET_OS", "linux");
const { default: desktopBuilderConfig, createMobileWebExtraResource } =
  await import("../electron-builder.config.js");
afterAll(() => {
  vi.unstubAllEnvs();
});

describe("electron-builder 移动 Remote UI 资源映射", () => {
  it("把 packages/web/dist-mobile-remote 映射到 resources/mobile-web", () => {
    const entry = (desktopBuilderConfig.extraResources ?? []).find(
      (resource) => typeof resource === "object" && resource.to === MOBILE_WEB_RESOURCE_DIR_NAME,
    );

    expect(entry).toMatchObject({
      from: resolveMobileWebSourceDir({ desktopPackageRoot }),
      to: "mobile-web",
    });
  });

  it("extraResources 映射排除 sourcemap", () => {
    const resource = createMobileWebExtraResource({ sourceDir: "/repo/web/dist-mobile-remote" });

    expect(resource).toEqual({
      from: "/repo/web/dist-mobile-remote",
      to: "mobile-web",
      filter: ["**/*", "!**/*.map"],
    });
  });

  it("移动 Remote 制品不会进入 app.asar 主进程文件集合", () => {
    const files = (desktopBuilderConfig.files ?? []).map(String);
    const asarUnpack = (desktopBuilderConfig.asarUnpack ?? []).map(String);

    expect(files.some((pattern) => /mobile-web|dist-mobile-remote/.test(pattern))).toBe(false);
    expect(asarUnpack.some((pattern) => /mobile-web|dist-mobile-remote/.test(pattern))).toBe(false);
  });

  it("打包前的资源映射与打包后的目录使用同一资源名", () => {
    const resource = createMobileWebExtraResource({
      sourceDir: resolve(desktopPackageRoot, "../web/dist-mobile-remote"),
    });

    expect(resource.to).toBe("mobile-web");
    expect(resolveMobileWebSourceDir({ desktopPackageRoot })).toBe(resource.from);
  });
});
