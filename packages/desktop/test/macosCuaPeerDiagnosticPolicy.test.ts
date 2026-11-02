import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diagnosticSafetyFields } from "../scripts/lib/cua-peer-diagnostic-core.mjs";
import {
  loadPinnedProfile,
  validateDiagnosticProfile,
} from "../scripts/lib/cua-peer-diagnostic-profile.mjs";

const FIXTURES = join(import.meta.dirname, "fixtures/macosCuaPeerDiagnostic");
const PROFILE = join(FIXTURES, "profile.synthetic.json");
const INVALID_DR = join(FIXTURES, "profile.invalid-dr.json");

async function profileObject() {
  return JSON.parse(await readFile(PROFILE, "utf8"));
}

describe("macOS CUA R10 peer diagnostic profile policy", () => {
  it("reuses the existing strict local-self-signed profile validation", async () => {
    const loaded = await loadPinnedProfile(PROFILE);
    expect(loaded.ok).toBe(true);
    expect(loaded.expected.identifier).toBe(loaded.profile.bundleId);
    expect(loaded.expected.certificateSha1).toBe("b".repeat(40));
    expect(loaded.expected.leafCertificateSha256).toBe("a".repeat(64));
    expect(loaded.expected.designatedRequirement).toContain("certificate leaf = H");
  });

  it("blocks when no pinned profile is supplied", async () => {
    const loaded = await loadPinnedProfile(undefined);
    expect(loaded.ok).toBe(false);
    expect(loaded.code).toBe("profile-missing");
  });

  it("blocks an incomplete profile instead of inventing defaults", async () => {
    const profile = await profileObject();
    const result = validateDiagnosticProfile({ ...profile, leafCertificateSha256: "" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("profile-incomplete");
    expect(result.emptyFields).toContain("leafCertificateSha256");
  });

  it("rejects a non-narrow designated requirement", async () => {
    const loaded = await loadPinnedProfile(INVALID_DR);
    expect(loaded.ok).toBe(false);
    expect(loaded.code).toBe("profile-invalid");
    expect(loaded.policyErrors.join("\n")).toContain("designatedRequirement");
  });

  it("rejects forbidden library-validation entitlements", async () => {
    const profile = await profileObject();
    const result = validateDiagnosticProfile({
      ...profile,
      entitlements: {
        "com.apple.security.cs.disable-library-validation": true,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("profile-invalid");
    expect(result.policyErrors.join("\n")).toContain("forbidden entitlement");
  });

  it("rejects profiles below the fixed arm64 macOS 14.2 floor", async () => {
    const profile = await profileObject();
    const result = validateDiagnosticProfile({ ...profile, minimumMacOSVersion: "13.0" });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("14.2");
  });

  it("never emits a grant or native capability from diagnostic fields", () => {
    expect(diagnosticSafetyFields()).toMatchObject({
      diagnosticOnly: true,
      grant: false,
      nativeCapabilityProven: false,
      runtimeConsumable: false,
      productHook: false,
    });
  });
});
