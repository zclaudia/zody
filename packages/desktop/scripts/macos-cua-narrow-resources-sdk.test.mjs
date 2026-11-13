import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { validateNarrowManifest } from "./macos-cua-narrow-resources.mjs";
import { validateNativeBuildManifest } from "./macos-cua-narrow-resources-native.mjs";
import {
  expectedPins,
  fixtureIdentity,
  makeFixtureApp,
  makeFixtureRoot,
  makeNativeBuildManifest,
  makePreparedLayout,
  writeFixturePins,
} from "./macos-cua-narrow-resources-test-fixtures.mjs";

async function withLayout(run) {
  const root = await makeFixtureRoot();
  try {
    const { appPath } = await makeFixtureApp(root);
    const pinsPath = await writeFixturePins(root);
    const nativeBuildManifestPath = await makeNativeBuildManifest(root, appPath);
    const layout = await makePreparedLayout({ root, appPath, nativeBuildManifestPath, pinsPath });
    await run({ layout });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function validateOptions(manifestPath) {
  return {
    manifestPath,
    targetPlatform: { os: "darwin", arch: "arm64" },
    env: {},
    deps: { verifyNarrowApp: async () => fixtureIdentity() },
  };
}

for (const name of [
  "computer-use-sdk/scripts/computer-use-client.mjs",
  "computer-use-sdk/docs/computer-use.md",
]) {
  for (const mode of ["missing", "tampered"]) {
    test(`${mode} SDK resource ${name} is rejected`, async () => {
      await withLayout(async ({ layout }) => {
        const path = join(layout.stageAppPath, "Contents", "Resources", name);
        if (mode === "missing") await rm(path);
        else await writeFile(path, "tampered");
        await assert.rejects(
          () => validateNarrowManifest(validateOptions(layout.manifestPath)),
          (error) => error.code === "narrow-content-mismatch",
        );
      });
    });
  }
}

test("legacy server-only signed fixture prepares and validates", async () => {
  const root = await makeFixtureRoot();
  try {
    const { appPath } = await makeFixtureApp(root, { legacy: true });
    const pinsPath = await writeFixturePins(root);
    const nativeBuildManifestPath = await makeNativeBuildManifest(root, appPath, { legacy: true });
    const layout = await makePreparedLayout({ root, appPath, nativeBuildManifestPath, pinsPath });
    await validateNarrowManifest(validateOptions(layout.manifestPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy native manifest cannot hide SDK files in the signed app", async () => {
  const root = await makeFixtureRoot();
  try {
    const { appPath } = await makeFixtureApp(root);
    const pinsPath = await writeFixturePins(root);
    const nativeBuildManifestPath = await makeNativeBuildManifest(root, appPath, { legacy: true });
    const layout = await makePreparedLayout({ root, appPath, nativeBuildManifestPath, pinsPath });
    await assert.rejects(() => validateNarrowManifest(validateOptions(layout.manifestPath)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("incomplete SDK declaration cannot downgrade to legacy", async () => {
  const root = await makeFixtureRoot();
  try {
    const { appPath } = await makeFixtureApp(root);
    const pinsPath = await writeFixturePins(root);
    const nativeBuildManifestPath = await makeNativeBuildManifest(root, appPath);
    const native = JSON.parse(await readFile(nativeBuildManifestPath, "utf8"));
    native.auxiliaryResources.pop();
    await writeFile(nativeBuildManifestPath, JSON.stringify(native));
    const layout = await makePreparedLayout({ root, appPath, nativeBuildManifestPath, pinsPath });
    await assert.rejects(() => validateNarrowManifest(validateOptions(layout.manifestPath)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native new manifest with a missing SDK file cannot fall back to legacy", async () => {
  const root = await makeFixtureRoot();
  try {
    const { appPath } = await makeFixtureApp(root);
    const nativeBuildManifestPath = await makeNativeBuildManifest(root, appPath);
    await rm(join(appPath, "Contents", "Resources", "computer-use-sdk", "docs", "computer-use.md"));
    await assert.rejects(
      () => validateNativeBuildManifest({ appPath, nativeBuildManifestPath, pins: expectedPins() }),
      (error) => error.code === "narrow-entry-mismatch",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
