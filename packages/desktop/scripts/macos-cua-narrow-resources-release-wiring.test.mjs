import assert from "node:assert/strict";
import test from "node:test";
import { resolve, join } from "node:path";
import { mkdtemp, readFile, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { assertMacosCuaSigningSelection } from "./macos-cua-distribution-policy.mjs";
import { loadIdentityProfile } from "./macos-cua-narrow-identity-profile.mjs";
import {
  createNarrowManifest,
  validateNarrowManifest,
  assertPackagedNarrowResource,
} from "./macos-cua-narrow-resources-manifest.mjs";
import {
  makeFixtureApp,
  makeNativeBuildManifest,
  fixtureIdentity,
} from "./macos-cua-narrow-resources-test-fixtures.mjs";
import { parsePrepareArgs } from "./macos-cua-narrow-resources-prepare.mjs";
import {
  resolveMacosCuaDemoBuildSelection,
  createMacosCuaDemoBuildEnv,
} from "./macos-cua-demo-defaults.mjs";
const profileEnv = { ZODY_CUA_NARROW_IDENTITY_PROFILE: "developer-id" };
const manifestPath = resolve("/tmp/explicit-release-manifest.json");
const prepareArgs = [
  "--app",
  "/tmp/Zody CUA Desktop Session.app",
  "--native-build-manifest",
  "/tmp/build-manifest.json",
];
test("prepare explicitly selects release identity and its pins", () => {
  const options = parsePrepareArgs([
    ...prepareArgs,
    "--identity-profile",
    "developer-id",
    "--identity-pins",
    "/tmp/release-pins.json",
  ]);
  assert.equal(options.identityProfile, "developer-id");
  assert.equal(options.pinsPath, "/tmp/release-pins.json");
  assert.equal(parsePrepareArgs(prepareArgs).identityProfile, "local-self-signed");
  assert.throws(
    () => parsePrepareArgs([...prepareArgs, "--identity-profile", "developer-id"]),
    /pins/i,
  );
  assert.throws(
    () => parsePrepareArgs([...prepareArgs, "--identity-profile", "typo"]),
    /identity.profile/i,
  );
  assert.throws(() => parsePrepareArgs([...prepareArgs, "--unknown", "value"]), /unknown/i);
});
test("release build cannot fall back to local default or bare runtime profile", async () => {
  for (const env of [profileEnv, { ...profileEnv, ZODY_CUA_NARROW_AGENT_JSON: "{}" }]) {
    await assert.rejects(
      resolveMacosCuaDemoBuildSelection({ env, targetOs: "darwin", targetArch: "arm64" }),
      (e) => e.code === "narrow-release-manifest-required",
    );
  }
});
test("unknown or unsupported identity selection is rejected before manifest validation", async () => {
  for (const [identity, os, arch] of [
    ["typo", "darwin", "arm64"],
    ["developer-id", "linux", "x64"],
    ["developer-id", "darwin", "x64"],
  ]) {
    let validations = 0;
    await assert.rejects(
      resolveMacosCuaDemoBuildSelection({
        env: { ZODY_CUA_NARROW_IDENTITY_PROFILE: identity },
        cliManifestPath: manifestPath,
        targetOs: os,
        targetArch: arch,
        validateManifest: async () => {
          validations++;
          return {};
        },
      }),
    );
    assert.equal(validations, 0);
  }
});
test("release selection propagates explicit identity but rejects a local validated result", async () => {
  let observed;
  const validateManifest = async (options) => {
    observed = options;
    return {
      identity: { signedBinarySha256: "a".repeat(64) },
      pins: { identityProfile: "developer-id", teamIdentifier: "ABCDE12345" },
      manifestSha256: "b".repeat(64),
    };
  };
  const env = {
    ...profileEnv,
    ZODY_CUA_NARROW_AGENT_JSON: JSON.stringify({
      resourceManifest: { sha256: "b".repeat(64), launcherSha256: "a".repeat(64) },
    }),
  };
  const selected = await resolveMacosCuaDemoBuildSelection({
    env,
    cliManifestPath: manifestPath,
    targetOs: "darwin",
    targetArch: "arm64",
    validateManifest,
  });
  assert.equal(observed.identityProfile, "developer-id");
  assert.equal(selected.identityProfile, "developer-id");
  assert.equal(
    createMacosCuaDemoBuildEnv(selected).ZODY_CUA_NARROW_IDENTITY_PROFILE,
    "developer-id",
  );
  await assert.rejects(
    resolveMacosCuaDemoBuildSelection({
      env: profileEnv,
      cliManifestPath: manifestPath,
      targetOs: "darwin",
      targetArch: "arm64",
      validateManifest: async () => ({
        identity: {},
        pins: { identityProfile: "local-self-signed" },
      }),
    }),
  );
});
test("outer signing rejects unsigned, local CUA, wrong team and installer identities", () => {
  const validated = { pins: { identityProfile: "developer-id", teamIdentifier: "ABCDE12345" } };
  const good = {
    ...profileEnv,
    ZODY_ENABLE_MAC_SIGN: "1",
    APPLE_SIGNING_IDENTITY: "Developer ID Application: Fixture (ABCDE12345)",
  };
  assert.doesNotThrow(() => assertMacosCuaSigningSelection({ env: good, validated }));
  for (const env of [
    profileEnv,
    { ...good, ZODY_ENABLE_MAC_SIGN: "0" },
    { ...good, APPLE_SIGNING_IDENTITY: "Developer ID Application: Fixture (OTHER12345)" },
    { ...good, APPLE_SIGNING_IDENTITY: "Developer ID Installer: Fixture (ABCDE12345)" },
  ]) {
    assert.throws(
      () => assertMacosCuaSigningSelection({ env, validated }),
      (e) => e.code === "narrow-release-signing-required",
    );
  }
  assert.throws(() =>
    assertMacosCuaSigningSelection({
      env: good,
      validated: { pins: { identityProfile: "local-self-signed" } },
    }),
  );
  assert.throws(() =>
    assertMacosCuaSigningSelection({
      env: { ...good, ZODY_CUA_NARROW_IDENTITY_PROFILE: "local-self-signed" },
      validated: { pins: { identityProfile: "local-self-signed" } },
    }),
  );
  assert.doesNotThrow(() =>
    assertMacosCuaSigningSelection({
      env: {},
      validated: { pins: { identityProfile: "local-self-signed" } },
    }),
  );
  assert.doesNotThrow(() =>
    assertMacosCuaSigningSelection({ env: { ZODY_ENABLE_MAC_SIGN: "1" }, validated: null }),
  );
});
test("prepared release identity survives prepare, validate, Host profile and packaged recheck (offline)", async () => {
  const root = await mkdtemp(join(tmpdir(), "cua-release-chain-"));
  const policy = {
    schemaVersion: 1,
    kind: "zody-cua-developer-id-trust",
    status: "configured",
    teamIdentifier: "ABCDE12345",
    leafSha256: "a".repeat(64),
    leafSha1: "b".repeat(40),
    nodeCdhash: "c".repeat(40),
  };
  const read = async (path, ...args) =>
    path.endsWith("/build/cua-narrow-developer-id.json")
      ? Buffer.from(JSON.stringify(policy))
      : readFile(path, ...args);
  const pins = await loadIdentityProfile({
    identityProfile: "developer-id",
    deps: { readFile: read },
  });
  const deps = { readFile: read, verifyNarrowApp: async () => fixtureIdentity(pins) };
  try {
    const { appPath } = await makeFixtureApp(root);
    const nativeBuildManifestPath = await makeNativeBuildManifest(root, appPath);
    const native = JSON.parse(await readFile(nativeBuildManifestPath, "utf8"));
    native.identityPins.values = pins;
    await writeFile(nativeBuildManifestPath, JSON.stringify(native));
    const pinsPath = join(root, "pins.json");
    await writeFile(pinsPath, JSON.stringify(pins));
    const prepared = await createNarrowManifest({
      appPath,
      nativeBuildManifestPath,
      pinsPath,
      identityProfile: "developer-id",
      outputRoot: join(root, "prepared"),
      deps,
    });
    const options = {
      manifestPath: prepared.manifestPath,
      targetPlatform: { os: "darwin", arch: "arm64" },
      identityProfile: "developer-id",
      env: {},
      deps,
    };
    const validated = await validateNarrowManifest(options);
    assert.equal(validated.pins.teamIdentifier, policy.teamIdentifier);
    assert.equal(validated.manifest.identity.identityProfile, "developer-id");
    const selected = await resolveMacosCuaDemoBuildSelection({
      env: profileEnv,
      cliManifestPath: prepared.manifestPath,
      targetOs: "darwin",
      targetArch: "arm64",
      validateManifest: (o) => validateNarrowManifest({ ...o, deps }),
    });
    const hostProfile = JSON.parse(selected.profileJson);
    assert.equal(hostProfile.resourceManifest.sha256, validated.manifestSha256);
    assert.equal(
      hostProfile.resourceManifest.launcherSha256,
      validated.identity.signedBinarySha256,
    );
    await cp(join(root, "prepared/stage"), join(root, "resources/cua-narrow"), { recursive: true });
    await cp(prepared.manifestPath, join(root, "resources/cua-narrow/manifest.json"));
    const packaged = await assertPackagedNarrowResource({
      resourcesDir: join(root, "resources"),
      manifestPath: prepared.manifestPath,
      env: profileEnv,
      deps,
    });
    assert.equal(packaged.packagedIdentity.teamIdentifier, policy.teamIdentifier);
    await assert.rejects(
      validateNarrowManifest({ ...options, identityProfile: "local-self-signed" }),
      (e) => e.code === "narrow-pins-mismatch",
    );
    const manifest = JSON.parse(await readFile(prepared.manifestPath, "utf8"));
    manifest.identity.teamIdentifier = "OTHER12345";
    await writeFile(prepared.manifestPath, JSON.stringify(manifest));
    await assert.rejects(
      validateNarrowManifest(options),
      (e) => e.code === "narrow-identity-mismatch",
    );
    assert.notEqual(
      createHash("sha256")
        .update(await readFile(prepared.manifestPath))
        .digest("hex"),
      hostProfile.resourceManifest.sha256,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
