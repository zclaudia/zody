import { constants as fsConstants } from "node:fs";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBinaryChecks } from "./cua-helper-local-binary-checks.mjs";
import {
  FIXED_COMMANDS,
  commandFailureSummary,
  createExecFileCommandAdapter,
  isCommandMissing,
  isCommandOk,
  runFixedCommand,
} from "./cua-helper-local-commands.mjs";
import {
  MAX_PROFILE_TEXT_BYTES,
  parseProfileText,
  validateProfile,
} from "./cua-helper-local-profile.mjs";
import { runSignatureChecks } from "./cua-helper-local-signature-checks.mjs";
import {
  addCheck,
  blockedForMissing,
  errorMessage,
  hashFile,
  isPathInside,
  isSafeAbsolutePath,
  isSafeExecutableName,
  parseJsonObject,
  readText,
  safeRealpath,
  statSafe,
} from "./cua-helper-local-utils.mjs";

export const DOCTOR_SCHEMA_VERSION = 1;
export const DOCTOR_KIND = "macos-cua-helper-local-doctor";

export async function executeChecks(state, options) {
  const { checks } = state;
  const platform = options.platform ?? process.platform;
  const adapter = options.adapter ?? createExecFileCommandAdapter();
  const appInput = options.appPath;
  const profileInput = options.profilePath;
  state.appPath = appInput;
  state.profilePath = profileInput;

  if (platform !== "darwin") {
    addCheck(
      checks,
      "platform.macos",
      "blocked",
      `requires macOS; current platform is ${platform}`,
    );
    return;
  }
  addCheck(checks, "platform.macos", "pass", "running on macOS");

  if (!isSafeAbsolutePath(appInput) || !isSafeAbsolutePath(profileInput)) {
    addCheck(
      checks,
      "input.arguments",
      "fail",
      "--app and --profile must be non-empty absolute paths without NUL",
    );
    return;
  }
  const appPath = resolve(appInput);
  const profilePath = resolve(profileInput);
  state.appPath = appPath;
  state.profilePath = profilePath;
  addCheck(checks, "input.arguments", "pass", "absolute app and profile paths");

  const profileStat = await statSafe(profilePath);
  if (!profileStat.ok || !profileStat.stats.isFile()) {
    addCheck(checks, "profile.file", "blocked", "profile is missing or unreadable");
    return;
  }
  if (profileStat.stats.size > MAX_PROFILE_TEXT_BYTES) {
    addCheck(checks, "profile.file", "fail", `profile exceeds ${MAX_PROFILE_TEXT_BYTES} bytes`);
    return;
  }
  const profileText = await readText(profilePath);
  if (!profileText.ok) {
    addCheck(
      checks,
      "profile.file",
      "blocked",
      `profile is not readable: ${errorMessage(profileText.error)}`,
    );
    return;
  }
  addCheck(checks, "profile.file", "pass", "profile is readable");

  const parsedProfile = parseProfileText(profileText.text);
  if (!parsedProfile.ok) {
    addCheck(checks, "profile.schema", "fail", parsedProfile.error);
    return;
  }
  const validation = validateProfile(parsedProfile.value);
  if (validation.errors.length > 0) {
    addCheck(checks, "profile.schema", "fail", "profile schema validation failed", {
      errors: validation.errors,
    });
    return;
  }
  addCheck(checks, "profile.schema", "pass", "profile schema is valid");
  const profile = validation.profile;

  if (validation.emptyFields.length > 0) {
    addCheck(
      checks,
      "profile.required-values",
      "blocked",
      "profile contains unfilled required values",
      {
        fields: validation.emptyFields,
      },
    );
  } else {
    addCheck(checks, "profile.required-values", "pass", "all required profile values are filled");
  }

  const identityPending = [];
  if (!profile.bundleId) {
    identityPending.push("bundleId");
  }
  if (!profile.designatedRequirement) {
    identityPending.push("designatedRequirement");
  }
  if (validation.policyErrors.length > 0) {
    addCheck(
      checks,
      "profile.identity-policy",
      "fail",
      "profile identity policy is not satisfied",
      {
        errors: validation.policyErrors,
      },
    );
  } else if (identityPending.length > 0) {
    addCheck(
      checks,
      "profile.identity-policy",
      "blocked",
      "identity policy needs filled profile values",
      {
        fields: identityPending,
      },
    );
  } else {
    addCheck(checks, "profile.identity-policy", "pass", "profile identity policy is satisfied");
  }

  const appStat = await statSafe(appPath);
  if (!appStat.ok || !appStat.stats.isDirectory()) {
    addCheck(checks, "app.bundle", "blocked", "app bundle directory is missing or unreadable");
    return;
  }
  const appRealPath = await safeRealpath(appPath);
  if (!appRealPath.ok) {
    addCheck(
      checks,
      "app.bundle",
      "blocked",
      `cannot resolve app bundle: ${errorMessage(appRealPath.error)}`,
    );
    return;
  }
  addCheck(checks, "app.bundle", "pass", "app bundle directory exists");

  const infoPath = join(appPath, "Contents", "Info.plist");
  const infoStat = await statSafe(infoPath);
  if (!infoStat.ok || !infoStat.stats.isFile()) {
    addCheck(checks, "app.info-plist", "blocked", "Contents/Info.plist is missing or unreadable");
    return;
  }
  const infoRealPath = await safeRealpath(infoPath);
  if (!infoRealPath.ok) {
    addCheck(
      checks,
      "app.info-plist",
      "blocked",
      `cannot resolve Info.plist: ${errorMessage(infoRealPath.error)}`,
    );
    return;
  }
  if (!isPathInside(appRealPath.path, infoRealPath.path)) {
    addCheck(checks, "app.info-plist", "fail", "Info.plist resolves outside the app bundle");
    return;
  }
  const infoResult = await runFixedCommand(adapter, FIXED_COMMANDS.plutil, [
    "-convert",
    "json",
    "-o",
    "-",
    "--",
    infoRealPath.path,
  ]);
  if (isCommandMissing(infoResult)) {
    addCheck(
      checks,
      "app.info-plist",
      "blocked",
      blockedForMissing(infoResult, FIXED_COMMANDS.plutil),
    );
    return;
  }
  if (!isCommandOk(infoResult)) {
    addCheck(
      checks,
      "app.info-plist",
      "fail",
      commandFailureSummary(infoResult, FIXED_COMMANDS.plutil),
    );
    return;
  }
  const info = parseJsonObject(infoResult.stdout);
  if (!info.ok) {
    addCheck(checks, "app.info-plist", "fail", `Info.plist JSON is invalid: ${info.error}`);
    return;
  }
  addCheck(checks, "app.info-plist", "pass", "Info.plist parsed");

  const actualBundleId =
    typeof info.value.CFBundleIdentifier === "string" ? info.value.CFBundleIdentifier : null;
  const actualExecutableName =
    typeof info.value.CFBundleExecutable === "string" ? info.value.CFBundleExecutable : null;
  const actualShortVersion =
    typeof info.value.CFBundleShortVersionString === "string"
      ? info.value.CFBundleShortVersionString
      : null;
  const actualBundleVersion =
    typeof info.value.CFBundleVersion === "string" ? info.value.CFBundleVersion : null;

  const identityPendingFields = [];
  const identityMismatches = [];
  const compareIdentity = (field, expected, actual) => {
    if (!expected) {
      identityPendingFields.push(field);
      return;
    }
    if (actual !== expected) {
      identityMismatches.push({ field, expected, actual });
    }
  };
  compareIdentity("bundleId", profile.bundleId, actualBundleId);
  compareIdentity("executableName", profile.executableName, actualExecutableName);
  compareIdentity("bundleShortVersion", profile.bundleShortVersion, actualShortVersion);
  compareIdentity("bundleVersion", profile.bundleVersion, actualBundleVersion);
  if (identityMismatches.length > 0) {
    addCheck(checks, "app.bundle-identity", "fail", "Info.plist identity differs from profile", {
      mismatches: identityMismatches,
    });
  } else if (identityPendingFields.length > 0) {
    addCheck(
      checks,
      "app.bundle-identity",
      "blocked",
      "Info.plist identity cannot be fully compared",
      {
        fields: identityPendingFields,
      },
    );
  } else {
    addCheck(checks, "app.bundle-identity", "pass", "Info.plist identity matches profile");
  }

  const executableName = actualExecutableName ?? profile.executableName;
  if (!isSafeExecutableName(executableName)) {
    addCheck(
      checks,
      "app.executable",
      "fail",
      "CFBundleExecutable must be a single path component",
    );
    return;
  }
  const executablePath = join(appPath, "Contents", "MacOS", executableName);
  const executableStat = await statSafe(executablePath);
  if (!executableStat.ok || !executableStat.stats.isFile()) {
    addCheck(
      checks,
      "app.executable",
      "blocked",
      `executable is missing: Contents/MacOS/${executableName}`,
    );
    return;
  }
  const executableRealPath = await safeRealpath(executablePath);
  if (!executableRealPath.ok) {
    addCheck(
      checks,
      "app.executable",
      "blocked",
      `cannot resolve executable: ${errorMessage(executableRealPath.error)}`,
    );
    return;
  }
  if (!isPathInside(appRealPath.path, executableRealPath.path)) {
    addCheck(checks, "app.executable", "fail", "executable resolves outside the app bundle");
    return;
  }
  const resolvedExecutableStat = await statSafe(executableRealPath.path);
  if (!resolvedExecutableStat.ok || !resolvedExecutableStat.stats.isFile()) {
    addCheck(checks, "app.executable", "blocked", "resolved executable is missing or not a file");
    return;
  }
  try {
    await access(executableRealPath.path, fsConstants.X_OK);
  } catch (error) {
    addCheck(
      checks,
      "app.executable",
      "fail",
      `executable is not executable: ${errorMessage(error)}`,
    );
    return;
  }
  addCheck(checks, "app.executable", "pass", "executable exists inside the app bundle");

  try {
    state.tempDir = await mkdtemp(join(tmpdir(), "zody-cua-helper-local-doctor-"));
  } catch (error) {
    state.tempDir = null;
    state.tempDirError = error;
  }

  const certPrefix = state.tempDir ? join(state.tempDir, "cert") : null;
  const [
    verifyResult,
    displayResult,
    drDisplayResult,
    entitlementsResult,
    lipoResult,
    otoolResult,
    executableHash,
    certResult,
  ] = await Promise.all([
    runFixedCommand(adapter, FIXED_COMMANDS.codesign, [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      appPath,
    ]),
    runFixedCommand(adapter, FIXED_COMMANDS.codesign, ["-d", "--verbose=4", appPath]),
    runFixedCommand(adapter, FIXED_COMMANDS.codesign, ["-d", "-r-", appPath]),
    runFixedCommand(adapter, FIXED_COMMANDS.codesign, [
      "-d",
      "--entitlements",
      "-",
      "--xml",
      appPath,
    ]),
    runFixedCommand(adapter, FIXED_COMMANDS.lipo, ["-archs", executableRealPath.path]),
    runFixedCommand(adapter, FIXED_COMMANDS.otool, ["-arch", "all", "-l", executableRealPath.path]),
    hashFile(executableRealPath.path),
    certPrefix
      ? runFixedCommand(adapter, FIXED_COMMANDS.codesign, [
          "-d",
          `--extract-certificates=${certPrefix}`,
          appPath,
        ])
      : Promise.resolve({ status: "blocked", message: "temporary directory unavailable" }),
  ]);

  await runSignatureChecks({
    checks,
    adapter,
    appPath,
    profile,
    state,
    verifyResult,
    displayResult,
    drDisplayResult,
    entitlementsResult,
    certResult,
  });
  runBinaryChecks({
    checks,
    profile,
    lipoResult,
    otoolResult,
    executableHash,
  });
}
