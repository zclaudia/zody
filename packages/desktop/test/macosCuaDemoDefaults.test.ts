import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CUA_DEMO_DEFAULT_PUBLIC_FACTS,
  NARROW_AGENT_ENV,
  createMacosCuaDemoBuildEnv,
  resolveMacosCuaDemoBuildSelection,
} from "../scripts/macos-cua-demo-defaults.mjs";
import { NARROW_MANIFEST_ENV } from "../scripts/macos-cua-narrow-resources.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const MANIFEST_PATH = resolve(REPO_ROOT, CUA_DEMO_DEFAULT_PUBLIC_FACTS.manifestRelativePath);
const STARTUP_SNAPSHOT_PATH = resolve(
  REPO_ROOT,
  CUA_DEMO_DEFAULT_PUBLIC_FACTS.startupSnapshotRelativePath,
);

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

describe("macOS CUA self-use build defaults", () => {
  it("selects the pinned profile and manifest on darwin/arm64 without opt-in env", async () => {
    let validationCalls = 0;
    const selection = await resolveMacosCuaDemoBuildSelection({
      env: {},
      targetOs: "darwin",
      targetArch: "arm64",
      repoRoot: REPO_ROOT,
      validateManifest: async (args) => {
        validationCalls += 1;
        return validateWithoutKeychain(args);
      },
    });

    expect(selection).not.toBeNull();
    expect(validationCalls).toBe(1);
    expect(selection.source).toBe("default");
    expect(selection.manifestPath).toBe(MANIFEST_PATH);
    expect(selection.manifestSha256).toBe(CUA_DEMO_DEFAULT_PUBLIC_FACTS.manifestSha256);
    expect(selection.profile).toMatchObject({
      testedTarget: { os: "darwin", arch: "arm64", macOSVersion: "26.6.2" },
      workspaceAllowlist: [REPO_ROOT],
      resourceManifest: {
        sha256: CUA_DEMO_DEFAULT_PUBLIC_FACTS.manifestSha256,
      },
      provider: {
        revisionSha256: CUA_DEMO_DEFAULT_PUBLIC_FACTS.providerDigestSha256,
        selection: {
          providerId: "deepseek",
          modelId: "deepseek-flash",
          options: { reasoningLevel: "max" },
        },
      },
      network: { digestSha256: CUA_DEMO_DEFAULT_PUBLIC_FACTS.networkDigestSha256 },
    });
    expect(sha256(MANIFEST_PATH)).toBe(CUA_DEMO_DEFAULT_PUBLIC_FACTS.manifestSha256);
    expect(sha256(STARTUP_SNAPSHOT_PATH)).toBe(
      CUA_DEMO_DEFAULT_PUBLIC_FACTS.startupSnapshotSha256,
    );
    expect(JSON.parse(selection.profileJson)).toEqual(selection.profile);
    expect(selection.profileJson).not.toContain("httpProxy");
    expect(selection.profileJson).not.toContain("Authorization");
    expect(createMacosCuaDemoBuildEnv(selection)).toEqual({
      [NARROW_MANIFEST_ENV]: MANIFEST_PATH,
      [NARROW_AGENT_ENV]: selection.profileJson,
    });
  });

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
    const defaults = await resolveMacosCuaDemoBuildSelection({
      env: {},
      targetOs: "darwin",
      targetArch: "arm64",
      repoRoot: REPO_ROOT,
      validateManifest: validateWithoutKeychain,
    });
    expect(defaults).not.toBeNull();

    const explicit = await resolveMacosCuaDemoBuildSelection({
      env: {
        [NARROW_MANIFEST_ENV]: MANIFEST_PATH,
        [NARROW_AGENT_ENV]: defaults.profileJson,
      },
      targetOs: "darwin",
      targetArch: "arm64",
      repoRoot: REPO_ROOT,
      validateManifest: validateWithoutKeychain,
    });
    expect(explicit).toMatchObject({
      source: "explicit",
      manifestPath: MANIFEST_PATH,
      profileJson: defaults.profileJson,
    });
    expect(explicit.validated.manifestSha256).toBe(
      CUA_DEMO_DEFAULT_PUBLIC_FACTS.manifestSha256,
    );

    const manifestOnly = await resolveMacosCuaDemoBuildSelection({
      env: { [NARROW_MANIFEST_ENV]: MANIFEST_PATH },
      targetOs: "darwin",
      targetArch: "arm64",
      repoRoot: REPO_ROOT,
      validateManifest: validateWithoutKeychain,
    });
    expect(manifestOnly).toMatchObject({ source: "explicit", manifestPath: MANIFEST_PATH });
    expect(manifestOnly.profileJson).toBeNull();

    const profileOnly = await resolveMacosCuaDemoBuildSelection({
      env: { [NARROW_AGENT_ENV]: defaults.profileJson },
      targetOs: "darwin",
      targetArch: "arm64",
      repoRoot: REPO_ROOT,
    });
    expect(profileOnly).toMatchObject({ source: "explicit", manifestPath: null });
    expect(profileOnly.profileJson).toBe(defaults.profileJson);
  });

  it("fails explicitly when enabled-target default resources are missing or invalid", async () => {
    const missingRoot = mkdtempSync(join(tmpdir(), "zody-cua-demo-defaults-missing-"));
    try {
      await expect(
        resolveMacosCuaDemoBuildSelection({
          env: {},
          targetOs: "darwin",
          targetArch: "arm64",
          repoRoot: missingRoot,
        }),
      ).rejects.toMatchObject({ code: "cua-demo-default-resource-missing" });
    } finally {
      rmSync(missingRoot, { recursive: true, force: true });
    }

    const invalidRoot = mkdtempSync(join(tmpdir(), "zody-cua-demo-defaults-invalid-"));
    try {
      const invalidManifest = resolve(
        invalidRoot,
        CUA_DEMO_DEFAULT_PUBLIC_FACTS.manifestRelativePath,
      );
      const invalidSnapshot = resolve(
        invalidRoot,
        CUA_DEMO_DEFAULT_PUBLIC_FACTS.startupSnapshotRelativePath,
      );
      mkdirSync(dirname(invalidManifest), { recursive: true });
      mkdirSync(dirname(invalidSnapshot), { recursive: true });
      writeFileSync(invalidManifest, "{}\n");
      writeFileSync(invalidSnapshot, "{}\n");

      await expect(
        resolveMacosCuaDemoBuildSelection({
          env: {},
          targetOs: "darwin",
          targetArch: "arm64",
          repoRoot: invalidRoot,
        }),
      ).rejects.toMatchObject({ code: "cua-demo-default-pin-mismatch" });
    } finally {
      rmSync(invalidRoot, { recursive: true, force: true });
    }
  });
});
