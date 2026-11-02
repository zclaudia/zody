import assert from "node:assert/strict";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  NARROW_APP_NAME,
  NARROW_EXECUTABLE_NAME,
  assertPackagedNarrowResource,
  inspectNarrowTree,
  sha256File,
  validateNarrowManifest,
  buildNarrowExtraResource,
  createNarrowManifest,
} from "./macos-cua-narrow-resources.mjs";
import {
  fixtureIdentity,
  makeFixtureApp,
  makeFixtureRoot,
  makeNativeBuildManifest,
  makePreparedLayout,
  writeFixturePins,
} from "./macos-cua-narrow-resources-test-fixtures.mjs";

function validateOptions(manifestPath, extra = {}) {
  const { deps, ...rest } = extra;
  return {
    manifestPath,
    targetPlatform: { os: "darwin", arch: "arm64" },
    env: {},
    ...rest,
    deps: { verifyNarrowApp: async () => fixtureIdentity(), ...deps },
  };
}

async function withLayout(run) {
  const root = await makeFixtureRoot();
  try {
    const { appPath } = await makeFixtureApp(root);
    const pinsPath = await writeFixturePins(root);
    const nativeBuildManifestPath = await makeNativeBuildManifest(root, appPath);
    const layout = await makePreparedLayout({
      root,
      appPath,
      nativeBuildManifestPath,
      pinsPath,
    });
    await run({ root, appPath, pinsPath, nativeBuildManifestPath, layout });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("manifest tree digest mismatch is rejected", async () => {
  await withLayout(async ({ layout }) => {
    const manifest = { ...layout.manifest, tree: { ...layout.tree, treeSha256: "0".repeat(64) } };
    await writeFile(layout.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      () => validateNarrowManifest(validateOptions(layout.manifestPath)),
      (error) => {
        assert.equal(error.code, "narrow-content-mismatch");
        return true;
      },
    );
  });
});

test("absolute or escaping controlled paths are rejected", async () => {
  await withLayout(async ({ layout }) => {
    for (const stageAppPath of ["/tmp/other.app", "../escape.app"]) {
      const manifest = {
        ...layout.manifest,
        stage: { ...layout.manifest.stage, appPath: stageAppPath },
      };
      await writeFile(layout.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await assert.rejects(
        () => validateNarrowManifest(validateOptions(layout.manifestPath)),
        (error) => error.code === "narrow-manifest-path",
      );
    }
  });
});

test("tampered staged resource is rejected by file manifest", async () => {
  await withLayout(async ({ layout }) => {
    await writeFile(join(layout.stageAppPath, "Contents", "Resources", "node"), "tampered node\n");
    await assert.rejects(
      () => validateNarrowManifest(validateOptions(layout.manifestPath)),
      (error) => {
        assert.equal(error.code, "narrow-content-mismatch");
        return true;
      },
    );
  });
});

test("desktop-session entry manifest hashes must match the signed app resources", async () => {
  const root = await makeFixtureRoot();
  try {
    const { appPath } = await makeFixtureApp(root);
    const pinsPath = await writeFixturePins(root);
    const nativeBuildManifestPath = await makeNativeBuildManifest(root, appPath);
    const nativeManifest = JSON.parse(await readFile(nativeBuildManifestPath, "utf8"));
    nativeManifest.entries = nativeManifest.entries.map((entry) =>
      entry.name === "cli-entry.mjs" ? { ...entry, sha256: "0".repeat(64) } : entry,
    );
    await writeFile(nativeBuildManifestPath, `${JSON.stringify(nativeManifest, null, 2)}\n`);
    const layout = await makePreparedLayout({ root, appPath, nativeBuildManifestPath, pinsPath });
    await assert.rejects(
      () => validateNarrowManifest(validateOptions(layout.manifestPath)),
      (error) => {
        assert.equal(error.code, "narrow-entry-mismatch");
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("round11 helper manifest is not accepted as the desktop-session assembly source", async () => {
  const root = await makeFixtureRoot();
  try {
    const { appPath } = await makeFixtureApp(root);
    const pinsPath = await writeFixturePins(root);
    const nativeBuildManifestPath = await makeNativeBuildManifest(root, appPath);
    const nativeManifest = JSON.parse(await readFile(nativeBuildManifestPath, "utf8"));
    nativeManifest.kind = "zody-cua-helper-round11-final-build";
    await writeFile(nativeBuildManifestPath, `${JSON.stringify(nativeManifest, null, 2)}\n`);
    const layout = await makePreparedLayout({ root, appPath, nativeBuildManifestPath, pinsPath });
    await assert.rejects(
      () => validateNarrowManifest(validateOptions(layout.manifestPath)),
      (error) => {
        assert.equal(error.code, "narrow-native-manifest-mismatch");
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing node-repl-server resource is rejected even with a matching tree manifest", async () => {
  await withLayout(async ({ layout }) => {
    await rm(join(layout.stageAppPath, "Contents", "Resources", "node-repl-server.mjs"));
    await assert.rejects(
      () => validateNarrowManifest(validateOptions(layout.manifestPath)),
      (error) => {
        assert.equal(error.code, "narrow-content-mismatch");
        return true;
      },
    );
  });
});

test("live identity mismatch is rejected even when the manifest self-reports the fixed pin", async () => {
  await withLayout(async ({ layout }) => {
    await assert.rejects(
      () =>
        validateNarrowManifest(
          validateOptions(layout.manifestPath, {
            deps: { verifyNarrowApp: async () => fixtureIdentity({ leafSha256: "f".repeat(64) }) },
          }),
        ),
      (error) => error.code === "narrow-identity-mismatch",
    );
  });
});

test("symlink resources are rejected", async () => {
  const root = await makeFixtureRoot();
  try {
    const { appPath } = await makeFixtureApp(root);
    await symlink(
      join(appPath, "Contents", "Resources", "node"),
      join(appPath, "Contents", "Resources", "node-link"),
    );
    await assert.rejects(
      () => inspectNarrowTree(appPath),
      (error) => error.code === "narrow-symlink",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native build manifest hash mismatch is rejected", async () => {
  await withLayout(async ({ layout }) => {
    const manifest = {
      ...layout.manifest,
      nativeBuildManifest: { ...layout.manifest.nativeBuildManifest, sha256: "0".repeat(64) },
    };
    await writeFile(layout.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      () => validateNarrowManifest(validateOptions(layout.manifestPath)),
      (error) => {
        assert.equal(error.code, "narrow-native-manifest-mismatch");
        return true;
      },
    );
  });
});

test("prepare copies the desktop-session helper and records signed vs unsigned hashes", async () => {
  const root = await makeFixtureRoot();
  try {
    const { appPath } = await makeFixtureApp(root);
    const pinsPath = await writeFixturePins(root);
    const nativeBuildManifestPath = await makeNativeBuildManifest(root, appPath);
    const outputRoot = join(root, "narrow-output");
    const prepared = await createNarrowManifest({
      appPath,
      nativeBuildManifestPath,
      outputRoot,
      pinsPath,
      replace: false,
      deps: { verifyNarrowApp: async () => fixtureIdentity() },
    });
    assert.equal(prepared.manifest.slot.appName, NARROW_APP_NAME);
    assert.equal(prepared.manifest.path, "manifest.json");
    assert.equal(prepared.manifest.stage.appPath, `stage/${NARROW_APP_NAME}`);
    assert.equal(prepared.stageAppPath, join(outputRoot, "stage", NARROW_APP_NAME));
    assert.equal(prepared.manifest.source.treeSha256, prepared.manifest.stage.treeSha256);
    assert.equal(
      prepared.manifest.identity.signedBinarySha256,
      await sha256File(
        join(outputRoot, "stage", NARROW_APP_NAME, "Contents", "MacOS", NARROW_EXECUTABLE_NAME),
      ),
    );
    assert.equal(prepared.manifest.identity.nativeUnsignedBinarySha256, "1".repeat(64));
    assert.notEqual(
      prepared.manifest.identity.signedBinarySha256,
      prepared.manifest.identity.nativeUnsignedBinarySha256,
    );
    assert.equal(
      await sha256File(join(outputRoot, "stage", "identity-pins.json")),
      prepared.manifest.identity.pinsSha256,
    );
    assert.equal(
      await sha256File(join(outputRoot, "stage", "native-build-manifest.json")),
      prepared.manifest.nativeBuildManifest.sha256,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepared output remains buildable and verifiable after moving the whole directory", async () => {
  const root = await makeFixtureRoot();
  try {
    const { appPath } = await makeFixtureApp(root);
    const pinsPath = await writeFixturePins(root);
    const nativeBuildManifestPath = await makeNativeBuildManifest(root, appPath);
    const outputRoot = join(root, "narrow-output");
    await createNarrowManifest({
      appPath,
      nativeBuildManifestPath,
      outputRoot,
      pinsPath,
      deps: { verifyNarrowApp: async () => fixtureIdentity() },
    });

    const movedRoot = join(root, "moved-output");
    await cp(outputRoot, movedRoot, { recursive: true });
    await rm(outputRoot, { recursive: true, force: true });

    const validated = await validateNarrowManifest(
      validateOptions(join(movedRoot, "manifest.json")),
    );
    assert.equal(validated.stageAppPath, join(movedRoot, "stage", NARROW_APP_NAME));
    assert.deepEqual(buildNarrowExtraResource(validated), [
      {
        from: join(movedRoot, "stage", NARROW_APP_NAME),
        to: `cua-narrow/${NARROW_APP_NAME}`,
      },
      {
        from: join(movedRoot, "manifest.json"),
        to: "cua-narrow/manifest.json",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepare refuses to overwrite an existing stage without --replace", async () => {
  const root = await makeFixtureRoot();
  try {
    const { appPath } = await makeFixtureApp(root);
    const pinsPath = await writeFixturePins(root);
    const nativeBuildManifestPath = await makeNativeBuildManifest(root, appPath);
    const outputRoot = join(root, "narrow-output");
    await createNarrowManifest({
      appPath,
      nativeBuildManifestPath,
      outputRoot,
      pinsPath,
      deps: { verifyNarrowApp: async () => fixtureIdentity() },
    });
    await assert.rejects(
      () =>
        createNarrowManifest({
          appPath,
          nativeBuildManifestPath,
          outputRoot,
          pinsPath,
          deps: { verifyNarrowApp: async () => fixtureIdentity() },
        }),
      (error) => error.code === "narrow-stage-exists",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing fixture pins are rejected before copying", async () => {
  const root = await makeFixtureRoot();
  try {
    const { appPath } = await makeFixtureApp(root);
    const nativeBuildManifestPath = await makeNativeBuildManifest(root, appPath);
    await assert.rejects(
      () =>
        createNarrowManifest({
          appPath,
          nativeBuildManifestPath,
          outputRoot: join(root, "output"),
          pinsPath: join(root, "missing-pins.json"),
          deps: { verifyNarrowApp: async () => fixtureIdentity() },
        }),
      (error) => error.code === "ENOENT" || error.code === "narrow-pins-mismatch",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged cua-narrow resources are revalidated after copy", async () => {
  await withLayout(async ({ layout }) => {
    const resourcesDir = join(layout.outputRoot, "packaged-resources");
    const packagedAppPath = join(resourcesDir, "cua-narrow", NARROW_APP_NAME);
    await mkdir(join(resourcesDir, "cua-narrow"), { recursive: true });
    await cp(layout.stageAppPath, packagedAppPath, { recursive: true, preserveTimestamps: true });
    await cp(layout.manifestPath, join(resourcesDir, "cua-narrow", "manifest.json"));
    const validated = await assertPackagedNarrowResource({
      resourcesDir,
      manifestPath: layout.manifestPath,
      deps: { verifyNarrowApp: async () => fixtureIdentity() },
    });
    assert.equal(validated.packagedAppPath, packagedAppPath);
    assert.equal(validated.packagedTree.treeSha256, layout.tree.treeSha256);
    assert.equal(validated.packagedManifestSha256, validated.manifestSha256);
  });
});

test("packaged cua-narrow manifest must exist at the fixed slot", async () => {
  await withLayout(async ({ layout }) => {
    const resourcesDir = join(layout.outputRoot, "packaged-resources");
    const packagedAppPath = join(resourcesDir, "cua-narrow", NARROW_APP_NAME);
    await mkdir(join(resourcesDir, "cua-narrow"), { recursive: true });
    await cp(layout.stageAppPath, packagedAppPath, { recursive: true, preserveTimestamps: true });
    await assert.rejects(
      () =>
        assertPackagedNarrowResource({
          resourcesDir,
          manifestPath: layout.manifestPath,
          deps: { verifyNarrowApp: async () => fixtureIdentity() },
        }),
      (error) => error.code === "narrow-packaged-manifest-missing",
    );
  });
});

test("packaged cua-narrow manifest bytes must match the validated source", async () => {
  await withLayout(async ({ layout }) => {
    const resourcesDir = join(layout.outputRoot, "packaged-resources");
    const packagedAppPath = join(resourcesDir, "cua-narrow", NARROW_APP_NAME);
    await mkdir(join(resourcesDir, "cua-narrow"), { recursive: true });
    await cp(layout.stageAppPath, packagedAppPath, { recursive: true, preserveTimestamps: true });
    await writeFile(join(resourcesDir, "cua-narrow", "manifest.json"), "{}\n");
    await assert.rejects(
      () =>
        assertPackagedNarrowResource({
          resourcesDir,
          manifestPath: layout.manifestPath,
          deps: { verifyNarrowApp: async () => fixtureIdentity() },
        }),
      (error) => error.code === "narrow-packaged-manifest-mismatch",
    );
  });
});

test("tampered packaged cua-narrow resources are rejected", async () => {
  await withLayout(async ({ layout }) => {
    const resourcesDir = join(layout.outputRoot, "packaged-resources");
    const packagedAppPath = join(resourcesDir, "cua-narrow", NARROW_APP_NAME);
    await mkdir(join(resourcesDir, "cua-narrow"), { recursive: true });
    await cp(layout.stageAppPath, packagedAppPath, { recursive: true, preserveTimestamps: true });
    await cp(layout.manifestPath, join(resourcesDir, "cua-narrow", "manifest.json"));
    await writeFile(join(packagedAppPath, "Contents", "Resources", "host-entry.mjs"), "tampered\n");
    await assert.rejects(
      () =>
        assertPackagedNarrowResource({
          resourcesDir,
          manifestPath: layout.manifestPath,
          deps: { verifyNarrowApp: async () => fixtureIdentity() },
        }),
      (error) => error.code === "narrow-content-mismatch",
    );
  });
});
