import { stat } from "node:fs/promises";
import {
  FIXED_DEPLOYMENT_TARGET,
  FIXED_SDK,
  FIXED_SDK_VERSION,
  PeerDiagnosticBlockedError,
  summarizeCommand,
} from "./cua-peer-diagnostic-core.mjs";
import { runBoundedCommand } from "./cua-peer-diagnostic-command.mjs";

const XCRUN = "/usr/bin/xcrun";

async function runXcrun(args, label) {
  const result = await runBoundedCommand(XCRUN, args, { timeoutMs: 30_000 });
  if (result.timedOut || result.error || result.exitCode !== 0) {
    throw new PeerDiagnosticBlockedError(
      "sdk-unavailable",
      `${label} failed: ${(result.stderr || result.stdout || result.error || "unknown").trim()}`,
      { command: summarizeCommand(XCRUN, args) },
    );
  }
  return result.stdout.trim();
}

export async function probeFixedToolchain() {
  const sdkPath = await runXcrun(["--sdk", FIXED_SDK, "--show-sdk-path"], "SDK path probe");
  const sdkVersion = await runXcrun(
    ["--sdk", FIXED_SDK, "--show-sdk-version"],
    "SDK version probe",
  );
  if (sdkVersion !== FIXED_SDK_VERSION) {
    throw new PeerDiagnosticBlockedError(
      "sdk-version-mismatch",
      `expected SDK ${FIXED_SDK} version ${FIXED_SDK_VERSION}, got ${sdkVersion}`,
    );
  }
  let sdkInfo;
  try {
    sdkInfo = await stat(sdkPath);
  } catch (error) {
    throw new PeerDiagnosticBlockedError(
      "sdk-unavailable",
      `SDK path is unavailable: ${error.message}`,
    );
  }
  if (!sdkInfo.isDirectory()) {
    throw new PeerDiagnosticBlockedError("sdk-unavailable", "SDK path is not a directory");
  }

  const compilerPath = await runXcrun(["--sdk", FIXED_SDK, "--find", "clang++"], "clang++ probe");
  if (!compilerPath.startsWith("/")) {
    throw new PeerDiagnosticBlockedError(
      "toolchain-unavailable",
      `xcrun returned a non-absolute compiler path: ${compilerPath}`,
    );
  }
  const compilerInfo = await runBoundedCommand(compilerPath, ["--version"], {
    timeoutMs: 30_000,
  });
  if (compilerInfo.exitCode !== 0 || compilerInfo.timedOut) {
    throw new PeerDiagnosticBlockedError("toolchain-unavailable", "clang++ --version failed");
  }
  const versionFirstLine = compilerInfo.stdout.split("\n")[0]?.trim() ?? "";
  if (!versionFirstLine.includes("Apple clang version")) {
    throw new PeerDiagnosticBlockedError(
      "toolchain-unavailable",
      `unexpected clang++ version: ${versionFirstLine}`,
    );
  }

  return {
    sdk: {
      requested: FIXED_SDK,
      path: sdkPath,
      version: sdkVersion,
    },
    compiler: {
      path: compilerPath,
      versionFirstLine,
    },
    target: {
      architecture: "arm64",
      minimumMacOSVersion: FIXED_DEPLOYMENT_TARGET,
    },
    commands: {
      sdkPath: summarizeCommand(XCRUN, ["--sdk", FIXED_SDK, "--show-sdk-path"]),
      sdkVersion: summarizeCommand(XCRUN, ["--sdk", FIXED_SDK, "--show-sdk-version"]),
      compiler: summarizeCommand(XCRUN, ["--sdk", FIXED_SDK, "--find", "clang++"]),
    },
  };
}
