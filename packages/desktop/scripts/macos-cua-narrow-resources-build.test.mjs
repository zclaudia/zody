import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolve } from "node:path";
import test from "node:test";

import {
  CANDIDATE_HOST_LAUNCH_ENV,
  NARROW_APP_NAME,
  NARROW_MANIFEST_ENV,
  NARROW_SLOT,
  assertNoCandidateHostLaunchSeam,
  buildNarrowExtraResource,
  createNarrowBuildEnv,
  getNarrowSignIgnorePatterns,
  resolveNarrowBuildRequest,
} from "./macos-cua-narrow-resources.mjs";
import {
  CUA_DEMO_DEFAULT_PUBLIC_FACTS,
  createMacosCuaDemoBuildEnv,
  resolveMacosCuaDemoBuildSelection,
} from "./macos-cua-demo-defaults.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

function validateWithoutKeychain({ manifestPath }) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return Promise.resolve({
    manifestPath,
    manifestSha256: createHash("sha256").update(readFileSync(manifestPath)).digest("hex"),
    stageAppPath: resolve(dirname(manifestPath), manifest.stage.appPath),
    identity: { signedBinarySha256: manifest.identity.signedBinarySha256 },
  });
}

function createFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "zody-cua-narrow-build-fixture-"));
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

test("default darwin arm64 build selects the pinned narrow profile and manifest (fixture)", async () => {
  const fixture = createFixtureRepo();
  try {
    const selection = await resolveMacosCuaDemoBuildSelection({
      env: {},
      targetOs: "darwin",
      targetArch: "arm64",
      repoRoot: fixture.root,
      validateManifest: validateWithoutKeychain,
      defaultFacts: fixture.facts,
      defaultAssemblyEnabled: true,
    });
    assert.equal(selection.source, "default");
    assert.equal(selection.manifestSha256, fixture.facts.manifestSha256);
    assert.equal(selection.profile.schemaVersion, 2);
    assert.deepEqual(createMacosCuaDemoBuildEnv(selection), {
      ZODY_CUA_NARROW_MANIFEST: fixture.manifestPath,
      ZODY_CUA_NARROW_AGENT_JSON: selection.profileJson,
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }

  assert.equal(
    resolveNarrowBuildRequest({
      cliManifestPath: null,
      env: {},
      targetOs: "darwin",
      targetArch: "arm64",
    }),
    null,
  );
  assert.deepEqual(createNarrowBuildEnv(null), {});
  assert.equal(buildNarrowExtraResource(null), null);
});

test("default darwin arm64 build stays enabled after the rebuild round", async () => {
  const { CUA_NARROW_DEFAULT_ASSEMBLY_ENABLED } = await import("./macos-cua-demo-defaults.mjs");
  assert.equal(CUA_NARROW_DEFAULT_ASSEMBLY_ENABLED, true);
  const selection = await resolveMacosCuaDemoBuildSelection({
    env: {},
    targetOs: "darwin",
    targetArch: "arm64",
    repoRoot: REPO_ROOT,
    validateManifest: validateWithoutKeychain,
  });
  assert.notEqual(selection, null);
  assert.equal(selection.source, "default");
});

test("explicit narrow manifest is absolute, arm64-only and exported to builder env", async () => {
  const request = resolveNarrowBuildRequest({
    cliManifestPath: "/tmp/cua-narrow/manifest.json",
    env: {},
    targetOs: "darwin",
    targetArch: "arm64",
  });
  assert.deepEqual(request, { manifestPath: "/tmp/cua-narrow/manifest.json" });
  assert.deepEqual(createNarrowBuildEnv(request), {
    [NARROW_MANIFEST_ENV]: "/tmp/cua-narrow/manifest.json",
  });

  assert.throws(
    () =>
      resolveNarrowBuildRequest({
        cliManifestPath: "relative/manifest.json",
        env: {},
        targetOs: "darwin",
        targetArch: "arm64",
      }),
    (error) => error.code === "narrow-manifest-required-absolute",
  );
});

test("CLI and env manifests must agree", async () => {
  assert.throws(
    () =>
      resolveNarrowBuildRequest({
        cliManifestPath: "/tmp/a/manifest.json",
        env: { [NARROW_MANIFEST_ENV]: "/tmp/b/manifest.json" },
        targetOs: "darwin",
        targetArch: "arm64",
      }),
    (error) => error.code === "narrow-manifest-conflict",
  );
});

test("explicit narrow manifest rejects non-darwin or non-arm64 targets", async () => {
  for (const [targetOs, targetArch] of [
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["win32", "arm64"],
  ]) {
    assert.throws(
      () =>
        resolveNarrowBuildRequest({
          cliManifestPath: "/tmp/cua-narrow/manifest.json",
          env: {},
          targetOs,
          targetArch,
        }),
      (error) => error.code === "narrow-target-unsupported",
    );
  }
});

test("explicit narrow assembly rejects the candidate Host launch seam", async () => {
  assert.throws(
    () => assertNoCandidateHostLaunchSeam({ [CANDIDATE_HOST_LAUNCH_ENV]: "{}" }),
    (error) => error.code === "candidate-host-launch-forbidden",
  );
  assert.doesNotThrow(() => assertNoCandidateHostLaunchSeam({ [CANDIDATE_HOST_LAUNCH_ENV]: "" }));
  assert.doesNotThrow(() => assertNoCandidateHostLaunchSeam({}));

  assert.throws(
    () =>
      resolveNarrowBuildRequest({
        cliManifestPath: "/tmp/cua-narrow/manifest.json",
        env: { [CANDIDATE_HOST_LAUNCH_ENV]: "{}" },
        targetOs: "darwin",
        targetArch: "arm64",
      }),
    (error) => error.code === "candidate-host-launch-forbidden",
  );
});

test("narrow extra resources copy app and validated manifest bytes into the independent slot", async () => {
  const resource = buildNarrowExtraResource({
    stageAppPath: `/tmp/stage/${NARROW_APP_NAME}`,
    manifestPath: "/tmp/stage/manifest.json",
  });
  assert.deepEqual(resource, [
    {
      from: `/tmp/stage/${NARROW_APP_NAME}`,
      to: `${NARROW_SLOT}/${NARROW_APP_NAME}`,
    },
    {
      from: "/tmp/stage/manifest.json",
      to: `${NARROW_SLOT}/manifest.json`,
    },
  ]);
  assert.equal(resource[0].to.includes("cua-helper"), false);
  assert.equal(resource[1].to.includes("cua-helper"), false);
  assert.throws(
    () => buildNarrowExtraResource({ stageAppPath: "relative/app" }),
    (error) => error.code === "narrow-manifest-stage",
  );
  assert.throws(
    () =>
      buildNarrowExtraResource({
        stageAppPath: `/tmp/stage/${NARROW_APP_NAME}`,
        manifestPath: "relative/manifest.json",
      }),
    (error) => error.code === "narrow-manifest-path",
  );
});

test("signIgnore covers the cua-narrow slot without changing cua-helper", async () => {
  const patterns = getNarrowSignIgnorePatterns();
  assert.equal(patterns.length, 1);
  const pattern = new RegExp(patterns[0]);
  assert.match(`/tmp/Zody.app/Contents/Resources/cua-narrow/${NARROW_APP_NAME}`, pattern);
  assert.doesNotMatch("/tmp/Zody.app/Contents/Resources/cua-helper/Zody.app", pattern);
});

test("explicit empty CLI manifest never degrades to an unrequested build", async () => {
  assert.throws(
    () =>
      resolveNarrowBuildRequest({
        cliManifestPath: "",
        env: {},
        targetOs: "darwin",
        targetArch: "arm64",
      }),
    (error) => error.code === "narrow-manifest-required-absolute",
  );
});
