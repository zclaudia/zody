import {
  commandFailureSummary,
  isCommandMissing,
  isCommandOk,
} from "./cua-helper-local-commands.mjs";
import {
  parseLipoArchitectures,
  parseOtoolMinimumMacOs,
  versionsEqual,
} from "./cua-helper-local-macho.mjs";
import { addCheck, errorMessage } from "./cua-helper-local-utils.mjs";

export function checkArchitectures({ checks, profile, lipoResult }) {
  if (isCommandMissing(lipoResult)) {
    addCheck(checks, "binary.architectures", "blocked", "missing required command: lipo");
    return null;
  }
  if (!isCommandOk(lipoResult)) {
    addCheck(checks, "binary.architectures", "fail", commandFailureSummary(lipoResult, "lipo"));
    return null;
  }
  const parsedLipo = parseLipoArchitectures(lipoResult.stdout);
  if (parsedLipo.error) {
    addCheck(checks, "binary.architectures", "fail", parsedLipo.error);
    return null;
  }
  const actualArchitectures = parsedLipo.architectures;
  const expectedArchitectures = [...profile.architectures].sort();
  if (expectedArchitectures.length === 0) {
    addCheck(checks, "binary.architectures", "blocked", "profile architectures are not filled", {
      actualArchitectures,
    });
  } else if (
    expectedArchitectures.length !== actualArchitectures.length ||
    expectedArchitectures.some((architecture, index) => architecture !== actualArchitectures[index])
  ) {
    addCheck(checks, "binary.architectures", "fail", "architecture set differs from profile", {
      expected: expectedArchitectures,
      actual: actualArchitectures,
    });
  } else {
    addCheck(checks, "binary.architectures", "pass", "architecture set matches profile", {
      architectures: actualArchitectures,
    });
  }
  return actualArchitectures;
}

export function checkMinimumMacOs({ checks, profile, otoolResult, actualArchitectures }) {
  if (isCommandMissing(otoolResult)) {
    addCheck(checks, "binary.minimum-macos", "blocked", "missing required command: otool");
    return;
  }
  if (!isCommandOk(otoolResult)) {
    addCheck(checks, "binary.minimum-macos", "fail", commandFailureSummary(otoolResult, "otool"));
    return;
  }
  const fallbackArchitectures = actualArchitectures ?? profile.architectures;
  const parsedOtool = parseOtoolMinimumMacOs(otoolResult.stdout, fallbackArchitectures);
  if (parsedOtool.errors.length > 0) {
    addCheck(checks, "binary.minimum-macos", "fail", "cannot parse otool minimum macOS versions", {
      errors: parsedOtool.errors,
    });
    return;
  }
  if (!profile.minimumMacOSVersion) {
    addCheck(
      checks,
      "binary.minimum-macos",
      "blocked",
      "profile minimumMacOSVersion is not filled",
      {
        actual: parsedOtool.byArchitecture,
      },
    );
    return;
  }
  const mismatches = [];
  for (const architecture of profile.architectures) {
    const actual = parsedOtool.byArchitecture[architecture];
    if (!actual) {
      mismatches.push({ architecture, expected: profile.minimumMacOSVersion, actual: null });
    } else if (!versionsEqual(actual.minimumMacOSVersion, profile.minimumMacOSVersion)) {
      mismatches.push({
        architecture,
        expected: profile.minimumMacOSVersion,
        actual: actual.minimumMacOSVersion,
      });
    }
  }
  if (mismatches.length > 0) {
    addCheck(checks, "binary.minimum-macos", "fail", "minimum macOS version differs from profile", {
      mismatches,
    });
  } else {
    addCheck(checks, "binary.minimum-macos", "pass", "minimum macOS version matches profile", {
      actual: parsedOtool.byArchitecture,
    });
  }
}

export function checkExecutableSha256({ checks, profile, executableHash }) {
  if (!executableHash.ok) {
    addCheck(
      checks,
      "binary.executable-sha256",
      "blocked",
      `executable is unreadable: ${errorMessage(executableHash.error)}`,
    );
  } else if (!profile.executableSha256) {
    addCheck(
      checks,
      "binary.executable-sha256",
      "blocked",
      "profile executableSha256 is not filled",
      {
        actualExecutableSha256: executableHash.sha256,
      },
    );
  } else if (executableHash.sha256 !== profile.executableSha256) {
    addCheck(
      checks,
      "binary.executable-sha256",
      "fail",
      "executable SHA-256 differs from profile",
      {
        expected: profile.executableSha256,
        actual: executableHash.sha256,
      },
    );
  } else {
    addCheck(checks, "binary.executable-sha256", "pass", "executable SHA-256 matches profile", {
      sha256: executableHash.sha256,
    });
  }
}

export function runBinaryChecks({ checks, profile, lipoResult, otoolResult, executableHash }) {
  const actualArchitectures = checkArchitectures({ checks, profile, lipoResult });
  checkMinimumMacOs({ checks, profile, otoolResult, actualArchitectures });
  checkExecutableSha256({ checks, profile, executableHash });
}
