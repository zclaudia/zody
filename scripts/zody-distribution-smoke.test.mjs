import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const smoke = fileURLToPath(new URL("./zody-distribution-smoke.mjs", import.meta.url));

test("smoke reaches the runner in the current distribution archive layout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zody-smoke-test-"));
  try {
    await mkdir(join(directory, "zody", "bin"), { recursive: true });
    // 让 runner 在 help 阶段主动失败，证明 smoke 已解包并运行真实入口，而非仅检查路径字符串。
    await writeFile(
      join(directory, "zody", "bin", "zody.mjs"),
      'console.error("fixture-runner-reached", process.argv[2]); process.exit(42);',
    );
    const archive = join(directory, "fixture.tar.gz");
    await exec("tar", ["-czf", archive, "-C", directory, "zody"]);
    await assert.rejects(exec(process.execPath, [smoke, archive]), (error) => {
      assert.match(error.stderr, /fixture-runner-reached --help/);
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
