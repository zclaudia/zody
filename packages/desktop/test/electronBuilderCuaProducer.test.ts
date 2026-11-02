import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];

async function createContext() {
  const appOutDir = await mkdtemp(join(tmpdir(), "zcode-cua-koffi-"));
  roots.push(appOutDir);
  await mkdir(join(appOutDir, "resources"), { recursive: true });
  return {
    appOutDir,
    electronPlatformName: "linux",
    packager: { appInfo: { productFilename: "Zody" } },
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("electron-builder CUA koffi producer gate", () => {
  it("开源占位包不要求已删除 producer 插件的 koffi 资源", async () => {
    vi.stubEnv("ZCODE_TARGET_OS", "linux");
    vi.stubEnv("ZCODE_TARGET_ARCH", "x64");
    const { assertPackagedCuaKoffi } = await import("../electron-builder.config.js");
    const { verifyStagedKoffi } = await import("../scripts/koffi-package-assets.mjs");
    let verificationCalls = 0;
    const verifyKoffi = (...args: Parameters<typeof verifyStagedKoffi>) => {
      verificationCalls += 1;
      return verifyStagedKoffi(...args);
    };
    const context = await createContext();

    expect(() =>
      assertPackagedCuaKoffi(context, { isRealProducer: false, verifyKoffi }),
    ).not.toThrow();
    expect(verificationCalls).toBe(0);
  });

  it("真实 producer 缺少 koffi 资源时仍然严格失败", async () => {
    vi.stubEnv("ZCODE_TARGET_OS", "linux");
    vi.stubEnv("ZCODE_TARGET_ARCH", "x64");
    const { assertPackagedCuaKoffi } = await import("../electron-builder.config.js");
    const { verifyStagedKoffi } = await import("../scripts/koffi-package-assets.mjs");
    let verificationCalls = 0;
    const verifyKoffi = (...args: Parameters<typeof verifyStagedKoffi>) => {
      verificationCalls += 1;
      return verifyStagedKoffi(...args);
    };
    const context = await createContext();

    expect(() => assertPackagedCuaKoffi(context, { isRealProducer: true, verifyKoffi })).toThrow(
      /CUA plugin koffi runtime is incomplete in the packaged app/,
    );
    expect(verificationCalls).toBe(1);
  });
});
