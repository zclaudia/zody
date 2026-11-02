import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_IDENTITY_PINS_PATH,
  PINNED_DESIGNATED_REQUIREMENT,
  PINNED_HELPER_IDENTIFIER,
  PINNED_LEAF_SHA1,
  PINNED_LEAF_SHA256,
  PINNED_NODE_CDHASH,
  PINNED_NODE_DESIGNATED_REQUIREMENT,
  PINNED_NODE_IDENTIFIER,
  REPO_ROOT,
  loadIdentityPins,
  sha1Bytes,
  sha256Bytes,
  verifyCodeIdentity,
  verifyMachO,
} from "./macos-cua-narrow-resources.mjs";
import { TEST_ROOT, expectedPins } from "./macos-cua-narrow-resources-test-fixtures.mjs";

function codesignDisplay(overrides = {}) {
  return [
    "Executable=/tmp/helper",
    `Identifier=${overrides.identifier ?? PINNED_HELPER_IDENTIFIER}`,
    "Format=app bundle with Mach-O thin (arm64)",
    `CodeDirectory v=20500 size=1 flags=${overrides.flags ?? "0x10000(runtime)"} hashes=1+1`,
    `CDHash=${overrides.cdhash ?? "d476586ca3d6d27c528458021d4dcc1727496a2d"}`,
    "Authority=Zody Local Computer Use",
    "Signature size=2103",
    ...(overrides.signature ? [overrides.signature] : []),
  ].join("\n");
}

function fakeCodesignRun({
  display,
  requirement = PINNED_DESIGNATED_REQUIREMENT,
  verify = { code: 0, stdout: "", stderr: "valid on disk" },
  entitlements = "",
}) {
  return async (_command, args) => {
    if (args.includes("--verify")) return verify;
    if (args.includes("--entitlements")) return { code: 0, stdout: entitlements, stderr: "" };
    if (args[1] === "-r-") {
      return {
        code: 0,
        stdout: `Executable=/tmp/helper\ndesignated => ${requirement}`,
        stderr: "",
      };
    }
    if (args.includes("--verbose=4")) return { code: 0, stdout: display, stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected args: ${args.join(" ")}` };
  };
}

function fakeLeaf(overrides = {}) {
  return {
    sha256: overrides.sha256 ?? PINNED_LEAF_SHA256,
    sha1: overrides.sha1 ?? PINNED_LEAF_SHA1,
  };
}

function verifyIdentityOptions(overrides = {}) {
  return {
    path: "/tmp/helper",
    label: "fixture helper",
    expectedIdentifier: PINNED_HELPER_IDENTIFIER,
    expectedDesignatedRequirement: PINNED_DESIGNATED_REQUIREMENT,
    expectedLeafSha256: PINNED_LEAF_SHA256,
    expectedLeafSha1: PINNED_LEAF_SHA1,
    deps: {
      run: fakeCodesignRun({
        display: codesignDisplay(overrides.display),
        requirement: overrides.requirement,
      }),
      readLeafCertificateDer: async () => fakeLeaf(overrides.leaf),
      ...overrides.deps,
    },
    ...overrides.options,
  };
}

test("identity pins are read only from the fixed path and must match fixed hashes", async () => {
  await mkdir(TEST_ROOT, { recursive: true });
  const root = await mkdtemp(join(TEST_ROOT, "pins-"));
  try {
    const goodPinsPath = join(root, "identity-pins.json");
    await writeFile(goodPinsPath, `${JSON.stringify(expectedPins(), null, 2)}\n`);
    const pins = await loadIdentityPins({ path: goodPinsPath });
    assert.equal(pins.leafSha256, PINNED_LEAF_SHA256);
    assert.equal(pins.nodeLeafSha256, PINNED_LEAF_SHA256);

    const badPinsPath = join(root, "bad-identity-pins.json");
    await writeFile(
      badPinsPath,
      `${JSON.stringify({ ...expectedPins(), leafSha256: "0".repeat(64) }, null, 2)}\n`,
    );
    await assert.rejects(() => loadIdentityPins({ path: badPinsPath }), (error) => {
      assert.equal(error.code, "narrow-pins-mismatch");
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codesign identity, DR, runtime flag, strict signature and empty entitlements are enforced", async () => {
  await assert.doesNotReject(() => verifyCodeIdentity(verifyIdentityOptions()));

  await assert.rejects(
    () =>
      verifyCodeIdentity(
        verifyIdentityOptions({
          display: { identifier: "io.github.zclaudia.zody.some-other-helper" },
        }),
      ),
    (error) => error.code === "narrow-identity-mismatch",
  );

  await assert.rejects(
    () =>
      verifyCodeIdentity(
        verifyIdentityOptions({
          requirement:
            'identifier "io.github.zclaudia.zody.cua-helper" and certificate leaf = H"0000000000000000000000000000000000000000"',
        }),
      ),
    (error) => error.code === "narrow-designated-requirement-mismatch",
  );

  await assert.rejects(
    () => verifyCodeIdentity(verifyIdentityOptions({ display: { flags: "0x0" } })),
    (error) => error.code === "narrow-signature-invalid",
  );

  await assert.rejects(
    () => verifyCodeIdentity(verifyIdentityOptions({ display: { signature: "Signature=adhoc" } })),
    (error) => error.code === "narrow-signature-invalid",
  );

  await assert.rejects(
    () =>
      verifyCodeIdentity(
        verifyIdentityOptions({
          deps: {
            run: fakeCodesignRun({
              display: codesignDisplay(),
              verify: { code: 1, stdout: "", stderr: "CSSMERR_TP_NOT_TRUSTED" },
            }),
          },
        }),
      ),
    (error) => error.code === "narrow-signature-invalid",
  );

  await assert.rejects(
    () =>
      verifyCodeIdentity(
        verifyIdentityOptions({
          deps: {
            run: fakeCodesignRun({
              display: codesignDisplay(),
              entitlements:
                '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>',
            }),
          },
        }),
      ),
    (error) => error.code === "narrow-entitlements",
  );

  await assert.rejects(
    () => verifyCodeIdentity(verifyIdentityOptions({ leaf: { sha256: "0".repeat(64) } })),
    (error) => error.code === "narrow-identity-mismatch",
  );
});

test("DR is read from codesign -d -r- and strict verify uses the fixed -R requirement", async () => {
  const calls = [];
  const run = async (_command, args) => {
    calls.push(args);
    if (args[1] === "-r-") {
      return {
        code: 0,
        stdout: `Executable=/tmp/helper\ndesignated => ${PINNED_DESIGNATED_REQUIREMENT}`,
        stderr: "",
      };
    }
    if (args.includes("--verbose=4")) return { code: 0, stdout: codesignDisplay(), stderr: "" };
    if (args.includes("--entitlements")) return { code: 0, stdout: "", stderr: "" };
    if (args.includes("--verify")) return { code: 0, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected args: ${args.join(" ")}` };
  };
  await verifyCodeIdentity({
    path: "/tmp/helper",
    label: "fixture helper",
    expectedIdentifier: PINNED_HELPER_IDENTIFIER,
    expectedDesignatedRequirement: PINNED_DESIGNATED_REQUIREMENT,
    expectedLeafSha256: PINNED_LEAF_SHA256,
    expectedLeafSha1: PINNED_LEAF_SHA1,
    deps: { run, readLeafCertificateDer: async () => fakeLeaf() },
  });
  assert.ok(calls.some((args) => args[1] === "-r-"));
  assert.ok(
    calls.some(
      (args) =>
        args.includes("--strict") &&
        args.includes(`-R=${PINNED_DESIGNATED_REQUIREMENT}`),
    ),
  );
});

test("default leaf extraction uses codesign --extract-certificates=<prefix> and hashes leaf0", async () => {
  const der = Buffer.from("fixture leaf der");
  const calls = [];
  const run = async (_command, args) => {
    calls.push(args);
    if (args[1] === "-r-") {
      return {
        code: 0,
        stdout: `Executable=/tmp/helper\ndesignated => ${PINNED_DESIGNATED_REQUIREMENT}`,
        stderr: "",
      };
    }
    if (args.includes("--verbose=4")) return { code: 0, stdout: codesignDisplay(), stderr: "" };
    if (args.includes("--entitlements")) return { code: 0, stdout: "", stderr: "" };
    if (args.includes("--verify")) return { code: 0, stdout: "", stderr: "" };
    const extract = args.find((arg) => arg.startsWith("--extract-certificates="));
    if (extract) {
      const prefix = extract.slice("--extract-certificates=".length);
      await writeFile(`${prefix}0`, der);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected args: ${args.join(" ")}` };
  };
  const result = await verifyCodeIdentity({
    path: "/tmp/helper",
    label: "fixture helper",
    expectedIdentifier: PINNED_HELPER_IDENTIFIER,
    expectedDesignatedRequirement: PINNED_DESIGNATED_REQUIREMENT,
    expectedLeafSha256: sha256Bytes(der),
    expectedLeafSha1: sha1Bytes(der),
    deps: { run },
  });
  assert.equal(result.leafSha256, sha256Bytes(der));
  assert.ok(calls.some((args) => args.some((arg) => arg.startsWith("--extract-certificates="))));
});

test("leaf extraction fails when codesign does not write leaf0", async () => {
  const run = async (_command, args) => {
    if (args[1] === "-r-") {
      return {
        code: 0,
        stdout: `Executable=/tmp/helper\ndesignated => ${PINNED_DESIGNATED_REQUIREMENT}`,
        stderr: "",
      };
    }
    if (args.includes("--verbose=4")) return { code: 0, stdout: codesignDisplay(), stderr: "" };
    if (args.includes("--entitlements")) return { code: 0, stdout: "", stderr: "" };
    if (args.includes("--verify")) return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(
    () =>
      verifyCodeIdentity({
        path: "/tmp/helper",
        label: "fixture helper",
        expectedIdentifier: PINNED_HELPER_IDENTIFIER,
        expectedDesignatedRequirement: PINNED_DESIGNATED_REQUIREMENT,
        expectedLeafSha256: PINNED_LEAF_SHA256,
        expectedLeafSha1: PINNED_LEAF_SHA1,
        deps: { run },
      }),
    (error) => error.code === "narrow-signature-invalid",
  );
});

test("verifyMachO returns real architectures and rejects universal or failed tools", async () => {
  const runFor = ({ lipo = "arm64\n", lipoCode = 0, otool = "  minos 14.2\n", otoolCode = 0 }) =>
    async (_command, args) => {
      if (args[0] === "-archs") {
        return { code: lipoCode, stdout: lipo, stderr: lipoCode ? "lipo failed" : "" };
      }
      return { code: otoolCode, stdout: otool, stderr: otoolCode ? "otool failed" : "" };
    };

  const result = await verifyMachO("/tmp/helper", {
    label: "fixture",
    requireMinimumMacOS: true,
    deps: { run: runFor({}) },
  });
  assert.deepEqual(result.architectures, ["arm64"]);
  assert.deepEqual(result.minos, ["14.2"]);

  await assert.rejects(
    () =>
      verifyMachO("/tmp/helper", {
        label: "fixture",
        requireMinimumMacOS: true,
        deps: { run: runFor({ lipo: "x86_64 arm64\n" }) },
      }),
    (error) => error.code === "narrow-target-unsupported",
  );
  await assert.rejects(
    () =>
      verifyMachO("/tmp/helper", {
        label: "fixture",
        requireMinimumMacOS: true,
        deps: { run: runFor({ lipoCode: 1 }) },
      }),
    (error) => error.code === "narrow-target-unsupported",
  );
  await assert.rejects(
    () =>
      verifyMachO("/tmp/helper", {
        label: "fixture",
        requireMinimumMacOS: true,
        deps: { run: runFor({ otoolCode: 1 }) },
      }),
    (error) => error.code === "narrow-target-unsupported",
  );

  const node = await verifyMachO("/tmp/node", {
    label: "node",
    requireMinimumMacOS: false,
    deps: { run: runFor({ otool: "  minos 13.5\n" }) },
  });
  assert.deepEqual(node.minos, ["13.5"]);
});

test("fixed pin constants stay aligned with the read-only identity pins file", async () => {
  const raw = JSON.parse(await readFile(DEFAULT_IDENTITY_PINS_PATH, "utf8"));
  assert.equal(raw.leafSha256, PINNED_LEAF_SHA256);
  assert.equal(raw.nodeLeafSha256, PINNED_LEAF_SHA256);
  assert.equal(raw.designatedRequirement, PINNED_DESIGNATED_REQUIREMENT);
  assert.equal(raw.nodeDesignatedRequirement, PINNED_NODE_DESIGNATED_REQUIREMENT);
  assert.equal(raw.nodeIdentifier, PINNED_NODE_IDENTIFIER);
  assert.equal(raw.nodeCdhash, PINNED_NODE_CDHASH);
});

test("test root stays under the authorized output directory", async () => {
  assert.match(TEST_ROOT, new RegExp(`${REPO_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});
