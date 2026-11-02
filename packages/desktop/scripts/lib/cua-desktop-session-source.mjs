// 只读冻结 R11/product-wiring 源，在 output stage 派生 desktop-session 候选。
// 三个既有 patch 由 product baseline 固定；capture_owner 只追加“正常截图不自动 revoke”。
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  NATIVE_ROOT,
  PRODUCT_BASELINE,
  SESSION_BASELINE,
} from "./cua-desktop-session-config.mjs";
import {
  loadIdentityPins,
  prepareSourceStage,
} from "./cua-helper-product-wiring-native.mjs";
import { sha256File } from "./cua-desktop-session-toolchain.mjs";
import {
  applySequentialPatches,
  copyPinnedStopHeaders,
  verifyCaptureOwnerStage,
} from "./cua-desktop-session-patch.mjs";

export { loadIdentityPins };
export {
  applySequentialPatches,
  copyPinnedStopHeaders,
  verifyCaptureOwnerStage,
} from "./cua-desktop-session-patch.mjs";
export {
  sessionCompileArgs,
  sessionTestCompileArgs,
} from "./cua-desktop-session-compile-args.mjs";
export { appInfoPlist, pinsHeader } from "./cua-desktop-session-pins.mjs";

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

export async function prepareSessionSourceStage({
  stageRoot,
  r11Root,
  r10Root,
}) {
  const product = await prepareSourceStage({
    stageRoot,
    r11Root,
    r10Root,
    baselinePath: PRODUCT_BASELINE,
  });
  const baseline = JSON.parse(await readFile(SESSION_BASELINE, "utf8"));
  const headers = await copyPinnedStopHeaders(
    stageRoot,
    baseline,
    SESSION_BASELINE,
  );
  const patches = Array.isArray(baseline.patches) ? baseline.patches : [];
  const { extraPatch, extraPatches } = await applySequentialPatches({
    stageRoot,
    baselinePath: SESSION_BASELINE,
    entries: patches,
  });
  await verifyCaptureOwnerStage(stageRoot);

  const sessionFiles = await copySessionSources(join(stageRoot, "src"));
  const sessionHashes = {};
  for (const name of sessionFiles) {
    sessionHashes[`session/src/${name}`] = await sha256File(
      join(stageRoot, "src", name),
    );
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
    extraPatch,
    extraPatches,
    headers,
    sessionSources: sessionFiles,
    sessionHashes,
  };
  await writeFile(
    join(stageRoot, "session-stage-manifest.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  return {
    srcDir: join(stageRoot, "src"),
    r10SrcDir: join(stageRoot, "r10", "src"),
    report,
  };
}
