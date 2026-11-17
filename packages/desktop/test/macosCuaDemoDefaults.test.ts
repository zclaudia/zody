import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CUA_DEMO_DEFAULT_PUBLIC_FACTS,
  CUA_NARROW_DEFAULT_ASSEMBLY_ENABLED,
  CUA_NARROW_FROZEN_RESTORE_HINT,
  NARROW_AGENT_ENV,
  createMacosCuaDemoBuildEnv,
  resolveMacosCuaDemoBuildSelection,
} from "../scripts/macos-cua-demo-defaults.mjs";
import { NARROW_MANIFEST_ENV } from "../scripts/macos-cua-narrow-resources.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const FROZEN_MANIFEST_PATH = resolve(REPO_ROOT, CUA_DEMO_DEFAULT_PUBLIC_FACTS.manifestRelativePath);

const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function validateWithoutKeychain({ manifestPath }: { manifestPath: string }) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return Promise.resolve({
    manifestPath,
    manifestSha256: sha256(manifestPath),
    stageAppPath: resolve(dirname(manifestPath), manifest.stage.appPath),
    identity: { signedBinarySha256: manifest.identity.signedBinarySha256 },
  });
}

// 在临时 repoRoot 下生成一份形状合法的合成 manifest（与冻结产物同 schema），
// 配合注入的 defaultFacts pin，让默认选择逻辑在无本机归档的机器上也可确定性测试。
function createFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "zody-cua-demo-defaults-fixture-"));
  createdRoots.push(root);
  const manifestRelativePath = "output/cua-narrow-frozen/controller-prepared/manifest.json";
  const manifestPath = join(root, manifestRelativePath);
  mkdirSync(dirname(manifestPath), { recursive: true });
  const manifest = {
    kind: "zody-cua-narrow-resource-manifest",
    status: "pass",
    schemaVersion: 1,
    target: { os: "darwin", arch: "arm64", minimumMacOSVersion: "14.2" },
    slot: { resourcesRelativePath: "cua-narrow", appName: "Zody CUA Desktop Session.app" },
    stage: { appPath: "stage/Zody CUA Desktop Session.app" },
    identity: { signedBinarySha256: "b".repeat(64) },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return {
    root,
    manifestPath,
    manifestRelativePath,
    manifestSha256: sha256(manifestPath),
  };
}

describe("macOS CUA distributable build defaults", () => {
  it("pins the accepted R2 AX manifest in both default selection and frozen archive metadata", async () => {
    const pin = JSON.parse(
      await readFile(resolve(REPO_ROOT, "packages/desktop/build/cua-narrow-frozen.json"), "utf8"),
    );
    const accepted = "9bcea0ea2e21d81a7f4f930a24672839e14ad17b43f29cfaf33b5bf47371cfcd";
    expect(CUA_DEMO_DEFAULT_PUBLIC_FACTS.manifestSha256).toBe(accepted);
    expect(pin.manifestSha256).toBe(accepted);
    expect(pin.manifestRelativePath).toBe(CUA_DEMO_DEFAULT_PUBLIC_FACTS.manifestRelativePath);
  });

  it("selects the pinned v2 profile and manifest on darwin/arm64 without opt-in env (fixture)", async () => {
    const fixture = createFixtureRepo();
    let validationCalls = 0;
    const selection = await resolveMacosCuaDemoBuildSelection({
      env: {},
      targetOs: "darwin",
      targetArch: "arm64",
      repoRoot: fixture.root,
      validateManifest: async (args: { manifestPath: string }) => {
        validationCalls += 1;
        return validateWithoutKeychain(args);
      },
      defaultFacts: {
        manifestRelativePath: fixture.manifestRelativePath,
        manifestSha256: fixture.manifestSha256,
      },
      defaultAssemblyEnabled: true,
    });

    expect(selection).not.toBeNull();
    expect(validationCalls).toBe(1);
    expect(selection.source).toBe("default");
    expect(selection.manifestPath).toBe(fixture.manifestPath);
    expect(selection.manifestSha256).toBe(fixture.manifestSha256);
    expect(selection.profile).toEqual({
      kind: "zody-cua-narrow-agent-profile",
      schemaVersion: 2,
      capability: "screenshot.single-window",
      minimumTarget: { os: "darwin", arch: "arm64", minimumMacOSVersion: "14.2" },
      resourceManifest: {
        sha256: fixture.manifestSha256,
        launcherSha256: "b".repeat(64),
      },
    });
    // v2 profile 不携带任何构建机事实：绝对路径/provider/network 键不得出现。
    expect(selection.profileJson).not.toMatch(/workspaceAllowlist|provider|network|httpProxy/);
    expect(JSON.parse(selection.profileJson)).toEqual(selection.profile);
    expect(createMacosCuaDemoBuildEnv(selection)).toEqual({
      [NARROW_MANIFEST_ENV]: fixture.manifestPath,
      [NARROW_AGENT_ENV]: selection.profileJson,
    });
  });

  it("default assembly stays enabled after the rebuild round (product constant)", async () => {
    // 2026-11-09 重建轮验收后恢复默认装配：开关为 true 且默认选择真实冻结材料
    // （非 null）。协议漂移回撤期间该断言曾为 false，见 spec 对应小节。
    expect(CUA_NARROW_DEFAULT_ASSEMBLY_ENABLED).toBe(true);
    const selection = await resolveMacosCuaDemoBuildSelection({
      env: {},
      targetOs: "darwin",
      targetArch: "arm64",
      repoRoot: REPO_ROOT,
      validateManifest: validateWithoutKeychain,
    });
    expect(selection?.source).toBe("default");
    expect(selection?.manifestSha256).toBe(CUA_DEMO_DEFAULT_PUBLIC_FACTS.manifestSha256);
  });

  it.skipIf(!existsSync(FROZEN_MANIFEST_PATH))(
    "selects the real frozen materials when the switch is explicitly enabled",
    async () => {
      const selection = await resolveMacosCuaDemoBuildSelection({
        env: {},
        targetOs: "darwin",
        targetArch: "arm64",
        repoRoot: REPO_ROOT,
        validateManifest: validateWithoutKeychain,
        defaultAssemblyEnabled: true,
      });
      expect(selection.source).toBe("default");
      expect(selection.manifestPath).toBe(FROZEN_MANIFEST_PATH);
      expect(selection.manifestSha256).toBe(CUA_DEMO_DEFAULT_PUBLIC_FACTS.manifestSha256);
      expect(sha256(FROZEN_MANIFEST_PATH)).toBe(CUA_DEMO_DEFAULT_PUBLIC_FACTS.manifestSha256);
      expect(selection.profile.schemaVersion).toBe(2);
    },
  );

  it("leaves unsupported targets unchanged", async () => {
    for (const [targetOs, targetArch] of [
      ["darwin", "x64"],
      ["linux", "arm64"],
      ["win32", "arm64"],
    ]) {
      await expect(
        resolveMacosCuaDemoBuildSelection({
          env: {},
          targetOs,
          targetArch,
          repoRoot: REPO_ROOT,
        }),
      ).resolves.toBeNull();
    }
  });

  it("loads defaults dynamically in tsup config so config bundling keeps REPO_ROOT anchored", () => {
    const source = readFileSync(resolve(REPO_ROOT, "packages/desktop/tsup.config.ts"), "utf8");
    expect(source).not.toMatch(
      /import\s*\{[^}]*resolveMacosCuaDemoBuildSelection[^}]*\}\s*from\s*["'][^"']*macos-cua-demo-defaults\.mjs["']/s,
    );
    expect(source).toContain(
      'pathToFileURL(resolve(import.meta.dirname, "scripts/macos-cua-demo-defaults.mjs")).href',
    );
  });

  it("preserves explicit profile and manifest overrides without requiring opt-in", async () => {
    const fixture = createFixtureRepo();
    const facts = {
      manifestRelativePath: fixture.manifestRelativePath,
      manifestSha256: fixture.manifestSha256,
    };
    const defaults = await resolveMacosCuaDemoBuildSelection({
      env: {},
      targetOs: "darwin",
      targetArch: "arm64",
      repoRoot: fixture.root,
      validateManifest: validateWithoutKeychain,
      defaultFacts: facts,
      defaultAssemblyEnabled: true,
    });
    expect(defaults).not.toBeNull();

    const explicit = await resolveMacosCuaDemoBuildSelection({
      env: {
        [NARROW_MANIFEST_ENV]: fixture.manifestPath,
        [NARROW_AGENT_ENV]: defaults.profileJson,
      },
      targetOs: "darwin",
      targetArch: "arm64",
      repoRoot: fixture.root,
      validateManifest: validateWithoutKeychain,
      defaultFacts: facts,
      defaultAssemblyEnabled: true,
    });
    expect(explicit).toMatchObject({
      source: "explicit",
      manifestPath: fixture.manifestPath,
      profileJson: defaults.profileJson,
    });
    expect(explicit.validated.manifestSha256).toBe(fixture.manifestSha256);

    const manifestOnly = await resolveMacosCuaDemoBuildSelection({
      env: { [NARROW_MANIFEST_ENV]: fixture.manifestPath },
      targetOs: "darwin",
      targetArch: "arm64",
      repoRoot: fixture.root,
      validateManifest: validateWithoutKeychain,
      defaultFacts: facts,
      defaultAssemblyEnabled: true,
    });
    expect(manifestOnly).toMatchObject({ source: "explicit", manifestPath: fixture.manifestPath });
    expect(manifestOnly.profileJson).toBeNull();

    const profileOnly = await resolveMacosCuaDemoBuildSelection({
      env: { [NARROW_AGENT_ENV]: defaults.profileJson },
      targetOs: "darwin",
      targetArch: "arm64",
      repoRoot: fixture.root,
      defaultFacts: facts,
      defaultAssemblyEnabled: true,
    });
    expect(profileOnly).toMatchObject({ source: "explicit", manifestPath: null });
    expect(profileOnly.profileJson).toBe(defaults.profileJson);
  });

  it("fails explicitly when enabled-target default resources are missing or invalid", async () => {
    const missingRoot = mkdtempSync(join(tmpdir(), "zody-cua-demo-defaults-missing-"));
    createdRoots.push(missingRoot);
    await expect(
      resolveMacosCuaDemoBuildSelection({
        env: {},
        targetOs: "darwin",
        targetArch: "arm64",
        repoRoot: missingRoot,
        defaultAssemblyEnabled: true,
      }),
    ).rejects.toMatchObject({ code: "cua-demo-default-resource-missing" });
    // 报错必须指向冻结归档还原命令，缺输入时构建者可自助恢复。
    await expect(
      resolveMacosCuaDemoBuildSelection({
        env: {},
        targetOs: "darwin",
        targetArch: "arm64",
        repoRoot: missingRoot,
        defaultAssemblyEnabled: true,
      }),
    ).rejects.toThrow(CUA_NARROW_FROZEN_RESTORE_HINT);

    const invalidRoot = mkdtempSync(join(tmpdir(), "zody-cua-demo-defaults-invalid-"));
    createdRoots.push(invalidRoot);
    const invalidManifest = resolve(
      invalidRoot,
      CUA_DEMO_DEFAULT_PUBLIC_FACTS.manifestRelativePath,
    );
    mkdirSync(dirname(invalidManifest), { recursive: true });
    writeFileSync(invalidManifest, "{}\n");

    await expect(
      resolveMacosCuaDemoBuildSelection({
        env: {},
        targetOs: "darwin",
        targetArch: "arm64",
        repoRoot: invalidRoot,
        defaultAssemblyEnabled: true,
      }),
    ).rejects.toMatchObject({ code: "cua-demo-default-pin-mismatch" });
  });
});
