import test from "node:test";
import assert from "node:assert/strict";
import {
  loadIdentityProfile,
  resolveIdentityProfileName,
} from "./macos-cua-narrow-identity-profile.mjs";
import { loadIdentityPins } from "./macos-cua-narrow-resources-pins.mjs";
import { verifyCodeIdentity } from "./macos-cua-narrow-resources-identity.mjs";

const policy = {
  schemaVersion: 1,
  kind: "zody-cua-developer-id-trust",
  status: "configured",
  teamIdentifier: "AB12345678",
  leafSha256: "a".repeat(64),
  leafSha1: "b".repeat(40),
  nodeCdhash: "c".repeat(40),
};
const deps = { readFile: async () => Buffer.from(JSON.stringify(policy)) };

test("profile selection and fixed trust root fail closed", async () => {
  assert.equal((await loadIdentityProfile({})).identityProfile, "local-self-signed");
  await assert.rejects(loadIdentityProfile({ identityProfile: "other" }));
  await assert.rejects(
    loadIdentityProfile({
      identityProfile: "developer-id",
      deps: {
        readFile: async () =>
          Buffer.from(
            JSON.stringify({
              schemaVersion: 1,
              kind: policy.kind,
              status: "unconfigured",
            }),
          ),
      },
    }),
  );
  const expected = await loadIdentityProfile({
    identityProfile: "developer-id",
    deps,
  });
  assert.equal(expected.teamIdentifier, policy.teamIdentifier);
  assert.match(expected.designatedRequirement, /anchor apple generic/);
  const pinsDeps = {
    readFile: async (path) =>
      path === "pins" ? Buffer.from(JSON.stringify(expected)) : deps.readFile(path),
  };
  assert.equal(
    (
      await loadIdentityPins({
        path: "pins",
        identityProfile: "developer-id",
        deps: pinsDeps,
      })
    ).nodeCdhash,
    policy.nodeCdhash,
  );
  await assert.rejects(
    loadIdentityPins({
      path: "pins",
      identityProfile: "developer-id",
      deps: {
        readFile: async (path) => (path === "pins" ? Buffer.from("{}") : deps.readFile(path)),
      },
    }),
  );
});

test("Developer ID verifies authority, team, timestamp and existing checks", async () => {
  const expected = await loadIdentityProfile({
    identityProfile: "developer-id",
    deps,
  });
  const base = {
    path: "/mock",
    label: "node",
    expectedIdentifier: expected.nodeIdentifier,
    expectedDesignatedRequirement: expected.nodeDesignatedRequirement,
    expectedLeafSha256: expected.nodeLeafSha256,
    expectedLeafSha1: expected.nodeLeafSha1,
    expectedCdhash: expected.nodeCdhash,
    expectedIdentityProfile: "developer-id",
    expectedTeamIdentifier: expected.teamIdentifier,
  };
  const run =
    (overrides = {}) =>
    async (_cmd, args) => ({
      code: 0,
      stderr: "",
      stdout: args.includes("--verbose=4")
        ? `Identifier=${expected.nodeIdentifier}\nCDHash=${overrides.cdhash ?? expected.nodeCdhash}\nAuthority=${overrides.authority ?? "Developer ID Application: Example"}\nTeamIdentifier=${overrides.team ?? expected.teamIdentifier}\n${overrides.timestamp ?? "Timestamp=Nov 18, 2026"}\nflags=0x10000(runtime)\n`
        : args.includes("-r-")
          ? `designated => ${overrides.dr ?? expected.nodeDesignatedRequirement}`
          : args.includes("--entitlements")
            ? (overrides.entitlements ?? "<plist><dict/></plist>")
            : "",
    });
  const verify = (overrides = {}) =>
    verifyCodeIdentity({
      ...base,
      deps: {
        run: run(overrides),
        readLeafCertificateDer: async () => ({
          sha256: overrides.leaf ?? policy.leafSha256,
          sha1: policy.leafSha1,
        }),
      },
    });
  await verify();
  for (const overrides of [
    { authority: "Apple Development: Example" },
    { team: "ZZ12345678" },
    { timestamp: "" },
    { dr: "fake" },
    { leaf: "x" },
    { cdhash: "x" },
    { entitlements: "<key>bad</key>" },
  ])
    await assert.rejects(verify(overrides));
});

test("malformed policy and pins are rejected with typed errors", async () => {
  assert.equal(resolveIdentityProfileName(), "local-self-signed");
  assert.throws(
    () => resolveIdentityProfileName(""),
    (e) => e.code === "narrow-identity-profile",
  );
  for (const raw of [null, [], { ...policy, teamIdentifier: 1234567890 }]) {
    await assert.rejects(
      loadIdentityProfile({
        identityProfile: "developer-id",
        deps: { readFile: async () => Buffer.from(JSON.stringify(raw)) },
      }),
      (e) => e.code === "narrow-pins-mismatch",
    );
  }
  await assert.rejects(
    loadIdentityPins({ path: "pins", deps: { readFile: async () => Buffer.from("null") } }),
    (e) => e.code === "narrow-pins-mismatch",
  );
});
