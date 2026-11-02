import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import {
  MAX_PROFILE_TEXT_BYTES,
  parseDesignatedRequirementPolicy,
  validateProfile,
} from "../../../../scripts/lib/cua-helper-local-profile.mjs";
import {
  FIXED_ARCH,
  FIXED_DEPLOYMENT_TARGET,
  SYNTHETIC_BUNDLE_ID,
  compareVersions,
} from "./cua-peer-diagnostic-core.mjs";

export { MAX_PROFILE_TEXT_BYTES };

function deriveExpectedIdentity(profile) {
  const designation = parseDesignatedRequirementPolicy(
    profile.designatedRequirement,
    profile.bundleId,
  );
  if (!designation.ok) {
    return null;
  }
  return Object.freeze({
    identifier: profile.bundleId,
    bundleId: profile.bundleId,
    executableName: profile.executableName,
    executableSha256: profile.executableSha256,
    leafCertificateSha256: profile.leafCertificateSha256,
    certificateSha1: designation.certificateSha1,
    designatedRequirement: profile.designatedRequirement,
    architectures: [...profile.architectures],
    minimumMacOSVersion: profile.minimumMacOSVersion,
    entitlements: profile.entitlements,
  });
}

export function validateDiagnosticProfile(input) {
  const validation = validateProfile(input);
  const errors = [...validation.errors];
  const policyErrors = [...validation.policyErrors];
  const emptyFields = [...validation.emptyFields];
  const profile = validation.profile;

  if (errors.length === 0 && policyErrors.length === 0 && emptyFields.length === 0) {
    if (!profile.architectures.includes(FIXED_ARCH)) {
      errors.push(`profile architectures must include the fixed ${FIXED_ARCH} diagnostic target`);
    }
    const minimumComparison = compareVersions(profile.minimumMacOSVersion, FIXED_DEPLOYMENT_TARGET);
    if (minimumComparison !== null && minimumComparison < 0) {
      errors.push(`profile minimumMacOSVersion must be at least ${FIXED_DEPLOYMENT_TARGET}`);
    }
  }

  const expected =
    errors.length === 0 && policyErrors.length === 0 && emptyFields.length === 0
      ? deriveExpectedIdentity(profile)
      : null;
  if (!expected && errors.length === 0 && policyErrors.length === 0) {
    errors.push("profile designatedRequirement cannot be derived");
  }

  const code =
    emptyFields.length > 0
      ? "profile-incomplete"
      : errors.length > 0 || policyErrors.length > 0
        ? "profile-invalid"
        : null;

  return {
    ok: code === null,
    code,
    errors,
    policyErrors,
    emptyFields,
    profile,
    expected,
  };
}

export async function loadPinnedProfile(profilePath) {
  if (typeof profilePath !== "string" || profilePath.length === 0) {
    return {
      ok: false,
      code: "profile-missing",
      errors: ["no pinned local-self-signed profile was supplied"],
      policyErrors: [],
      emptyFields: [],
      profile: null,
      expected: null,
      profileSha256: null,
    };
  }

  let info;
  try {
    info = await lstat(profilePath);
  } catch (error) {
    return {
      ok: false,
      code: "profile-missing",
      errors: [`cannot read pinned profile: ${error.message}`],
      policyErrors: [],
      emptyFields: [],
      profile: null,
      expected: null,
      profileSha256: null,
    };
  }

  if (!info.isFile() || info.isSymbolicLink()) {
    return {
      ok: false,
      code: "profile-invalid",
      errors: ["pinned profile must be a regular file, not a symlink"],
      policyErrors: [],
      emptyFields: [],
      profile: null,
      expected: null,
      profileSha256: null,
    };
  }
  if (info.uid !== process.geteuid()) {
    return {
      ok: false,
      code: "profile-invalid",
      errors: ["pinned profile must be owned by the current user"],
      policyErrors: [],
      emptyFields: [],
      profile: null,
      expected: null,
      profileSha256: null,
    };
  }
  if ((info.mode & 0o022) !== 0) {
    return {
      ok: false,
      code: "profile-invalid",
      errors: ["pinned profile must not be group- or world-writable"],
      policyErrors: [],
      emptyFields: [],
      profile: null,
      expected: null,
      profileSha256: null,
    };
  }
  if (info.size > MAX_PROFILE_TEXT_BYTES) {
    return {
      ok: false,
      code: "profile-invalid",
      errors: [`pinned profile exceeds ${MAX_PROFILE_TEXT_BYTES} bytes`],
      policyErrors: [],
      emptyFields: [],
      profile: null,
      expected: null,
      profileSha256: null,
    };
  }

  let text;
  try {
    text = await readFile(profilePath, "utf8");
  } catch (error) {
    return {
      ok: false,
      code: "profile-missing",
      errors: [`cannot read pinned profile: ${error.message}`],
      policyErrors: [],
      emptyFields: [],
      profile: null,
      expected: null,
      profileSha256: null,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      code: "profile-invalid",
      errors: [`invalid profile JSON: ${error.message}`],
      policyErrors: [],
      emptyFields: [],
      profile: null,
      expected: null,
      profileSha256: createHash("sha256").update(text).digest("hex"),
    };
  }

  const validation = validateDiagnosticProfile(parsed);
  return {
    ...validation,
    profileSha256: createHash("sha256").update(text).digest("hex"),
  };
}

export function syntheticProfileForBinary(binarySha256, overrides = {}) {
  return {
    schemaVersion: 1,
    profile: "local-self-signed",
    bundleId: SYNTHETIC_BUNDLE_ID,
    executableName: "macos-cua-peer-diagnostic",
    bundleShortVersion: "0.1.0",
    bundleVersion: "1",
    architectures: [FIXED_ARCH],
    minimumMacOSVersion: FIXED_DEPLOYMENT_TARGET,
    leafCertificateSha256: "a".repeat(64),
    designatedRequirement: `identifier "${SYNTHETIC_BUNDLE_ID}" and certificate leaf = H"${"b".repeat(40)}"`,
    executableSha256: binarySha256,
    entitlements: {},
    ...overrides,
  };
}
