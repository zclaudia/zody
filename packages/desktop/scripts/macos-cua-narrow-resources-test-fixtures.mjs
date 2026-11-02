// 窄 CUA 资源测试的共享 fixture：模拟 prepared output（stage app + 受控 pins/native manifest）。
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_IDENTITY_PINS_PATH,
  NARROW_APP_NAME,
  NARROW_AUXILIARY_NAMES,
  NARROW_ENTRY_NAMES,
  NARROW_EXECUTABLE_NAME,
  NARROW_EXECUTABLE_RELATIVE_PATH,
  NARROW_MANIFEST_KIND,
  NARROW_NATIVE_MANIFEST_KIND,
  NARROW_SLOT,
  NARROW_TARGET,
  PINNED_DESIGNATED_REQUIREMENT,
  PINNED_HELPER_IDENTIFIER,
  PINNED_LEAF_SHA1,
  PINNED_LEAF_SHA256,
  PINNED_NODE_CDHASH,
  PINNED_NODE_DESIGNATED_REQUIREMENT,
  PINNED_NODE_IDENTIFIER,
  REPO_ROOT,
  inspectNarrowTree,
  sha256File,
} from "./macos-cua-narrow-resources.mjs";

export const TEST_ROOT = join(
  REPO_ROOT,
  "output",
  "cua-phase1-closeout",
  "a-worker",
  "tests",
);

export function fixtureIdentity(overrides = {}) {
  return {
    helperIdentifier: PINNED_HELPER_IDENTIFIER,
    nodeIdentifier: PINNED_NODE_IDENTIFIER,
    leafSha256: PINNED_LEAF_SHA256,
    leafSha1: PINNED_LEAF_SHA1,
    nodeLeafSha256: PINNED_LEAF_SHA256,
    nodeLeafSha1: PINNED_LEAF_SHA1,
    designatedRequirement: PINNED_DESIGNATED_REQUIREMENT,
    nodeDesignatedRequirement: PINNED_NODE_DESIGNATED_REQUIREMENT,
    nodeCdhash: PINNED_NODE_CDHASH,
    hardenedRuntime: true,
    entitlementsEmpty: true,
    architectures: ["arm64"],
    minimumMacOSVersion: "14.2",
    executableRelativePath: NARROW_EXECUTABLE_RELATIVE_PATH,
    nodeRelativePath: "Contents/Resources/node",
    ...overrides,
  };
}

export function expectedPins() {
  return {
    leafSha256: PINNED_LEAF_SHA256,
    leafSha1: PINNED_LEAF_SHA1,
    designatedRequirement: PINNED_DESIGNATED_REQUIREMENT,
    nodeIdentifier: PINNED_NODE_IDENTIFIER,
    nodeLeafSha256: PINNED_LEAF_SHA256,
    nodeDesignatedRequirement: PINNED_NODE_DESIGNATED_REQUIREMENT,
    nodeCdhash: PINNED_NODE_CDHASH,
  };
}

export async function makeFixtureRoot() {
  await mkdir(TEST_ROOT, { recursive: true });
  return mkdtemp(join(TEST_ROOT, "fixture-"));
}

export async function writeFixturePins(root) {
  const path = join(root, "source", "identity-pins.json");
  await mkdir(join(root, "source"), { recursive: true });
  await writeFile(path, `${JSON.stringify(expectedPins(), null, 2)}\n`);
  return path;
}

export async function makeFixtureApp(root) {
  const appPath = join(root, "source", NARROW_APP_NAME);
  await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
  await mkdir(join(appPath, "Contents", "Resources", "licenses"), { recursive: true });
  await writeFile(
    join(appPath, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${PINNED_HELPER_IDENTIFIER}</string>
<key>CFBundleExecutable</key><string>${NARROW_EXECUTABLE_NAME}</string>
<key>LSMinimumSystemVersion</key><string>14.2</string>
</dict></plist>
`,
  );
  await writeFile(join(appPath, "Contents", "MacOS", NARROW_EXECUTABLE_NAME), "fixture helper\n");
  await writeFile(join(appPath, "Contents", "Resources", "node"), "fixture node\n");
  for (const name of [...NARROW_ENTRY_NAMES, ...NARROW_AUXILIARY_NAMES]) {
    await writeFile(join(appPath, "Contents", "Resources", name), `fixture ${name}\n`);
  }
  await writeFile(
    join(appPath, "Contents", "Resources", "licenses", "node-LICENSE.txt"),
    "fixture license\n",
  );
  return { appPath };
}

export async function makeNativeBuildManifest(root, appPath) {
  const path = join(root, "source", "build-manifest.json");
  const describeFile = async (relativePath) => ({
    path: relativePath,
    sha256: await sha256File(join(appPath, relativePath)),
    bytes: (await readFile(join(appPath, relativePath))).byteLength,
  });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        kind: NARROW_NATIVE_MANIFEST_KIND,
        status: "pass",
        outputRoot: join(root, "source"),
        app: {
          name: NARROW_APP_NAME,
          path: `helper/${NARROW_APP_NAME}`,
          bundleIdentifier: PINNED_HELPER_IDENTIFIER,
        },
        node: {
          sha256: await sha256File(join(appPath, "Contents", "Resources", "node")),
          version: "v24.14.0",
        },
        identityPins: { path: DEFAULT_IDENTITY_PINS_PATH, values: expectedPins() },
        entries: await Promise.all(
          NARROW_ENTRY_NAMES.map(async (name) => ({
            name,
            maxBytes: 64 * 1024 * 1024,
            ...(await describeFile(`Contents/Resources/${name}`)),
          })),
        ),
        auxiliaryResources: await Promise.all(
          NARROW_AUXILIARY_NAMES.map(async (name) => ({
            name,
            maxBytes: 64 * 1024 * 1024,
            ...(await describeFile(`Contents/Resources/${name}`)),
          })),
        ),
        artifact: {
          // native manifest 记录的是 unsigned Mach-O；签名后摘要必须单独计算。
          path: `helper/${NARROW_APP_NAME}/${NARROW_EXECUTABLE_RELATIVE_PATH}`,
          sha256: "1".repeat(64),
        },
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

export async function makePreparedLayout({
  root,
  appPath,
  nativeBuildManifestPath,
  pinsPath,
  overrides = {},
}) {
  const outputRoot = join(root, "output");
  const stageRoot = join(outputRoot, "stage");
  const stageAppPath = join(stageRoot, NARROW_APP_NAME);
  await mkdir(stageRoot, { recursive: true });
  await cp(appPath, stageAppPath, { recursive: true, preserveTimestamps: true });
  const stagePinsPath = join(stageRoot, "identity-pins.json");
  const stageNativePath = join(stageRoot, "native-build-manifest.json");
  await cp(pinsPath, stagePinsPath);
  await cp(nativeBuildManifestPath, stageNativePath);
  const tree = await inspectNarrowTree(stageAppPath);
  const manifest = {
    schemaVersion: 1,
    kind: NARROW_MANIFEST_KIND,
    status: "pass",
    generatedAt: "2026-10-30T00:00:00.000Z",
    target: { ...NARROW_TARGET },
    slot: { resourcesRelativePath: NARROW_SLOT, appName: NARROW_APP_NAME },
    path: "manifest.json",
    source: {
      appPath,
      treeSha256: tree.treeSha256,
      signedBinarySha256: await sha256File(join(stageAppPath, NARROW_EXECUTABLE_RELATIVE_PATH)),
      executableRelativePath: NARROW_EXECUTABLE_RELATIVE_PATH,
      nodeRelativePath: "Contents/Resources/node",
    },
    stage: { appPath: `stage/${NARROW_APP_NAME}`, treeSha256: tree.treeSha256 },
    nativeBuildManifest: {
      path: "stage/native-build-manifest.json",
      sha256: await sha256File(stageNativePath),
      kind: NARROW_NATIVE_MANIFEST_KIND,
      status: "pass",
      nativeUnsignedBinarySha256: "1".repeat(64),
    },
    identity: {
      ...fixtureIdentity(),
      signedBinarySha256: await sha256File(join(stageAppPath, NARROW_EXECUTABLE_RELATIVE_PATH)),
      nativeUnsignedBinarySha256: "1".repeat(64),
      pinsPath: "stage/identity-pins.json",
      pinsSha256: await sha256File(stagePinsPath),
    },
    tree,
    audit: { symlinks: [], hardlinks: [], externalLinks: [], licenses: tree.licenses },
    restrictions: {
      defaultDisabled: true,
      placeholderDefault: true,
      hostActivation: false,
      cuaHelperSlotReused: false,
      reSign: false,
      installCertificate: false,
      requestTcc: false,
    },
    ...overrides,
  };
  const manifestPath = join(outputRoot, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { outputRoot, manifestPath, stageAppPath, manifest, tree };
}
