import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
  const parsed = await parseArgs(
    [
      "--os",
      "mac",
      "--arch",
      "arm64",
      "--cua-narrow-manifest",
      DEFAULT_MANIFEST_PATH,
    ],
    { env: {}, validateManifest: validateWithoutKeychain },
  );
  assert.deepEqual(parsed.narrowRequest, { manifestPath: DEFAULT_MANIFEST_PATH });
});

test("default darwin arm64 bundle request selects the pinned manifest and profile", async () => {
  const parsed = await parseArgs(["--os", "mac", "--arch", "arm64"], {
    env: {},
    validateManifest: validateWithoutKeychain,
  });
  assert.equal(parsed.narrowRequest.manifestPath, DEFAULT_MANIFEST_PATH);
  assert.equal(typeof parsed.narrowRequest.profileJson, "string");
  const profile = JSON.parse(parsed.narrowRequest.profileJson);
  assert.deepEqual(profile.resourceManifest, {
    sha256: CUA_DEMO_DEFAULT_PUBLIC_FACTS.manifestSha256,
    launcherSha256: profile.resourceManifest.launcherSha256,
  });
  assert.deepEqual(profile.provider.selection, {
    providerId: "deepseek",
    modelId: "deepseek-flash",
    options: { reasoningLevel: "max" },
  });
});

test("unsupported bundle targets keep the narrow request disabled", async () => {
  const parsed = await parseArgs(["--os", "linux", "--arch", "arm64"], { env: {} });
  assert.equal(parsed.narrowRequest, null);
});
