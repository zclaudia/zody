import { basename } from "node:path";

export const PROFILE_SCHEMA_VERSION = 1;
export const PROFILE_KIND = "local-self-signed";
export const MAX_PROFILE_TEXT_BYTES = 1024 * 1024;
export const MAX_ENTITLEMENT_DEPTH = 32;
export const MAX_ENTITLEMENT_NODES = 2048;
export const PROFILE_FIELDS = Object.freeze([
  "schemaVersion",
  "profile",
  "bundleId",
  "executableName",
  "bundleShortVersion",
  "bundleVersion",
  "architectures",
  "minimumMacOSVersion",
  "leafCertificateSha256",
  "designatedRequirement",
  "executableSha256",
  "entitlements",
]);

export const FORBIDDEN_ENTITLEMENT_KEYS = Object.freeze([
  "com.apple.security.cs.disable-library-validation",
  "com.apple.security.cs.allow-dyld-environment-variables",
]);

const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;
const VERSION_PATTERN = /^\d+(?:\.\d+){0,2}$/;
const MINIMUM_MACOS_PATTERN = /^\d+(?:\.\d+){1,2}$/;
const ARCHITECTURE_PATTERN = /^(?:arm64|arm64e|x86_64)$/;
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const DESIGNATED_REQUIREMENT_PATTERN =
  /^identifier\s+"([^"]+)"\s+and\s+certificate\s+leaf\s*=\s*H"([0-9a-fA-F]{40})"$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseProfileText(text) {
  if (typeof text !== "string") {
    return { ok: false, error: "profile text must be a string" };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_PROFILE_TEXT_BYTES) {
    return { ok: false, error: `profile JSON exceeds ${MAX_PROFILE_TEXT_BYTES} bytes` };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: `invalid profile JSON: ${error.message}` };
  }
}

function validateEntitlementValue(value, fieldPath, errors, depth, budget) {
  budget.count += 1;
  if (budget.count > MAX_ENTITLEMENT_NODES) {
    errors.push(`entitlements exceed ${MAX_ENTITLEMENT_NODES} nodes`);
    return;
  }
  if (depth > MAX_ENTITLEMENT_DEPTH) {
    errors.push(`entitlements exceed depth ${MAX_ENTITLEMENT_DEPTH}`);
    return;
  }
  if (value === null) {
    errors.push(`${fieldPath} must not be null`);
    return;
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      errors.push(`${fieldPath} must be a finite number`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      validateEntitlementValue(entry, `${fieldPath}[${index}]`, errors, depth + 1, budget),
    );
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      validateEntitlementValue(entry, `${fieldPath}.${key}`, errors, depth + 1, budget);
    }
    return;
  }
  errors.push(`${fieldPath} must be JSON-serializable`);
}

function hasSafeVersionParts(value) {
  return value
    .split(".")
    .map((part) => Number(part))
    .every((part) => Number.isSafeInteger(part));
}

export function findForbiddenEntitlementKeys(entitlements) {
  if (!isPlainObject(entitlements)) {
    return [];
  }
  return FORBIDDEN_ENTITLEMENT_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(entitlements, key),
  );
}

export function isLegacyBundleId(bundleId) {
  return typeof bundleId === "string" && bundleId.toLowerCase().includes("dev.zcode");
}

export function parseDesignatedRequirementPolicy(value, bundleId) {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, error: "designatedRequirement must be a non-empty string" };
  }
  const match = DESIGNATED_REQUIREMENT_PATTERN.exec(value.trim());
  if (!match) {
    return {
      ok: false,
      error:
        'designatedRequirement must be exactly identifier "<bundleId>" and certificate leaf = H"<40-hex SHA-1>"',
    };
  }
  if (typeof bundleId === "string" && bundleId.length > 0 && match[1] !== bundleId) {
    return {
      ok: false,
      error: `designatedRequirement identifier ${match[1]} does not match bundleId ${bundleId}`,
    };
  }
  return { ok: true, identifier: match[1], certificateSha1: match[2].toLowerCase() };
}

export function validateProfile(input) {
  const errors = [];
  const emptyFields = [];
  const policyErrors = [];
  const profile = {};

  if (!isPlainObject(input)) {
    return {
      errors: ["profile root must be a JSON object"],
      emptyFields,
      policyErrors,
      profile,
    };
  }

  for (const key of Object.keys(input)) {
    if (!PROFILE_FIELDS.includes(key)) {
      errors.push(
        key === "teamId"
          ? "unknown field teamId: local-self-signed profile does not use an Apple Team ID"
          : `unknown field ${key}`,
      );
    }
  }
  for (const field of PROFILE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) {
      errors.push(`missing required field ${field}`);
    }
  }

  if (input.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${PROFILE_SCHEMA_VERSION}`);
  } else {
    profile.schemaVersion = PROFILE_SCHEMA_VERSION;
  }

  if (input.profile !== PROFILE_KIND) {
    errors.push(`profile must be ${PROFILE_KIND}`);
  } else {
    profile.profile = PROFILE_KIND;
  }

  const requiredStrings = [
    "bundleId",
    "executableName",
    "bundleShortVersion",
    "bundleVersion",
    "minimumMacOSVersion",
    "leafCertificateSha256",
    "designatedRequirement",
    "executableSha256",
  ];
  for (const field of requiredStrings) {
    const value = input[field];
    if (typeof value !== "string") {
      errors.push(`${field} must be a string`);
      continue;
    }
    if (value.length === 0) {
      emptyFields.push(field);
      profile[field] = value;
      continue;
    }
    if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
      errors.push(`${field} must not contain NUL or newlines`);
      continue;
    }
    profile[field] = value;
  }

  if (typeof profile.bundleId === "string" && profile.bundleId.length > 0) {
    if (!BUNDLE_ID_PATTERN.test(profile.bundleId)) {
      errors.push("bundleId must be a reverse-DNS style identifier");
    }
    if (isLegacyBundleId(profile.bundleId)) {
      policyErrors.push("bundleId must not reuse the historical dev.zcode identity");
    }
  }

  if (typeof profile.executableName === "string" && profile.executableName.length > 0) {
    if (
      profile.executableName.includes("/") ||
      profile.executableName.includes("\\") ||
      profile.executableName === "." ||
      profile.executableName === ".." ||
      basename(profile.executableName) !== profile.executableName
    ) {
      errors.push("executableName must be a single path component");
    }
  }

  for (const field of ["bundleShortVersion", "bundleVersion"]) {
    const value = profile[field];
    if (
      typeof value === "string" &&
      value.length > 0 &&
      (!VERSION_PATTERN.test(value) || !hasSafeVersionParts(value))
    ) {
      errors.push(`${field} must be a dot-separated numeric version`);
    }
  }

  if (
    typeof profile.minimumMacOSVersion === "string" &&
    profile.minimumMacOSVersion.length > 0 &&
    (!MINIMUM_MACOS_PATTERN.test(profile.minimumMacOSVersion) ||
      !hasSafeVersionParts(profile.minimumMacOSVersion))
  ) {
    errors.push("minimumMacOSVersion must be a dot-separated numeric version");
  }

  for (const field of ["leafCertificateSha256", "executableSha256"]) {
    const value = profile[field];
    if (typeof value === "string" && value.length > 0) {
      if (!SHA256_PATTERN.test(value)) {
        errors.push(`${field} must be 64 hexadecimal characters`);
      } else {
        profile[field] = value.toLowerCase();
      }
    }
  }

  if (
    typeof profile.designatedRequirement === "string" &&
    profile.designatedRequirement.length > 0
  ) {
    const designation = parseDesignatedRequirementPolicy(
      profile.designatedRequirement,
      typeof profile.bundleId === "string" ? profile.bundleId : null,
    );
    if (!designation.ok) {
      policyErrors.push(designation.error);
    }
  }

  if (!Array.isArray(input.architectures)) {
    errors.push("architectures must be an array");
  } else if (input.architectures.length === 0) {
    emptyFields.push("architectures");
    profile.architectures = [];
  } else {
    const seen = new Set();
    profile.architectures = [];
    input.architectures.forEach((architecture, index) => {
      if (typeof architecture !== "string" || !ARCHITECTURE_PATTERN.test(architecture)) {
        errors.push(`architectures[${index}] must be one of arm64, arm64e, x86_64`);
        return;
      }
      if (seen.has(architecture)) {
        errors.push(`architectures[${index}] duplicates ${architecture}`);
        return;
      }
      seen.add(architecture);
      profile.architectures.push(architecture);
    });
  }

  if (!isPlainObject(input.entitlements)) {
    errors.push("entitlements must be an object");
  } else {
    profile.entitlements = input.entitlements;
    validateEntitlementValue(input.entitlements, "entitlements", errors, 0, { count: 0 });
    for (const key of findForbiddenEntitlementKeys(input.entitlements)) {
      policyErrors.push(`forbidden entitlement ${key}`);
    }
  }

  return { errors, emptyFields, policyErrors, profile };
}
