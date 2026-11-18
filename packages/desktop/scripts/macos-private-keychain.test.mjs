import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupPrivateKeychain, cleanupPrivateKeychain } from "./macos-private-keychain.mjs";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "keychain-test-"));
  const env = {
    RUNNER_TEMP: root,
    GITHUB_ENV: join(root, "github-env"),
    ZODY_MAC_PRIVATE_CERT_P12_BASE64: Buffer.from("synthetic p12 fixture").toString("base64"),
    ZODY_MAC_PRIVATE_CERT_PASSWORD: "synthetic-password",
  };
  const calls = [];
  const deps = {
    run: async (command, args) => calls.push([command, args]),
    randomPassword: () => "synthetic-random-password",
  };
  return {
    root,
    env,
    deps,
    calls,
    loaded: async () => ({
      ...env,
      ...Object.fromEntries(
        (await readFile(env.GITHUB_ENV, "utf8"))
          .trim()
          .split("\n")
          .map((line) => {
            const i = line.indexOf("=");
            return [line.slice(0, i), line.slice(i + 1)];
          }),
      ),
    }),
  };
}
test("temporary keychain is unique, uses explicit paths and cleans only its owner", async () => {
  const f = await fixture();
  try {
    const keychain = await setupPrivateKeychain(f);
    const env = await f.loaded();
    assert.equal(env.ZODY_MAC_PRIVATE_KEYCHAIN, keychain);
    assert.equal(
      (await readFile(join(env.ZODY_MAC_PRIVATE_DIRECTORY, "owner.json"), "utf8")).includes(
        env.ZODY_MAC_PRIVATE_OWNER,
      ),
      true,
    );
    await assert.rejects(access(join(env.ZODY_MAC_PRIVATE_DIRECTORY, "identity.p12")));
    const wrong = { ...env, ZODY_MAC_PRIVATE_OWNER: "wrong" };
    await assert.rejects(cleanupPrivateKeychain({ env: wrong, deps: f.deps }));
    await access(env.ZODY_MAC_PRIVATE_DIRECTORY);
    await cleanupPrivateKeychain({ env, deps: f.deps });
    await cleanupPrivateKeychain({ env, deps: f.deps });
    assert.deepEqual(
      f.calls.map((x) => x[1][0]),
      ["create-keychain", "unlock-keychain", "import", "set-key-partition-list", "delete-keychain"],
    );
    assert.ok(
      !f.calls.some((x) => x[1].some((v) => /search-list|default-keychain|trusted-cert/.test(v))),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("always cleanup without setup leaves a pre-existing directory untouched", async () => {
  const f = await fixture();
  try {
    const prior = join(f.root, "zody-macos-private-signing");
    await mkdir(prior);
    await writeFile(join(prior, "sentinel"), "keep");
    await cleanupPrivateKeychain(f);
    assert.equal(f.calls.length, 0);
    assert.equal(await readFile(join(prior, "sentinel"), "utf8"), "keep");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("existing directory without marker is never deleted", async () => {
  const f = await fixture();
  try {
    const prior = join(f.root, "zody-macos-private-signing-prior");
    await mkdir(prior);
    await assert.rejects(
      cleanupPrivateKeychain({
        env: { ...f.env, ZODY_MAC_PRIVATE_DIRECTORY: prior, ZODY_MAC_PRIVATE_OWNER: "other" },
        deps: f.deps,
      }),
    );
    await access(prior);
    assert.equal(f.calls.length, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("missing input and command failures do not reveal secrets and clear own temporary data", async () => {
  await assert.rejects(setupPrivateKeychain({ env: {} }), /ZODY_MAC_PRIVATE_CERT/);
  const f = await fixture();
  try {
    await assert.rejects(
      setupPrivateKeychain({
        env: f.env,
        deps: {
          ...f.deps,
          run: async () => {
            throw Error("synthetic-password");
          },
        },
      }),
      (e) => !e.message.includes("synthetic-password"),
    );
    const env = await f.loaded();
    await assert.rejects(access(env.ZODY_MAC_PRIVATE_DIRECTORY));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("marker write failure removes the directory created by this setup", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      setupPrivateKeychain({
        env: f.env,
        deps: {
          ...f.deps,
          writeFile: async () => {
            throw Error("marker unavailable");
          },
        },
      }),
    );
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(f.root), []);
    assert.equal(f.calls.length, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
