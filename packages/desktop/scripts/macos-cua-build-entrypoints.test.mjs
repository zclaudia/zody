import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseArgs } from "./bundle.mjs";
import { parse } from "yaml";

test("bundle prepares missing default CUA before resolving its build profile; dry-run remains read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "zody-bundle-auto-"));
  const relative = "output/cua-narrow-frozen/controller-prepared/manifest.json";
  const bytes = JSON.stringify({
    kind: "zody-cua-narrow-resource-manifest",
    status: "pass",
    schemaVersion: 1,
    target: { os: "darwin", arch: "arm64", minimumMacOSVersion: "14.2" },
    slot: { resourcesRelativePath: "cua-narrow", appName: "Zody CUA Desktop Session.app" },
    stage: { appPath: "stage/Zody CUA Desktop Session.app" },
    identity: { signedBinarySha256: "a".repeat(64) },
  });
  const sha = createHash("sha256").update(bytes).digest("hex");
  let preparations = 0;
  const options = {
    env: {},
    repoRoot: root,
    defaultFacts: { manifestRelativePath: relative, manifestSha256: sha },
    defaultAssemblyEnabled: true,
    validateManifest: async ({ manifestPath }) => ({
      manifestSha256: sha,
      manifestPath,
      identity: { signedBinarySha256: "a".repeat(64) },
    }),
    ensureFrozenInputs: async () => {
      preparations++;
      await mkdir(dirname(join(root, relative)), { recursive: true });
      await writeFile(join(root, relative), bytes);
    },
  };
  try {
    await assert.rejects(parseArgs(["--os", "mac", "--arch", "arm64", "--dry-run"], options));
    assert.equal(preparations, 0);
    const resolved = await parseArgs(["--os", "mac", "--arch", "arm64"], options);
    assert.equal(preparations, 1);
    assert.equal(resolved.narrowRequest.manifestPath, join(root, relative));
    assert.ok(JSON.parse(resolved.narrowRequest.profileJson).resourceManifest.sha256 === sha);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("release arm64 prepares CUA and private keychain before build and always cleans before collection", async () => {
  const workflow = parse(
    await readFile(new URL("../../../.github/workflows/zody-release.yml", import.meta.url), "utf8"),
  );
  const steps = workflow.jobs.desktop.steps;
  const prepare = steps.findIndex((s) => s.run?.includes("prepare:macos-cua"));
  const setup = steps.findIndex((s) => s.run?.includes("macos-private-keychain.mjs setup"));
  const build = steps.findIndex((s) => s.run?.includes("run bundle --os"));
  const cleanup = steps.findIndex((s) => s.run?.includes("macos-private-keychain.mjs cleanup"));
  const collect = steps.findIndex((s) => s.run?.includes("collect-desktop-artifact"));
  assert.ok(
    prepare >= 0 && setup > prepare && build > setup && cleanup > build && collect > cleanup,
  );
  assert.match(steps[prepare].if, /matrix.target == 'darwin-arm64'/);
  assert.doesNotMatch(steps[prepare].if, /CUA_NARROW_FROZEN_RESTORE/);
  assert.match(steps[cleanup].if, /always\(\)/);
  assert.ok(steps[setup].env.ZODY_MAC_PRIVATE_CERT_P12_BASE64.includes("secrets."));
  assert.ok(steps[setup].env.ZODY_MAC_PRIVATE_CERT_PASSWORD.includes("secrets."));
  assert.ok(steps[build].env.ZODY_MAC_PRIVATE_SIGN.includes("darwin-arm64"));
});
