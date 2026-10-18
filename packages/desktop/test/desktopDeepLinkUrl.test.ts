import { describe, expect, it } from "vitest";

describe("desktop deep link url helpers", () => {
  // fork（F4.7）：OAuth / 支付回调判定随官方账号链删除，这里只保留工作区深链。

  it("accepts Linux one-slash workspace open urls", async () => {
    const { isWorkspaceOpenUrl } = await import("../src/main/desktopDeepLinkUrl.js");

    expect(isWorkspaceOpenUrl(new URL("zcode:/workspace/open?path=%2Ftmp"))).toBe(true);
    expect(isWorkspaceOpenUrl(new URL("zcode:workspace/open?path=%2Ftmp"))).toBe(true);
    expect(isWorkspaceOpenUrl(new URL("zcode://workspace/other?path=%2Ftmp"))).toBe(false);
  });

  it("recognizes workspace open urls and extracts the encoded folder path", async () => {
    const { extractWorkspaceOpenPath, isWorkspaceOpenUrl } =
      await import("../src/main/desktopDeepLinkUrl.js");

    const workspaceUrl = new URL("zcode://workspace/open?path=%2FUsers%2Fdemo%2FProject%20A%26B");
    expect(isWorkspaceOpenUrl(workspaceUrl)).toBe(true);
    expect(extractWorkspaceOpenPath(workspaceUrl)).toBe("/Users/demo/Project A&B");
    expect(isWorkspaceOpenUrl(new URL("zcode://workspace/other?path=%2Ftmp"))).toBe(false);
    expect(extractWorkspaceOpenPath(new URL("zcode://workspace/open"))).toBeNull();
  });

  // fork（F4.8）：share import code 解析用例随会话分享功能删除。

  it("extracts protocol urls from desktop argv variants", async () => {
    const { extractDeepLinkUrlFromArgs } = await import("../src/main/desktopDeepLinkUrl.js");

    expect(
      extractDeepLinkUrlFromArgs(["/opt/ZCode/zcode", "zcode://workspace/open?path=%2Ftmp"]),
    ).toBe("zcode://workspace/open?path=%2Ftmp");
    expect(
      extractDeepLinkUrlFromArgs(["/opt/ZCode/zcode", "--open-url=zcode://workspace/open?path=%2Ftmp"]),
    ).toBe("zcode://workspace/open?path=%2Ftmp");
    expect(
      extractDeepLinkUrlFromArgs([
        "/opt/ZCode/zcode",
        "zcode%3A%2F%2Fworkspace%2Fopen%3Fpath%3D%252Ftmp",
      ]),
    ).toBe("zcode://workspace/open?path=%2Ftmp");
    expect(
      extractDeepLinkUrlFromArgs([
        "/opt/ZCode/zcode",
        "zcode%253A%252F%252Fworkspace%252Fopen%253Fpath%253D%25252Ftmp",
      ]),
    ).toBe("zcode://workspace/open?path=%2Ftmp");
    expect(
      extractDeepLinkUrlFromArgs([
        "/opt/ZCode/zcode",
        "zcode://workspace/open?path=%2Ftmp&amp;x=1",
      ]),
    ).toBe("zcode://workspace/open?path=%2Ftmp&x=1");
    expect(
      extractDeepLinkUrlFromArgs([
        "/Applications/ZCode.app/Contents/MacOS/ZCode",
        "zcode://workspace/open?path=%2FUsers%2Fdemo%2FProject%2520A",
      ]),
    ).toBe("zcode://workspace/open?path=%2FUsers%2Fdemo%2FProject%2520A");
  });

  it("returns null when argv does not contain a deep link", async () => {
    const { extractDeepLinkUrlFromArgs } = await import("../src/main/desktopDeepLinkUrl.js");

    expect(extractDeepLinkUrlFromArgs(["/opt/ZCode/zcode", "--no-sandbox"])).toBeNull();
  });

  it("extracts Windows open workspace argv without URL decoding", async () => {
    const { extractOpenWorkspacePathFromArgs } = await import("../src/main/desktopDeepLinkUrl.js");

    expect(
      extractOpenWorkspacePathFromArgs([
        "C:\\Program Files\\ZCode\\ZCode.exe",
        "--open-workspace",
        "C:\\Users\\demo\\Project A&B#1",
      ]),
    ).toBe("C:\\Users\\demo\\Project A&B#1");
    expect(
      extractOpenWorkspacePathFromArgs([
        "C:\\Program Files\\ZCode\\ZCode.exe",
        "--open-workspace=C:\\Users\\demo\\Project%20A",
      ]),
    ).toBe("C:\\Users\\demo\\Project%20A");
    expect(extractOpenWorkspacePathFromArgs(["ZCode.exe", "--open-workspace", 'C:"'])).toBe("C:\\");
    expect(extractOpenWorkspacePathFromArgs(["ZCode.exe", "--open-workspace", 'C:\\repo"'])).toBe(
      "C:\\repo\\",
    );
    expect(extractOpenWorkspacePathFromArgs(["ZCode.exe", "--open-workspace"])).toBeNull();
  });

  it("passes parsed deep links through single instance additionalData", async () => {
    const {
      createDeepLinkSingleInstanceData,
      extractDeepLinkUrlFromSingleInstanceData,
      extractOpenWorkspacePathFromSingleInstanceData,
    } = await import("../src/main/desktopDeepLinkUrl.js");

    const additionalData = createDeepLinkSingleInstanceData([
      "/opt/ZCode/zcode",
      "zcode%253A%252F%252Fworkspace%252Fopen%253Fpath%253D%25252Ftmp",
      "--open-workspace=C:\\Users\\demo\\Project A",
    ]);

    expect(extractDeepLinkUrlFromSingleInstanceData(additionalData)).toBe(
      "zcode://workspace/open?path=%2Ftmp",
    );
    expect(extractOpenWorkspacePathFromSingleInstanceData(additionalData)).toBe(
      "C:\\Users\\demo\\Project A",
    );
    expect(extractDeepLinkUrlFromSingleInstanceData({ deepLinkUrl: "https://example.com" })).toBe(
      null,
    );
  });

  it("builds Windows Explorer registry operations for folder context menu", async () => {
    const { buildWindowsOpenFolderCommand, buildWindowsOpenFolderRegistryOperations } =
      await import("../src/main/desktopWindowsOpenFolderContextMenu.js");

    expect(buildWindowsOpenFolderCommand("C:\\Program Files\\ZCode\\ZCode.exe")).toBe(
      '"C:\\Program Files\\ZCode\\ZCode.exe" --open-workspace "%1"',
    );
    expect(
      buildWindowsOpenFolderCommand("C:\\Electron\\electron.exe", ["C:\\repo\\desktop\\main.js"]),
    ).toBe('"C:\\Electron\\electron.exe" "C:\\repo\\desktop\\main.js" --open-workspace "%1"');

    const operations = buildWindowsOpenFolderRegistryOperations({
      executablePath: "C:\\Program Files\\ZCode\\ZCode.exe",
      locale: "en-US",
    });

    expect(operations).toContainEqual({
      args: [
        "add",
        "HKCU\\Software\\Classes\\Directory\\shell\\ZCode.OpenInZCode\\command",
        "/ve",
        "/d",
        '"C:\\Program Files\\ZCode\\ZCode.exe" --open-workspace "%1"',
        "/f",
      ],
    });
    expect(operations).toContainEqual({
      args: [
        "add",
        "HKCU\\Software\\Classes\\Drive\\shell\\ZCode.OpenInZCode\\command",
        "/ve",
        "/d",
        '"C:\\Program Files\\ZCode\\ZCode.exe" --open-workspace "%1"',
        "/f",
      ],
    });
  });

  it("builds localized Windows Explorer registry menu labels", async () => {
    const { buildWindowsOpenFolderRegistryOperations, getWindowsOpenFolderMenuName } =
      await import("../src/main/desktopWindowsOpenFolderContextMenu.js");

    expect(getWindowsOpenFolderMenuName("zh-CN")).toBe("在ZCode中打开");
    expect(getWindowsOpenFolderMenuName("en-US")).toBe("Open in ZCode");

    const operations = buildWindowsOpenFolderRegistryOperations({
      executablePath: "C:\\Program Files\\ZCode\\ZCode.exe",
      locale: "zh-CN",
    });

    expect(operations).toContainEqual({
      args: [
        "add",
        "HKCU\\Software\\Classes\\Directory\\shell\\ZCode.OpenInZCode",
        "/ve",
        "/d",
        "在ZCode中打开",
        "/f",
      ],
    });
    expect(operations).toContainEqual({
      args: [
        "add",
        "HKCU\\Software\\Classes\\Directory\\shell\\ZCode.OpenInZCode",
        "/v",
        "MUIVerb",
        "/t",
        "REG_SZ",
        "/d",
        "在ZCode中打开",
        "/f",
      ],
    });
  });
});
