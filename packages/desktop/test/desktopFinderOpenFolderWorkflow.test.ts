import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFinderOpenFolderWorkflow } from "../src/main/desktopFinderOpenFolderWorkflow.js";
import { resolveDesktopShellIntegrationIdentity } from "../src/main/desktopShellIntegrationIdentity.js";

const productionIdentity = resolveDesktopShellIntegrationIdentity("Zody");
const previewIdentity = resolveDesktopShellIntegrationIdentity("Zody Preview");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("desktopFinderOpenFolderWorkflow", () => {
  it("按中文 locale 写入 Finder 服务展示名", () => {
    const homeDir = createTempHome();
    const refreshServicesIndex = vi.fn();

    installFinderOpenFolderWorkflow({
      platform: "darwin",
      locale: "zh-CN",
      identity: productionIdentity,
      homeDir,
      logger: { info: vi.fn(), warn: vi.fn() },
      refreshServicesIndex,
    });

    const infoPlist = readInfoPlist(homeDir, "Open in Zody.workflow");
    expect(infoPlist).toContain("<string>在 Zody 中打开</string>");
    expect(infoPlist).not.toContain("<string>Open in Zody</string>");
    expect(refreshServicesIndex).toHaveBeenCalledTimes(1);
  });

  it("按英文 locale 写入 Finder 服务展示名并复用稳定 workflow 文件名", () => {
    const homeDir = createTempHome();
    const refreshServicesIndex = vi.fn();

    installFinderOpenFolderWorkflow({
      platform: "darwin",
      locale: "en-US",
      identity: productionIdentity,
      homeDir,
      logger: { info: vi.fn(), warn: vi.fn() },
      refreshServicesIndex,
    });

    const infoPlist = readInfoPlist(homeDir, "Open in Zody.workflow");
    expect(infoPlist).toContain("<string>Open in Zody</string>");
    expect(infoPlist).not.toContain("<string>在 Zody 中打开</string>");
    expect(infoPlist).toContain("<string>io.github.zclaudia.zody.finder-open-workflow</string>");
    expect(infoPlist).toContain("<string>6</string>");
    expect(readWorkflow(homeDir, "Open in Zody.workflow")).toContain(
      "/usr/bin/open &quot;zody://workspace/open?path=${encoded}&quot;",
    );
    expect(existsSync(join(homeDir, "Library", "Services", "Open in ZCode.workflow"))).toBe(false);
    expect(refreshServicesIndex).toHaveBeenCalledTimes(1);
  });

  it("Preview 身份写入独立 workflow、Bundle id 与 zody-preview 协议，不覆盖正式版", () => {
    const homeDir = createTempHome();

    for (const identity of [productionIdentity, previewIdentity]) {
      installFinderOpenFolderWorkflow({
        platform: "darwin",
        locale: "en-US",
        identity,
        homeDir,
        logger: { info: vi.fn(), warn: vi.fn() },
        refreshServicesIndex: vi.fn(),
      });
    }

    const previewPlist = readInfoPlist(homeDir, "Open in Zody Preview.workflow");
    expect(previewPlist).toContain("<string>Open in Zody Preview</string>");
    expect(previewPlist).toContain(
      "<string>io.github.zclaudia.zody.preview.finder-open-workflow</string>",
    );
    expect(readWorkflow(homeDir, "Open in Zody Preview.workflow")).toContain(
      "zody-preview://workspace/open?path=",
    );
    expect(readWorkflow(homeDir, "Open in Zody.workflow")).toContain("zody://workspace/open?path=");
    expect(readInfoPlist(homeDir, "Open in Zody.workflow")).toContain(
      "<string>Open in Zody</string>",
    );
  });

  it("Dev 与 e2e 隔离应用名落到 Preview 身份", () => {
    expect(resolveDesktopShellIntegrationIdentity("Zody Dev")).toEqual(previewIdentity);
    expect(previewIdentity.protocolScheme).toBe("zody-preview");
    expect(productionIdentity.protocolScheme).toBe("zody");
  });

  it("非 macOS 不安装 Finder 服务", () => {
    const homeDir = createTempHome();
    const refreshServicesIndex = vi.fn();

    installFinderOpenFolderWorkflow({
      platform: "linux",
      locale: "zh-CN",
      identity: productionIdentity,
      homeDir,
      logger: { info: vi.fn(), warn: vi.fn() },
      refreshServicesIndex,
    });

    expect(refreshServicesIndex).not.toHaveBeenCalled();
  });
});

function createTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "zody-finder-workflow-"));
  tempDirs.push(dir);
  return dir;
}

function readInfoPlist(homeDir: string, workflowName: string): string {
  return readFileSync(
    join(homeDir, "Library", "Services", workflowName, "Contents", "Info.plist"),
    "utf8",
  );
}

function readWorkflow(homeDir: string, workflowName: string): string {
  return readFileSync(
    join(homeDir, "Library", "Services", workflowName, "Contents", "document.wflow"),
    "utf8",
  );
}
