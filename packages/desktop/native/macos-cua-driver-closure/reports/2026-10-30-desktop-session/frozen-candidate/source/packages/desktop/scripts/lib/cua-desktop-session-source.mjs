// 只读冻结 R11/product-wiring 源，在 output stage 派生 desktop-session 候选。
// 三个既有 patch 由 product baseline 固定；capture_owner 只追加“正常截图不自动 revoke”。
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  DesktopSessionBuildError,
  FIXED_ARCH,
  FIXED_DEPLOYMENT_TARGET,
  NATIVE_ROOT,
  PRODUCT_BASELINE,
  R10_COMPILE_SOURCES,
  R11_COMPILE_SOURCES,
  SESSION_BASELINE,
  SESSION_SOURCES,
  APP_BINARY_NAME,
  BUNDLE_ID,
} from "./cua-desktop-session-config.mjs";
import { prepareSourceStage, loadIdentityPins } from "./cua-helper-product-wiring-native.mjs";
import { run, sha256File } from "./cua-desktop-session-toolchain.mjs";

export { loadIdentityPins };

async function copySessionSources(targetDirectory) {
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  const names = (await readdir(join(NATIVE_ROOT, "src")))
    .filter((name) => name.endsWith(".h") || name.endsWith(".mm"))
    .sort();
  for (const name of names) {
    await copyFile(join(NATIVE_ROOT, "src", name), join(targetDirectory, name));
  }
  return names;
}

export async function prepareSessionSourceStage({ stageRoot, r11Root, r10Root }) {
  const product = await prepareSourceStage({
    stageRoot,
    r11Root,
    r10Root,
    baselinePath: PRODUCT_BASELINE,
  });
  const baseline = JSON.parse(await readFile(SESSION_BASELINE, "utf8"));
  const patches = Array.isArray(baseline.patches) ? baseline.patches : [];
  if (patches.length !== 1) {
    throw new DesktopSessionBuildError(
      "session-baseline-patches",
      "session baseline must pin exactly the capture-owner patch",
      { count: patches.length },
    );
  }
  const entry = patches[0];
  const patchPath = isAbsolute(entry.path)
    ? entry.path
    : resolve(dirname(SESSION_BASELINE), entry.path);
  const patchSha256 = await sha256File(patchPath);
  if (patchSha256 !== entry.sha256) {
    throw new DesktopSessionBuildError(
      "session-patch-file-mismatch",
      `patch ${entry.id} bytes differ from the pinned hash`,
      { expected: entry.sha256, actual: patchSha256, patchPath },
    );
  }
  const targetPath = join(stageRoot, entry.file);
  const beforeSha256 = await sha256File(targetPath);
  if (beforeSha256 !== entry.beforeSha256) {
    throw new DesktopSessionBuildError(
      "session-patch-baseline-mismatch",
      `patch ${entry.id} target does not match its pinned before hash`,
      { expected: entry.beforeSha256, actual: beforeSha256, file: entry.file },
    );
  }
  const patched = await run("/usr/bin/patch", ["--fuzz=0", "-p1", "-i", patchPath], {
    cwd: stageRoot,
  });
  if (patched.code !== 0) {
    throw new DesktopSessionBuildError("session-patch-failed", `patch ${entry.id} failed`, {
      stdout: patched.stdout,
      stderr: patched.stderr,
    });
  }
  const afterSha256 = await sha256File(targetPath);
  if (afterSha256 !== entry.afterSha256) {
    throw new DesktopSessionBuildError(
      "session-patch-output-mismatch",
      `patch ${entry.id} output differs from the pinned after hash`,
      { expected: entry.afterSha256, actual: afterSha256 },
    );
  }
  const captureOwner = await readFile(targetPath, "utf8");
  if (captureOwner.includes('authority.request(@"revoke"') || !captureOwner.includes('outcome.reason = "captured"')) {
    throw new DesktopSessionBuildError(
      "session-patch-verify",
      "capture_owner still auto-revokes or lost the normal capture terminal state",
    );
  }

  const sessionFiles = await copySessionSources(join(stageRoot, "src"));
  const sessionHashes = {};
  for (const name of sessionFiles) {
    sessionHashes[`session/src/${name}`] = await sha256File(join(stageRoot, "src", name));
  }
  const report = {
    stageRoot,
    productBaseline: PRODUCT_BASELINE,
    productStage: {
      r11SourceCount: product.report.r11SourceCount,
      r10SourceCount: product.report.r10SourceCount,
      verifiedCount: product.report.verifiedCount,
      patches: product.report.patches,
      sourceHashes: product.report.sourceHashes,
    },
    extraPatch: {
      id: entry.id,
      file: entry.file,
      patchPath,
      patchSha256,
      beforeSha256,
      afterSha256,
      fuzz: 0,
    },
    sessionSources: sessionFiles,
    sessionHashes,
  };
  await writeFile(join(stageRoot, "session-stage-manifest.json"), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  return {
    srcDir: join(stageRoot, "src"),
    r10SrcDir: join(stageRoot, "r10", "src"),
    report,
  };
}

export function sessionCompileArgs(toolchain, { srcDir, r10SrcDir, includeRoot, visualRoot, output }) {
  const sdk = toolchain.sdk.path;
  const sources = [
    ...SESSION_SOURCES.map((name) => join(srcDir, name)),
    ...R11_COMPILE_SOURCES.map((name) => join(srcDir, name)),
    ...R10_COMPILE_SOURCES.map((name) => join(r10SrcDir, name)),
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
    srcDir,
    "-I",
    r10SrcDir,
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
    "-lbsm",
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
    "-o",
    output,
  ];
}

// 纯逻辑/codec 测试只编译被测源，避免把 session_main 的 main() 带进测试可执行文件。
export function sessionTestCompileArgs(
  toolchain,
  { srcDir, includeRoot, visualRoot, testSource, sources, output },
) {
  const sdk = toolchain.sdk.path;
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
    "-I",
    srcDir,
    "-I",
    includeRoot,
    "-I",
    join(visualRoot, "lib"),
    ...sources.map((name) => join(srcDir, name)),
    testSource,
    "-x",
    "none",
    join(visualRoot, "lib/libcua_macos_visual_round11.a"),
    "-L",
    join(sdk, "usr/lib/swift"),
    "-Wl,-rpath,/usr/lib/swift",
    "-liconv",
    "-lbsm",
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
          throw new DesktopSessionBuildError("pin-encoding", "pin values must stay printable ASCII", {
            value,
          });
        }
        escaped += character;
    }
  }
  return escaped;
}

const ENTRY_MACROS = {
  "host-entry.mjs": "HOST",
  "cli-entry.mjs": "CLI",
  "session-entry.mjs": "SESSION",
};

const RESOURCE_MACROS = {
  "node-repl-server.mjs": "NODE_REPL_SERVER",
  "tasks-storage-worker.mjs": "TASKS_STORAGE_WORKER",
};

export function pinsHeader({ nodeSha256, entries, resources = [], identityPins }) {
  const lines = [
    "#pragma once",
    "// 由 cua-desktop-session builder 生成。身份 pin 复用已签名 R11 证书/DR/Node CDHash；",
    "// entry 资源 pin 来自本次实际 bundle bytes。builder 不签名。",
    `#define CUA_DESKTOP_SESSION_SELF_IDENTIFIER "${cString(BUNDLE_ID)}"`,
    `#define CUA_DESKTOP_SESSION_SELF_LEAF_SHA256 "${cString(identityPins.leafSha256)}"`,
    `#define CUA_DESKTOP_SESSION_SELF_DESIGNATED_REQUIREMENT "${cString(identityPins.designatedRequirement)}"`,
    `#define CUA_DESKTOP_SESSION_NODE_SHA256 "${cString(nodeSha256)}"`,
    `#define CUA_DESKTOP_SESSION_NODE_IDENTIFIER "${cString(identityPins.nodeIdentifier)}"`,
    `#define CUA_DESKTOP_SESSION_NODE_LEAF_SHA256 "${cString(identityPins.nodeLeafSha256)}"`,
    `#define CUA_DESKTOP_SESSION_NODE_DESIGNATED_REQUIREMENT "${cString(identityPins.nodeDesignatedRequirement)}"`,
    `#define CUA_DESKTOP_SESSION_NODE_CDHASH "${cString(identityPins.nodeCdhash)}"`,
  ];
  for (const entry of entries) {
    const suffix = ENTRY_MACROS[entry.name];
    if (!suffix) {
      throw new DesktopSessionBuildError("entry-name", `unsupported entry ${entry.name}`);
    }
    lines.push(
      `#define CUA_DESKTOP_SESSION_ENTRY_${suffix}_SHA256 "${cString(entry.sha256)}"`,
      `#define CUA_DESKTOP_SESSION_ENTRY_${suffix}_MAX_BYTES (${entry.maxBytes}u)`,
    );
  }
  for (const resource of resources) {
    const suffix = RESOURCE_MACROS[resource.name];
    if (!suffix) {
      throw new DesktopSessionBuildError("resource-name", `unsupported resource ${resource.name}`);
    }
    lines.push(
      `#define CUA_DESKTOP_SESSION_RESOURCE_${suffix}_SHA256 "${cString(resource.sha256)}"`,
      `#define CUA_DESKTOP_SESSION_RESOURCE_${suffix}_MAX_BYTES (${resource.maxBytes}u)`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
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
  <key>CFBundleName</key><string>Zody CUA Desktop Session</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>${FIXED_DEPLOYMENT_TARGET}</string>
</dict>
</plist>
`;
}
