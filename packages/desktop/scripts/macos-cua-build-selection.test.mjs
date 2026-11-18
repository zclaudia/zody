import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveMacosCuaDemoBuildSelection } from "./macos-cua-build-selection.mjs";

const target = { targetOs: "darwin", targetArch: "arm64", env: {} };
const facts = { manifestRelativePath: "manifest.json", manifestSha256: "a".repeat(64) };

test("missing default calls ensure before retry; other errors never prepare", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cua-select-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let count = 0;
  const opts = {
    ...target,
    repoRoot: root,
    defaultFacts: facts,
    ensureFrozenInputs: async () => {
      count++;
      await writeFile(join(root, "manifest.json"), "bad");
    },
  };
  await assert.rejects(
    resolveMacosCuaDemoBuildSelection(opts),
    (error) => error.code === "cua-demo-default-pin-mismatch",
  );
  assert.equal(count, 1);
  await assert.rejects(
    resolveMacosCuaDemoBuildSelection(opts),
    (error) => error.code === "cua-demo-default-pin-mismatch",
  );
  assert.equal(count, 1);
});

test("dry run, explicit profile and other targets never prepare", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cua-select-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ensureFrozenInputs = () => assert.fail("unexpected preparation");
  await assert.rejects(
    resolveMacosCuaDemoBuildSelection({
      ...target,
      repoRoot: root,
      defaultFacts: facts,
      autoPrepare: false,
      ensureFrozenInputs,
    }),
    (error) => error.code === "cua-demo-default-resource-missing",
  );
  assert.equal(
    await resolveMacosCuaDemoBuildSelection({ ...target, targetOs: "linux", ensureFrozenInputs }),
    null,
  );
  assert.equal(
    (
      await resolveMacosCuaDemoBuildSelection({
        ...target,
        env: { ZODY_CUA_NARROW_AGENT_JSON: "{}" },
        ensureFrozenInputs,
      })
    ).source,
    "explicit",
  );
});

test("invalid explicit manifest never triggers default preparation", async () => {
  await assert.rejects(
    resolveMacosCuaDemoBuildSelection({
      ...target,
      cliManifestPath: "/tmp/missing-cua-manifest.json",
      validateManifest: async () => {
        throw new Error("explicit invalid");
      },
      ensureFrozenInputs: () => assert.fail("unexpected preparation"),
    }),
    /explicit invalid/,
  );
});
