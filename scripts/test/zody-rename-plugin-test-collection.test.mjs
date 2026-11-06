import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const pluginTests = [
  "packages/ui/src/gen-ui/adapters/page.test.ts",
  "packages/ui/src/plugin-ui/app/pluginUiHostController.test.ts",
  "packages/desktop/src/renderer/src/plugin-sandbox/aliasRuntime.test.ts",
];
const controlTest = "packages/services/src/plugin-ui-bridge/contract.test.ts";
const e2eTest =
  "packages/desktop/test/e2e/plugins/manual-review/pending/zody-rename-plugin-wire.test.ts";

// 实际收集配置是唯一事实源；不能靠正则命中配置文本冒充 runner 已收集。
test("default root collection includes plugin regressions and still excludes E2E", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zody-plugin-test-collection-"));
  try {
    const outputPath = join(directory, "collected.json");
    await exec(
      process.execPath,
      [
        join(root, "node_modules/vitest/vitest.mjs"),
        "list",
        ...pluginTests,
        controlTest,
        e2eTest,
        "--filesOnly",
        `--json=${outputPath}`,
      ],
      { cwd: root },
    );
    const collected = JSON.parse(await readFile(outputPath, "utf8"));
    assert.deepEqual(
      collected.map((item) => item.file).sort(),
      [...pluginTests, controlTest].map((file) => join(root, file)).sort(),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("the actual affected related runner executes all three plugin regression files", async () => {
  const result = await exec(
    process.execPath,
    [join(root, "scripts/run-lint-staged-vitest.mjs"), "related", ...pluginTests],
    { cwd: root, maxBuffer: 4 * 1024 * 1024 },
  );
  const output = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`);
  assert.match(output, /Test Files\s+3 passed/);
  assert.doesNotMatch(output, /No test files found/);
}, 60_000);
