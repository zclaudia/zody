// 原生派生：在 output 独立 source stage 复制 R11/R10 源并应用固定 orchestrator patch。
// 不修改 R11 只读源；编译/链接参数与 R11 final-build 同 SDK/arch/minOS/rpath。
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  APP_BINARY_NAME,
  BUNDLE_ID,
  FIXED_ARCH,
  FIXED_DEPLOYMENT_TARGET,
  ProductWiringBuildError,
  R10_SOURCES,
  R11_SOURCES,
  REPO_ROOT,
} from "./cua-helper-product-wiring-config.mjs";
import { run, sha256File } from "./cua-helper-product-wiring-toolchain.mjs";

const IDENTITY_PIN_FIELDS = [
  "leafSha256",
  "designatedRequirement",
  "nodeIdentifier",
  "nodeLeafSha256",
  "nodeDesignatedRequirement",
  "nodeCdhash",
];

export async function loadIdentityPins(path) {
  const raw = JSON.parse(await readFile(path, "utf8"));
  const pins = {};
  for (const field of IDENTITY_PIN_FIELDS) {
    const value = raw[field] ?? "";
    if (typeof value !== "string") {
      throw new ProductWiringBuildError("identity-pins", `identityPins.${field} must be a string`, {
        field,
      });
    }
    pins[field] = value;
  }
  if (!pins.leafSha256 || !pins.designatedRequirement || !pins.nodeCdhash) {
    throw new ProductWiringBuildError(
      "identity-pins",
      "identity pins must include leafSha256, designatedRequirement and nodeCdhash",
    );
  }
  return pins;
}

async function copyNamedFiles(sourceDir, targetDir, names) {
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  for (const name of names) {
    await copyFile(join(sourceDir, name), join(targetDir, name));
  }
  return names;
}

async function headerNames(dir) {
  return (await readdir(dir)).filter((name) => name.endsWith(".h")).sort();
}

async function usedSourceNames(root, compiled) {
  return [...new Set([...compiled, ...(await headerNames(join(root, "src")))])].sort();
}

/** 复制 R11/R10 源到独立 stage，逐一核对冻结基线，并按序应用逐个 pin 的 patch（--fuzz=0）。 */
export async function prepareSourceStage({ stageRoot, r11Root, r10Root, baselinePath }) {
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  const expected = baseline.sources ?? {};
  const patches = Array.isArray(baseline.patches) ? baseline.patches : [];
  if (patches.length === 0) {
    throw new ProductWiringBuildError(
      "baseline-patches-missing",
      "source baseline has no pinned patches",
      { baselinePath },
    );
  }

  const r11Src = join(stageRoot, "src");
  const r10Src = join(stageRoot, "r10", "src");
  const r11Names = await usedSourceNames(r11Root, R11_SOURCES);
  const r10Names = await usedSourceNames(r10Root, R10_SOURCES);
  await copyNamedFiles(join(r11Root, "src"), r11Src, r11Names);
  await copyNamedFiles(join(r10Root, "src"), r10Src, r10Names);

  const verified = [];
  const verifyBaseline = async (key, path) => {
    const want = expected[key];
    if (want === undefined) {
      // 只复制实际编译源 + 头文件；任一缺失基线条目都说明冻结清单与来源漂移。
      throw new ProductWiringBuildError(
        "baseline-missing-entry",
        `${key} is copied for the build but missing from the frozen R11 baseline`,
        { key, path },
      );
    }
    const got = await sha256File(path);
    if (got !== want) {
      throw new ProductWiringBuildError(
        "baseline-mismatch",
        `${key} differs from the frozen R11 source baseline`,
        { key, expected: want, actual: got, path },
      );
    }
    verified.push({ key, sha256: got });
  };
  for (const name of r11Names) {
    await verifyBaseline(`round11/src/${name}`, join(r11Src, name));
  }
  for (const name of r10Names) {
    await verifyBaseline(`r10/src/${name}`, join(r10Src, name));
  }

  const applied = [];
  for (const entry of patches) {
    const patchPath = isAbsolute(entry.path)
      ? entry.path
      : resolve(dirname(baselinePath), entry.path);
    const patchSha256 = await sha256File(patchPath);
    if (patchSha256 !== entry.sha256) {
      throw new ProductWiringBuildError(
        "patch-file-mismatch",
        `patch ${entry.id} bytes differ from the pinned hash`,
        { id: entry.id, expected: entry.sha256, actual: patchSha256, patchPath },
      );
    }
    const targetPath = join(stageRoot, entry.file);
    const beforeSha256 = await sha256File(targetPath);
    if (beforeSha256 !== entry.beforeSha256) {
      throw new ProductWiringBuildError(
        "patch-baseline-mismatch",
        `patch ${entry.id} target ${entry.file} does not match its pinned before hash`,
        { id: entry.id, file: entry.file, expected: entry.beforeSha256, actual: beforeSha256 },
      );
    }
    // --fuzz=0：只接受与冻结来源完全一致的上下文，拒绝宽松匹配跟随未审源码。
    const result = await run("/usr/bin/patch", ["--fuzz=0", "-p1", "-i", patchPath], {
      cwd: stageRoot,
    });
    if (result.code !== 0) {
      throw new ProductWiringBuildError("patch-failed", `patch ${entry.id} failed (fuzz=0)`, {
        id: entry.id,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }
    const afterSha256 = await sha256File(targetPath);
    if (afterSha256 !== entry.afterSha256) {
      throw new ProductWiringBuildError(
        "patch-output-mismatch",
        `patch ${entry.id} output differs from the pinned after hash`,
        { id: entry.id, file: entry.file, expected: entry.afterSha256, actual: afterSha256 },
      );
    }
    applied.push({
      id: entry.id,
      file: entry.file,
      patchPath,
      patchSha256,
      fuzz: 0,
      beforeSha256,
      afterSha256,
    });
  }

  const orchestratorPath = join(r11Src, "orchestrator.mm");
  const patched = await readFile(orchestratorPath, "utf8");
  if (!patched.includes("NSDictionary* bootstrap = @{};") || patched.includes("uuid_string")) {
    throw new ProductWiringBuildError(
      "patch-verify",
      "patched orchestrator does not have empty bootstrap / still generates skeleton ids",
    );
  }
  if (!patched.includes("32 * 1024 * 1024")) {
    throw new ProductWiringBuildError("patch-verify", "patched orchestrator missing 32MiB bound");
  }
  const nodeProcess = await readFile(join(r11Src, "node_process.mm"), "utf8");
  if (
    !nodeProcess.includes(
      "posix_spawn_file_actions_adddup2(&actions, STDERR_FILENO, STDERR_FILENO)",
    )
  ) {
    throw new ProductWiringBuildError(
      "patch-verify",
      "patched node_process missing explicit stderr preservation",
    );
  }

  const sourceHashes = {};
  for (const name of r11Names)
    sourceHashes[`round11/src/${name}`] = await sha256File(join(r11Src, name));
  for (const name of r10Names)
    sourceHashes[`r10/src/${name}`] = await sha256File(join(r10Src, name));
  const report = {
    stageRoot,
    baselinePath,
    baselineProvenance: baseline.provenance,
    r11SourceCount: r11Names.length,
    r10SourceCount: r10Names.length,
    r11Sources: R11_SOURCES,
    r10Sources: R10_SOURCES,
    verifiedCount: verified.length,
    verified,
    patches: applied,
    sourceHashes,
  };
  await writeFile(join(stageRoot, "stage-manifest.json"), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  return { r11Src, r10Src, report };
}

export function appCompileArgs(toolchain, { r11Src, r10Src, includeRoot, visualRoot, output }) {
  const sdk = toolchain.sdk.path;
  const sources = [
    ...R11_SOURCES.map((name) => join(r11Src, name)),
    ...R10_SOURCES.map((name) => join(r10Src, name)),
  ];
  return [
    "-std=c++17",
    "-x",
    "objective-c++",
    "-fobjc-arc",
    "-arch",
    FIXED_ARCH,
    "-isysroot",
    sdk,
    `-mmacosx-version-min=${FIXED_DEPLOYMENT_TARGET}`,
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-DCUA_R11_HAVE_VISUAL",
    "-I",
    r11Src,
    "-I",
    r10Src,
    "-I",
    includeRoot,
    "-I",
    join(visualRoot, "lib"),
    ...sources,
    "-x",
    "none",
    join(visualRoot, "lib/libcua_macos_visual_round11.a"),
    "-L",
    join(sdk, "usr/lib/swift"),
    "-Wl,-rpath,/usr/lib/swift",
    "-liconv",
    "-framework",
    "Foundation",
    "-framework",
    "Security",
    "-framework",
    "CoreFoundation",
    "-framework",
    "CoreGraphics",
    "-framework",
    "ScreenCaptureKit",
    "-framework",
    "AppKit",
    "-lbsm",
    "-o",
    output,
  ];
}

function cString(value) {
  let escaped = "";
  for (const character of String(value)) {
    const code = character.codePointAt(0);
    switch (character) {
      case "\\":
        escaped += "\\\\";
        break;
      case '"':
        escaped += '\\"';
        break;
      case "\n":
        escaped += "\\n";
        break;
      case "\r":
        escaped += "\\r";
        break;
      case "\t":
        escaped += "\\t";
        break;
      default:
        if (code < 0x20 || code > 0x7e) {
          throw new ProductWiringBuildError(
            "pin-encoding",
            "pin values must stay printable ASCII",
            {
              value,
            },
          );
        }
        escaped += character;
    }
  }
  return escaped;
}

export function pinsHeader(resources, identityPins) {
  return `#pragma once
// 由 product-wiring builder 生成。身份 pin 复用已签名 R11 证书/DR/Node CDHash；
// 资源 pin 来自本次实际 bundle/复制后的 bytes。builder 不签名。
#define CUA_ROUND11_PIN_BUNDLE_ID "${cString(BUNDLE_ID)}"
#define CUA_ROUND11_PIN_LEAF_SHA256 "${cString(identityPins.leafSha256)}"
#define CUA_ROUND11_PIN_DESIGNATED_REQUIREMENT "${cString(identityPins.designatedRequirement)}"
#define CUA_ROUND11_PIN_NODE_SHA256 "${cString(resources.nodeSha256)}"
#define CUA_ROUND11_PIN_AUTHORITY_SHA256 "${cString(resources.authoritySha256)}"
#define CUA_ROUND11_PIN_NODE_IDENTIFIER "${cString(identityPins.nodeIdentifier)}"
#define CUA_ROUND11_PIN_NODE_LEAF_SHA256 "${cString(identityPins.nodeLeafSha256)}"
#define CUA_ROUND11_PIN_NODE_DESIGNATED_REQUIREMENT "${cString(identityPins.nodeDesignatedRequirement)}"
#define CUA_ROUND11_PIN_NODE_CDHASH "${cString(identityPins.nodeCdhash)}"
`;
}

export function appInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>${APP_BINARY_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Zody CUA Helper Round11</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.2.0</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>LSMinimumSystemVersion</key><string>${FIXED_DEPLOYMENT_TARGET}</string>
</dict>
</plist>
`;
}

export { REPO_ROOT };
