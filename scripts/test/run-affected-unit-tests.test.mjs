import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { selectDefaultBranchRef } from "../affected-unit-test-baseline.mjs";

test("prefers origin/staging as the default affected-test baseline", () => {
  const availableRefs = new Set(["origin/staging", "origin/main"]);

  const selected = selectDefaultBranchRef({
    originHead: "origin/main",
    hasCommit: (ref) => availableRefs.has(ref),
  });

  assert.equal(selected, "origin/staging");
});

test("does not force a full unit run based on changed file names", async () => {
  const runnerSource = await readFile(
    new URL("../run-affected-unit-tests.mjs", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(runnerSource, /isFullRunTrigger/u);
});

test(
  "large git path lists are read completely and git errors stay bounded",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "affected-output-"));
    try {
      const bin = join(root, "bin");
      await mkdir(bin);
      const git = join(bin, "git");
      await writeFile(
        git,
        `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === 'diff') {
  if (a.includes('--diff-filter=D')) process.exit(0);
  process.stdout.write(Array.from({length: 16000}, (_,i) => 'docs/' + 'x'.repeat(85) + i + '.md\\0').join(''), () => process.exit(process.env.FAKE_GIT_FAIL ? 1 : 0));
} else if (a.includes('--show-toplevel')) console.log(process.env.FAKE_ROOT);
else console.log('a'.repeat(40));
`,
      );
      await chmod(git, 0o755);
      const runner = fileURLToPath(new URL("../run-affected-unit-tests.mjs", import.meta.url));
      const env = {
        ...process.env,
        PATH: bin + delimiter + process.env.PATH,
        ZODY_PRE_PUSH_BASE: "base",
        FAKE_ROOT: root,
      };
      const good = spawnSync(process.execPath, [runner], {
        env,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      });
      assert.equal(good.status, 0, good.stderr.slice(0, 160));
      assert.match(good.stdout, /跳过 Vitest/);
      const bad = spawnSync(process.execPath, [runner], {
        env: { ...env, FAKE_GIT_FAIL: "1" },
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      });
      assert.equal(bad.status, 1);
      assert.ok(bad.stderr.length < 4096, "git failure must not dump the whole file list");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
