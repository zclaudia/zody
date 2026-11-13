import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { parseArgs } from "./bundle.mjs";
import { CUA_DEMO_DEFAULT_PUBLIC_FACTS } from "./macos-cua-demo-defaults.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const DEFAULT_MANIFEST_PATH = resolve(
  REPO_ROOT,
  CUA_DEMO_DEFAULT_PUBLIC_FACTS.manifestRelativePath,
);

function validateWithoutKeychain({ manifestPath }) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return Promise.resolve({
    manifestPath,
    manifestSha256: createHash("sha256").update(readFileSync(manifestPath)).digest("hex"),
    stageAppPath: resolve(dirname(manifestPath), manifest.stage.appPath),
    identity: { signedBinarySha256: manifest.identity.signedBinarySha256 },
  });
}

// 与 macosCuaDemoDefaults.test.ts 同款合成 fixture：临时 repoRoot + 注入 defaultFacts，
// 使默认选择逻辑在无本机冻结归档的机器上可确定性测试。
function createFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "zody-cua-bundle-args-fixture-"));
  const manifestRelativePath = "output/cua-narrow-frozen/controller-prepared/manifest.json";
  const manifestPath = join(root, manifestRelativePath);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(
    manifestPath,
    JSON.stringify({
      kind: "zody-cua-narrow-resource-manifest",
      status: "pass",
      schemaVersion: 1,
      target: { os: "darwin", arch: "arm64", minimumMacOSVersion: "14.2" },
      slot: { resourcesRelativePath: "cua-narrow", appName: "Zody CUA Desktop Session.app" },
      stage: { appPath: "stage/Zody CUA Desktop Session.app" },
      identity: { signedBinarySha256: "b".repeat(64) },
    }),
  );
  return {
    root,
    manifestPath,
    facts: {
      manifestRelativePath,
      manifestSha256: createHash("sha256").update(readFileSync(manifestPath)).digest("hex"),
    },
  };
}

test("explicit --cua-narrow-manifest without a path is rejected", async () => {
  for (const argv of [
    ["--os", "mac", "--arch", "arm64", "--cua-narrow-manifest"],
    ["--os", "mac", "--arch", "arm64", "--cua-narrow-manifest="],
    ["--os", "mac", "--arch", "arm64", "--cua-narrow-manifest", "--dry-run"],
  ]) {
    await assert.rejects(
      parseArgs(argv, { env: {}, validateManifest: validateWithoutKeychain }),
      /--cua-narrow-manifest requires an absolute manifest path/,
    );
  }
});

test("explicit --cua-narrow-manifest with a path still creates a narrow request", async () => {
  const fixture = createFixtureRepo();
  try {
    const parsed = await parseArgs(
      ["--os", "mac", "--arch", "arm64", "--cua-narrow-manifest", fixture.manifestPath],
      { env: {}, repoRoot: fixture.root, validateManifest: validateWithoutKeychain },
    );
    assert.deepEqual(parsed.narrowRequest, { manifestPath: fixture.manifestPath });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("default darwin arm64 bundle request selects the pinned v2 profile (fixture)", async () => {
  const fixture = createFixtureRepo();
  try {
    const parsed = await parseArgs(["--os", "mac", "--arch", "arm64"], {
      env: {},
      repoRoot: fixture.root,
      validateManifest: validateWithoutKeychain,
      defaultFacts: fixture.facts,
      defaultAssemblyEnabled: true,
    });
    assert.equal(parsed.narrowRequest.manifestPath, fixture.manifestPath);
    assert.equal(typeof parsed.narrowRequest.profileJson, "string");
    const profile = JSON.parse(parsed.narrowRequest.profileJson);
    assert.deepEqual(profile, {
      kind: "zody-cua-narrow-agent-profile",
      schemaVersion: 2,
      capability: "screenshot.single-window",
      minimumTarget: { os: "darwin", arch: "arm64", minimumMacOSVersion: "14.2" },
      resourceManifest: {
        sha256: fixture.facts.manifestSha256,
        launcherSha256: "b".repeat(64),
      },
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("default darwin arm64 bundle request stays enabled after the rebuild round", async () => {
  const parsed = await parseArgs(["--os", "mac", "--arch", "arm64"], {
    env: {},
    validateManifest: validateWithoutKeychain,
  });
  assert.notEqual(parsed.narrowRequest, null);
  assert.equal(typeof parsed.narrowRequest.profileJson, "string");
});

test("unsupported bundle targets keep the narrow request disabled", async () => {
  const parsed = await parseArgs(["--os", "linux", "--arch", "arm64"], { env: {} });
  assert.equal(parsed.narrowRequest, null);
});
