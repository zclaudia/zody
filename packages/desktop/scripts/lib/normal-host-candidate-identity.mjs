// Independent normal Host candidate UI identity. Helper/Node bundle identities remain
// untouched by this rewrite.
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { NarrowResourceError } from "../macos-cua-narrow-resources-base.mjs";
import { renameElectronHelperBundles } from "./cua-desktop-candidate-app-files.mjs";

export const NORMAL_HOST_CANDIDATE_APP_BUNDLE_NAME = "Zody CUA Normal Host Candidate.app";
export const NORMAL_HOST_CANDIDATE_DISPLAY_NAME = "Zody CUA Normal Host Candidate";
export const NORMAL_HOST_CANDIDATE_BUNDLE_ID = "io.github.zclaudia.zody.cua-normal-host-candidate";
export const NORMAL_HOST_CANDIDATE_PACKAGE_NAME = "zody-cua-normal-host-candidate";
export const NORMAL_HOST_CANDIDATE_RELEASE_FLAGS = Object.freeze({
  productDefaultDisabled: true,
  zcodeCuaPlaceholder: true,
  explicitCandidateOptIn: true,
});

const execFileAsync = promisify(execFile);

async function runPlutilCommand(file, args) {
  await execFileAsync(file, args);
}

export async function rewriteNormalHostCandidateAppIdentity({
  infoPlistPath,
  packageJsonPath,
  frameworksDir,
  sourceApplicationName,
  runPlutil = runPlutilCommand,
  renameHelpers = renameElectronHelperBundles,
}) {
  if (!isAbsolute(infoPlistPath) || !isAbsolute(packageJsonPath) || !isAbsolute(frameworksDir)) {
    throw new NarrowResourceError(
      "normal-host-identity-path",
      "candidate Info.plist, package.json, and Frameworks paths must be absolute",
    );
  }
  if (
    typeof sourceApplicationName !== "string" ||
    !sourceApplicationName.trim() ||
    /[/:]/.test(sourceApplicationName)
  ) {
    throw new NarrowResourceError(
      "normal-host-identity-helper-source",
      "candidate source application name is required for Chromium Helper renaming",
    );
  }
  for (const [key, value] of [
    ["CFBundleIdentifier", NORMAL_HOST_CANDIDATE_BUNDLE_ID],
    ["CFBundleName", NORMAL_HOST_CANDIDATE_DISPLAY_NAME],
    ["CFBundleDisplayName", NORMAL_HOST_CANDIDATE_DISPLAY_NAME],
  ]) {
    await runPlutil("/usr/bin/plutil", ["-replace", key, "-string", value, infoPlistPath]);
  }
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  packageJson.name = NORMAL_HOST_CANDIDATE_PACKAGE_NAME;
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, { mode: 0o600 });
  // 修复依据：Electron 41 的 GetHelperAppPath 先尝试固定 Electron Helper，再按父 app
  // 的应用名寻找 "<name> Helper"；正式 shell 的四个 Chromium Helper 必须与候选父名一致。
  // 该步骤只重命名既有 helper bundle/executable/plist，不创建进程或 wrapper。
  const chromiumHelpers = await renameHelpers(frameworksDir, NORMAL_HOST_CANDIDATE_DISPLAY_NAME, {
    sourceApplicationName,
  });
  return {
    appBundleName: NORMAL_HOST_CANDIDATE_APP_BUNDLE_NAME,
    displayName: NORMAL_HOST_CANDIDATE_DISPLAY_NAME,
    bundleIdentifier: NORMAL_HOST_CANDIDATE_BUNDLE_ID,
    packageName: NORMAL_HOST_CANDIDATE_PACKAGE_NAME,
    chromiumHelpers,
  };
}
