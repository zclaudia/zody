import {
  DEPLOYMENT_TARGET,
  DiagnosticVerificationError,
  PRODUCT,
  TARGET,
} from "./cua-helper-diagnostic-core.mjs";
import { runCommand } from "./cua-helper-diagnostic-command.mjs";
import { posix } from "node:path";

const TOOL_TIMEOUT_MS = 15_000;

function identityValue(output, key) {
  return new RegExp(`^${key}=(.+)$`, "m").exec(output)?.[1]?.trim() ?? null;
}

export async function probeSignature(path, env) {
  const verify = await runCommand("codesign", ["--verify", "--strict", "--verbose=2", path], {
    env,
    timeoutMs: TOOL_TIMEOUT_MS,
    allowFailure: true,
    maxOutputBytes: 128 * 1024,
  });
  const display = await runCommand("codesign", ["--display", "--verbose=4", path], {
    env,
    timeoutMs: TOOL_TIMEOUT_MS,
    allowFailure: true,
    maxOutputBytes: 128 * 1024,
  });
  const output = `${display.stdout}\n${display.stderr}`;
  const authorities = [...output.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1].trim());
  let kind = "unsigned";
  if (/^Signature=adhoc$/m.test(output)) kind = "adhoc";
  else if (authorities.length > 0) kind = "authority";
  else if (verify.code === 0) kind = "signed-unknown";
  return {
    kind,
    verified: verify.code === 0,
    identifier: identityValue(output, "Identifier"),
    teamIdentifier: identityValue(output, "TeamIdentifier"),
    cdhash: identityValue(output, "CDHash"),
    authorities,
  };
}

export async function inspectArchitectures(binaryPath, env) {
  const result = await runCommand("lipo", ["-archs", binaryPath], {
    env,
    timeoutMs: TOOL_TIMEOUT_MS,
    maxOutputBytes: 16 * 1024,
  });
  return result.stdout.trim().split(/\s+/).filter(Boolean);
}

export async function inspectMachO(binaryPath, env) {
  const buildVersion = await runCommand("otool", ["-l", binaryPath], {
    env,
    timeoutMs: TOOL_TIMEOUT_MS,
    maxOutputBytes: 2 * 1024 * 1024,
  });
  const dependencies = await runCommand("otool", ["-L", binaryPath], {
    env,
    timeoutMs: TOOL_TIMEOUT_MS,
    maxOutputBytes: 128 * 1024,
  });
  const minosValues = [...buildVersion.stdout.matchAll(/^\s*minos\s+([0-9.]+)\s*$/gm)].map(
    (match) => match[1],
  );
  const architectures = await inspectArchitectures(binaryPath, env);
  const linkedDynamicLibraries = parseLinkedDependencies(dependencies.stdout);
  if (minosValues.length !== 1) {
    throw new DiagnosticVerificationError("Mach-O must contain exactly one minos fact");
  }
  return {
    architectures,
    minimumMacOS: minosValues[0],
    linkedDynamicLibraries,
  };
}

export async function readInfoPlist(infoPath, env) {
  const result = await runCommand("plutil", ["-convert", "json", "-o", "-", infoPath], {
    env,
    timeoutMs: TOOL_TIMEOUT_MS,
    maxOutputBytes: 128 * 1024,
  });
  let info;
  try {
    info = JSON.parse(result.stdout);
  } catch {
    throw new DiagnosticVerificationError("Info.plist is not valid JSON after conversion");
  }
  if (info === null || typeof info !== "object" || Array.isArray(info)) {
    throw new DiagnosticVerificationError("Info.plist root is invalid");
  }
  return info;
}

export function assertBundleInfo(info) {
  const expected = {
    CFBundleIdentifier: PRODUCT.bundleId,
    CFBundleName: PRODUCT.name,
    CFBundleDisplayName: PRODUCT.name,
    CFBundleExecutable: PRODUCT.name,
    CFBundleShortVersionString: PRODUCT.shortVersion,
    CFBundleVersion: PRODUCT.bundleVersion,
    LSMinimumSystemVersion: PRODUCT.minimumMacOSVersion,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (info[key] !== value) {
      throw new DiagnosticVerificationError(`Info.plist ${key} does not match the contract`);
    }
  }
  if (info.CFBundlePackageType !== "APPL") {
    throw new DiagnosticVerificationError("Info.plist package type is not APPL");
  }
}

export function assertMachOFacts({ architectures, minimumMacOS, linkedDynamicLibraries }) {
  if (
    architectures.length !== 1 ||
    architectures[0] !== "arm64" ||
    TARGET !== "aarch64-apple-darwin"
  ) {
    throw new DiagnosticVerificationError("Mach-O architecture is not arm64");
  }
  if (minimumMacOS !== DEPLOYMENT_TARGET) {
    throw new DiagnosticVerificationError("Mach-O minos does not match the build target");
  }
  if (
    linkedDynamicLibraries.length === 0 ||
    linkedDynamicLibraries.some((entry) => {
      if (!entry.startsWith("/")) return true;
      const normalized = posix.normalize(entry);
      return !normalized.startsWith("/usr/lib/") && !normalized.startsWith("/System/Library/");
    })
  ) {
    throw new DiagnosticVerificationError("Mach-O links a non-system dynamic library");
  }
}

export function parseCargoTree(output) {
  const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const dependencies = lines.filter((line) => /[├└│]──/.test(line));
  if (dependencies.length !== 0) {
    throw new DiagnosticVerificationError("diagnostic crate has unexpected Cargo dependencies");
  }
  return lines;
}

export function parseLinkedDependencies(output) {
  return output
    .split(/\r?\n/)
    .map((line) => /^\s+(.+?)\s+\(compatibility version .+\)$/.exec(line)?.[1]?.trim() ?? null)
    .filter(Boolean);
}
