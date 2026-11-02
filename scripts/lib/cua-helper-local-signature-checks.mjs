import { X509Certificate, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  commandFailureSummary,
  isCommandMissing,
  isCommandOk,
} from "./cua-helper-local-commands.mjs";
import { parseCodesignDisplay } from "./cua-helper-local-macho.mjs";
import {
  checkDesignatedRequirement,
  checkEntitlements,
} from "./cua-helper-local-requirement-checks.mjs";
import { addCheck, errorMessage } from "./cua-helper-local-utils.mjs";

function codesignDiagnosticText(result) {
  return [result.stdout, result.stderr]
    .filter((part) => typeof part === "string" && part.length > 0)
    .join("\n");
}

function checkVerification({ checks, verifyResult }) {
  if (isCommandMissing(verifyResult)) {
    addCheck(checks, "signature.verify", "blocked", "missing required command: codesign");
  } else if (!isCommandOk(verifyResult)) {
    addCheck(
      checks,
      "signature.verify",
      "fail",
      commandFailureSummary(verifyResult, "codesign --verify"),
    );
  } else {
    addCheck(checks, "signature.verify", "pass", "codesign strict verification passed");
  }
}

function checkAuthority({ checks, displayResult }) {
  if (isCommandMissing(displayResult)) {
    addCheck(checks, "signature.authority", "blocked", "missing required command: codesign");
    return;
  }
  if (!isCommandOk(displayResult)) {
    addCheck(
      checks,
      "signature.authority",
      "fail",
      commandFailureSummary(displayResult, "codesign -d"),
    );
    return;
  }
  const display = parseCodesignDisplay(codesignDiagnosticText(displayResult));
  if (display.isAdhoc) {
    addCheck(
      checks,
      "signature.authority",
      "fail",
      "ad-hoc signature is not a certificate-backed self-signed signature",
    );
  } else if (display.usableAuthorities.length === 0) {
    addCheck(checks, "signature.authority", "fail", "no usable certificate Authority was reported");
  } else {
    addCheck(
      checks,
      "signature.authority",
      "pass",
      "certificate-backed signature authority present",
      {
        authorities: display.usableAuthorities,
        teamIdentifier: display.teamIdentifier,
        teamIdentifierRequired: false,
      },
    );
  }
}

async function checkLeafCertificate({ checks, state, certResult }) {
  if (!state.tempDir) {
    addCheck(
      checks,
      "signature.leaf-certificate",
      "blocked",
      `temporary directory unavailable: ${errorMessage(state.tempDirError)}`,
    );
    return null;
  }
  if (isCommandMissing(certResult)) {
    addCheck(checks, "signature.leaf-certificate", "blocked", "missing required command: codesign");
    return null;
  }
  if (!isCommandOk(certResult)) {
    addCheck(
      checks,
      "signature.leaf-certificate",
      "fail",
      commandFailureSummary(certResult, "codesign --extract-certificates"),
    );
    return null;
  }
  try {
    const certificateFiles = (await readdir(state.tempDir))
      .filter((name) => /^cert\d+$/.test(name))
      .sort((left, right) => Number(left.slice(4)) - Number(right.slice(4)));
    if (!certificateFiles.includes("cert0")) {
      addCheck(
        checks,
        "signature.leaf-certificate",
        "fail",
        "codesign did not extract a leaf certificate",
      );
      return null;
    }
    const certificateDer = await readFile(join(state.tempDir, "cert0"));
    const leafCertificate = new X509Certificate(certificateDer);
    addCheck(
      checks,
      "signature.leaf-certificate",
      "pass",
      "leaf certificate extracted and parsed",
      {
        certificateCount: certificateFiles.length,
        subject: leafCertificate.subject,
      },
    );
    return leafCertificate;
  } catch (error) {
    addCheck(
      checks,
      "signature.leaf-certificate",
      "fail",
      `leaf certificate is unreadable: ${errorMessage(error)}`,
    );
    return null;
  }
}

function checkLeafSha256({ checks, profile, leafCertificate }) {
  if (!leafCertificate) {
    addCheck(checks, "signature.leaf-sha256", "blocked", "leaf certificate unavailable");
    return;
  }
  const actualLeafSha256 = createHash("sha256").update(leafCertificate.raw).digest("hex");
  if (!profile.leafCertificateSha256) {
    addCheck(
      checks,
      "signature.leaf-sha256",
      "blocked",
      "profile leafCertificateSha256 is not filled",
      { actualLeafSha256 },
    );
  } else if (actualLeafSha256 !== profile.leafCertificateSha256) {
    addCheck(
      checks,
      "signature.leaf-sha256",
      "fail",
      "leaf certificate SHA-256 differs from profile",
      {
        expected: profile.leafCertificateSha256,
        actual: actualLeafSha256,
      },
    );
  } else {
    addCheck(checks, "signature.leaf-sha256", "pass", "leaf certificate SHA-256 matches profile", {
      sha256: actualLeafSha256,
    });
  }
}

export async function runSignatureChecks({
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
}) {
  checkVerification({ checks, verifyResult });
  checkAuthority({ checks, displayResult });
  const leafCertificate = await checkLeafCertificate({ checks, state, certResult });
  checkLeafSha256({ checks, profile, leafCertificate });
  await checkDesignatedRequirement({
    checks,
    adapter,
    appPath,
    profile,
    drDisplayResult,
    leafCertificate,
  });
  await checkEntitlements({ checks, adapter, state, profile, entitlementsResult });
}
