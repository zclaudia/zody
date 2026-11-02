import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FIXED_COMMANDS,
  commandFailureSummary,
  isCommandMissing,
  isCommandOk,
  runFixedCommand,
} from "./cua-helper-local-commands.mjs";
import { entitlementsEqual, parseDesignatedRequirement } from "./cua-helper-local-macho.mjs";
import {
  findForbiddenEntitlementKeys,
  parseDesignatedRequirementPolicy,
} from "./cua-helper-local-profile.mjs";
import { addCheck, errorMessage, parseJsonObject } from "./cua-helper-local-utils.mjs";

function codesignDiagnosticText(result) {
  return [result.stdout, result.stderr]
    .filter((part) => typeof part === "string" && part.length > 0)
    .join("\n");
}

function failDesignatedRequirement(checks, message, details) {
  addCheck(checks, "signature.designated-requirement", "fail", message, details);
}

export async function checkDesignatedRequirement({
  checks,
  adapter,
  appPath,
  profile,
  drDisplayResult,
  leafCertificate,
}) {
  if (isCommandMissing(drDisplayResult)) {
    addCheck(
      checks,
      "signature.designated-requirement",
      "blocked",
      "missing required command: codesign",
    );
    return;
  }
  if (!isCommandOk(drDisplayResult)) {
    failDesignatedRequirement(checks, commandFailureSummary(drDisplayResult, "codesign -d -r-"));
    return;
  }
  const actualDesignatedRequirement = parseDesignatedRequirement(
    codesignDiagnosticText(drDisplayResult),
  );
  if (!actualDesignatedRequirement) {
    failDesignatedRequirement(checks, "codesign did not report an embedded designated requirement");
    return;
  }
  if (!profile.designatedRequirement) {
    addCheck(
      checks,
      "signature.designated-requirement",
      "blocked",
      "profile designatedRequirement is not filled",
      { actualDesignatedRequirement },
    );
    return;
  }

  const profilePolicy = parseDesignatedRequirementPolicy(
    profile.designatedRequirement,
    profile.bundleId,
  );
  if (!profilePolicy.ok) {
    failDesignatedRequirement(
      checks,
      "profile designated requirement is not the supported narrow form",
      { error: profilePolicy.error, actualDesignatedRequirement },
    );
    return;
  }
  const actualPolicy = parseDesignatedRequirementPolicy(
    actualDesignatedRequirement,
    profile.bundleId,
  );
  if (!actualPolicy.ok) {
    failDesignatedRequirement(
      checks,
      "embedded designated requirement is not the supported narrow form",
      { error: actualPolicy.error, actualDesignatedRequirement },
    );
    return;
  }
  if (actualPolicy.identifier !== profilePolicy.identifier) {
    failDesignatedRequirement(
      checks,
      "embedded designated requirement identifier differs from profile",
      {
        expectedIdentifier: profilePolicy.identifier,
        actualIdentifier: actualPolicy.identifier,
      },
    );
    return;
  }
  if (actualPolicy.certificateSha1 !== profilePolicy.certificateSha1) {
    failDesignatedRequirement(
      checks,
      "embedded designated requirement leaf SHA-1 differs from profile",
      {
        expectedCertificateSha1: profilePolicy.certificateSha1,
        actualCertificateSha1: actualPolicy.certificateSha1,
      },
    );
    return;
  }
  if (!leafCertificate) {
    addCheck(
      checks,
      "signature.designated-requirement",
      "blocked",
      "leaf certificate is unavailable for embedded DR cross-check",
      { actualDesignatedRequirement },
    );
    return;
  }
  const actualLeafSha1 = createHash("sha1").update(leafCertificate.raw).digest("hex");
  if (actualLeafSha1 !== actualPolicy.certificateSha1) {
    failDesignatedRequirement(
      checks,
      "embedded designated requirement leaf SHA-1 differs from the extracted leaf",
      {
        expectedCertificateSha1: actualPolicy.certificateSha1,
        actualCertificateSha1: actualLeafSha1,
      },
    );
    return;
  }
  const drVerifyResult = await runFixedCommand(adapter, FIXED_COMMANDS.codesign, [
    "--verify",
    "--strict",
    `-R=${profile.designatedRequirement}`,
    appPath,
  ]);
  if (isCommandMissing(drVerifyResult)) {
    addCheck(
      checks,
      "signature.designated-requirement",
      "blocked",
      "missing required command: codesign",
    );
  } else if (!isCommandOk(drVerifyResult)) {
    addCheck(
      checks,
      "signature.designated-requirement",
      "fail",
      commandFailureSummary(drVerifyResult, "codesign -R="),
    );
  } else {
    addCheck(
      checks,
      "signature.designated-requirement",
      "pass",
      "embedded and profile designated requirements pin the same certificate leaf",
      {
        actualDesignatedRequirement,
        profileDesignatedRequirement: profile.designatedRequirement,
        certificateSha1: actualLeafSha1,
      },
    );
  }
}

async function resolveEntitlements({ checks, adapter, state, entitlementsResult }) {
  if (isCommandMissing(entitlementsResult)) {
    addCheck(checks, "signature.entitlements", "blocked", "missing required command: codesign");
    return null;
  }
  if (!isCommandOk(entitlementsResult)) {
    addCheck(
      checks,
      "signature.entitlements",
      "fail",
      commandFailureSummary(entitlementsResult, "codesign --entitlements"),
    );
    return null;
  }
  if (entitlementsResult.stdout.trim().length === 0) {
    return {};
  }
  if (!state.tempDir) {
    addCheck(checks, "signature.entitlements", "blocked", "temporary directory unavailable");
    return null;
  }
  const entitlementsPath = join(state.tempDir, "entitlements.plist");
  try {
    await writeFile(entitlementsPath, entitlementsResult.stdout, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (error) {
    addCheck(
      checks,
      "signature.entitlements",
      "fail",
      `cannot stage entitlements: ${errorMessage(error)}`,
    );
    return null;
  }
  const entitlementsJson = await runFixedCommand(adapter, FIXED_COMMANDS.plutil, [
    "-convert",
    "json",
    "-o",
    "-",
    "--",
    entitlementsPath,
  ]);
  if (isCommandMissing(entitlementsJson)) {
    addCheck(checks, "signature.entitlements", "blocked", "missing required command: plutil");
    return null;
  }
  if (!isCommandOk(entitlementsJson)) {
    addCheck(
      checks,
      "signature.entitlements",
      "fail",
      commandFailureSummary(entitlementsJson, "plutil entitlements"),
    );
    return null;
  }
  const parsedEntitlements = parseJsonObject(entitlementsJson.stdout);
  if (!parsedEntitlements.ok) {
    addCheck(
      checks,
      "signature.entitlements",
      "fail",
      `entitlements JSON is invalid: ${parsedEntitlements.error}`,
    );
    return null;
  }
  return parsedEntitlements.value;
}

export async function checkEntitlements({ checks, adapter, state, profile, entitlementsResult }) {
  const actualEntitlements = await resolveEntitlements({
    checks,
    adapter,
    state,
    entitlementsResult,
  });
  if (actualEntitlements === null) {
    addCheck(checks, "signature.entitlements-policy", "blocked", "entitlements were not evaluated");
    return;
  }
  if (entitlementsEqual(actualEntitlements, profile.entitlements)) {
    addCheck(checks, "signature.entitlements", "pass", "entitlements exactly match profile", {
      keys: Object.keys(actualEntitlements).sort(),
    });
  } else {
    addCheck(
      checks,
      "signature.entitlements",
      "fail",
      "entitlements differ from profile exact set",
      {
        expected: profile.entitlements,
        actual: actualEntitlements,
      },
    );
  }
  const forbiddenActual = findForbiddenEntitlementKeys(actualEntitlements);
  const forbiddenProfile = findForbiddenEntitlementKeys(profile.entitlements);
  if (forbiddenActual.length > 0 || forbiddenProfile.length > 0) {
    addCheck(
      checks,
      "signature.entitlements-policy",
      "fail",
      "forbidden entitlements are present",
      {
        actual: forbiddenActual,
        profile: forbiddenProfile,
      },
    );
  } else {
    addCheck(checks, "signature.entitlements-policy", "pass", "no forbidden entitlements");
  }
}
