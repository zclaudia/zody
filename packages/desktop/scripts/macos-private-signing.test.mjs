import test from "node:test";
import assert from "node:assert/strict";
import { resolvePrivateMacSigning, signPrivateMacApp } from "./macos-private-signing.mjs";
import { PINNED_LEAF_SHA1, PINNED_LEAF_SHA256 } from "./macos-cua-narrow-resources-constants.mjs";

test("selection requires the target and local validated profile", () => {
  const base = {
    targetPlatform: { os: "darwin", arch: "arm64" },
    validated: { pins: { identityProfile: "local-self-signed" } },
    env: {},
  };
  assert.equal(resolvePrivateMacSigning(base).leafSha1, PINNED_LEAF_SHA1);
  assert.equal(resolvePrivateMacSigning({ ...base, env: { ZODY_MAC_PRIVATE_SIGN: "0" } }), null);
  assert.equal(
    resolvePrivateMacSigning({
      ...base,
      targetPlatform: { os: "linux", arch: "x64" },
    }),
    null,
  );
  assert.throws(() =>
    resolvePrivateMacSigning({
      ...base,
      validated: null,
      env: { ZODY_MAC_PRIVATE_SIGN: "1" },
    }),
  );
  assert.throws(() =>
    resolvePrivateMacSigning({
      ...base,
      env: { ZODY_MAC_PRIVATE_SIGN: "bad" },
    }),
  );
});

test("signs limited nested targets in order and validates resource and identity", async () => {
  const events = [];
  await signPrivateMacApp({
    appPath: "/tmp/Zody.app",
    bundleId: "io.github.zclaudia.zody",
    manifestPath: "/tmp/manifest",
    env: { ZODY_MAC_PRIVATE_KEYCHAIN: "/tmp/private.keychain-db" },
    deps: {
      readdir: async () => [
        { name: "B.framework", isDirectory: () => true },
        { name: "A.app", isDirectory: () => true },
      ],
      verify: async () => events.push("resource"),
      run: async (cmd, args) => events.push(args),
      readLeaf: async () => PINNED_LEAF_SHA256,
    },
  });
  assert.equal(events[0], "resource");
  assert.equal(events.at(-1), "resource");
  const signs = events.filter(Array.isArray).filter((x) => x.includes("--force"));
  assert.equal(signs.length, 3);
  assert.match(signs[0].at(-1), /A\.app$/);
  assert.match(signs[1].at(-1), /B\.framework$/);
  assert.equal(signs[2].at(-1), "/tmp/Zody.app");
  assert.ok(
    signs.every(
      (x) =>
        x.includes(PINNED_LEAF_SHA1) &&
        !x.includes("--deep") &&
        !x.some((a) => a.includes("cua-narrow")),
    ),
  );
  assert.ok(signs[2].some((x) => x.includes(PINNED_LEAF_SHA1)));
});

test("command failures are sanitized and identity mismatch fails", async () => {
  const deps = {
    readdir: async () => [],
    verify: async () => {},
    run: async () => {
      throw Error("SECRET");
    },
  };
  await assert.rejects(
    signPrivateMacApp({
      appPath: "/tmp/a.app",
      bundleId: "x",
      manifestPath: "/tmp/m",
      deps,
    }),
    (e) => !e.message.includes("SECRET"),
  );
  await assert.rejects(
    signPrivateMacApp({
      appPath: "/tmp/a.app",
      bundleId: "x",
      manifestPath: "/tmp/m",
      deps: { ...deps, run: async () => {}, readLeaf: async () => "bad" },
    }),
  );
});

test("uses the certificate reader structured digest without reading a private key", async () => {
  await assert.doesNotReject(
    signPrivateMacApp({
      appPath: "/tmp/mock-signed.app",
      bundleId: "io.github.zclaudia.zody",
      manifestPath: "/tmp/mock-manifest",
      env: {},
      deps: {
        verify: async () => {},
        readdir: async () => [],
        run: async () => {},
        readLeafCertificateDer: async () => ({
          sha256: PINNED_LEAF_SHA256,
          sha1: PINNED_LEAF_SHA1,
          der: Buffer.from("public certificate fixture"),
        }),
      },
    }),
  );
});
