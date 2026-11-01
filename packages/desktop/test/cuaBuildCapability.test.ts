// resolveCuaBuildCapability 的纯函数测试：占位/narrow 判定只依赖打包资源事实，
// dev 与资源缺失一律 fail-closed 为占位（specs/computer-use-settings-unification.md）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCuaBuildCapability } from "../src/main/cuaBuildCapability.js";

let tempRoot: string | null = null;

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

function makeResourcesRoot(): string {
  tempRoot = mkdtempSync(join(tmpdir(), "cua-build-capability-"));
  return tempRoot;
}

describe("resolveCuaBuildCapability", () => {
  it("dev 模式（未打包）恒为占位", () => {
    const resourcesRoot = makeResourcesRoot();
    expect(
      resolveCuaBuildCapability({ isPackaged: false, resourcesPath: resourcesRoot }),
    ).toEqual({ kind: "placeholder" });
  });

  it("打包产物缺失 cua-narrow/manifest.json 时为占位", () => {
    const resourcesRoot = makeResourcesRoot();
    expect(
      resolveCuaBuildCapability({ isPackaged: true, resourcesPath: resourcesRoot }),
    ).toEqual({ kind: "placeholder" });
  });

  it("打包产物含 cua-narrow/manifest.json 时为 narrow，且只声明单窗口截图能力", () => {
    const resourcesRoot = makeResourcesRoot();
    mkdirSync(join(resourcesRoot, "cua-narrow"), { recursive: true });
    writeFileSync(join(resourcesRoot, "cua-narrow", "manifest.json"), "{}");
    const capability = resolveCuaBuildCapability({
      isPackaged: true,
      resourcesPath: resourcesRoot,
    });
    expect(capability).toEqual({
      kind: "narrow",
      capabilities: ["screenshot.single-window"],
    });
  });

  it("同名目录存在但 manifest.json 缺失时不误判为 narrow", () => {
    const resourcesRoot = makeResourcesRoot();
    mkdirSync(join(resourcesRoot, "cua-narrow"), { recursive: true });
    expect(
      resolveCuaBuildCapability({ isPackaged: true, resourcesPath: resourcesRoot }),
    ).toEqual({ kind: "placeholder" });
  });
});
