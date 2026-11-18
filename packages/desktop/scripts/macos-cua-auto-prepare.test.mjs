import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureCuaNarrowFrozen } from "./macos-cua-auto-prepare.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cua-auto-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const canonical = (root) => join(root, "output/cua-narrow-frozen");
const selectVerified = async ({ repoRoot }) => {
  assert.equal(await readFile(join(canonical(repoRoot), "verified"), "utf8"), "valid");
  return { source: "default" };
};
const fetchFrozen = async ({ repoRoot }) => {
  await mkdir(canonical(repoRoot), { recursive: true });
  await writeFile(join(canonical(repoRoot), "verified"), "valid");
};

test("prepares in isolated repo, then reuses verified cache", async (t) => {
  const root = await fixture(t);
  let calls = 0;
  const deps = {
    selectVerified,
    fetchFrozen: async (args) => {
      calls++;
      await fetchFrozen(args);
    },
  };
  await ensureCuaNarrowFrozen({ repoRoot: root, env: {}, deps });
  await ensureCuaNarrowFrozen({ repoRoot: root, env: {}, deps });
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(join(root, "output")), ["cua-narrow-frozen"]);
});

test("existing partial tree fails without fetching or overwriting", async (t) => {
  const root = await fixture(t);
  await mkdir(canonical(root), { recursive: true });
  await writeFile(join(canonical(root), "partial"), "keep");
  await assert.rejects(
    ensureCuaNarrowFrozen({
      repoRoot: root,
      env: {},
      deps: {
        selectVerified,
        fetchFrozen: () => assert.fail("unexpected fetch"),
      },
    }),
  );
  assert.equal(await readFile(join(canonical(root), "partial"), "utf8"), "keep");
});

test("failed fetch cleans only its temporary tree", async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    ensureCuaNarrowFrozen({
      repoRoot: root,
      env: {},
      deps: {
        selectVerified,
        fetchFrozen: async ({ repoRoot }) => {
          await fetchFrozen({ repoRoot });
          throw new Error("failure");
        },
      },
    }),
    /failure/,
  );
  assert.deepEqual(await readdir(join(root, "output")), []);
});

test("competing complete preparations converge on verified winner", async (t) => {
  const root = await fixture(t);
  let ready = 0;
  let release;
  const both = new Promise((resolve) => {
    release = resolve;
  });
  const deps = {
    selectVerified,
    fetchFrozen: async (args) => {
      await fetchFrozen(args);
      if (++ready === 2) release();
      await both;
    },
  };
  const results = await Promise.allSettled([
    ensureCuaNarrowFrozen({ repoRoot: root, env: {}, deps }),
    ensureCuaNarrowFrozen({ repoRoot: root, env: {}, deps }),
  ]);
  assert.ok(results.some((result) => result.status === "fulfilled"));
  for (const result of results)
    if (result.status === "rejected") assert.equal(result.reason.code, "cua-frozen-publish-busy");
  assert.equal(await readFile(join(canonical(root), "verified"), "utf8"), "valid");
  assert.deepEqual(await readdir(join(root, "output")), ["cua-narrow-frozen"]);
});

test("a partial directory appearing during preparation is never replaced", async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    ensureCuaNarrowFrozen({
      repoRoot: root,
      env: {},
      deps: {
        selectVerified,
        fetchFrozen: async (args) => {
          await fetchFrozen(args);
          await mkdir(canonical(root));
        },
      },
    }),
  );
  assert.deepEqual(await readdir(canonical(root)), []);
  assert.deepEqual(await readdir(join(root, "output")), ["cua-narrow-frozen"]);
});

test("busy lock is reported and retained without publishing", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "output/.cua-narrow-publish.lock"), { recursive: true });
  await assert.rejects(
    ensureCuaNarrowFrozen({ repoRoot: root, env: {}, deps: { selectVerified, fetchFrozen } }),
    (error) => error.code === "cua-frozen-publish-busy",
  );
  assert.deepEqual(await readdir(join(root, "output")), [".cua-narrow-publish.lock"]);
});
