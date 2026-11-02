// native 单测编译/执行清单；与构建编排分离，入口只调用一次。
import { constants as fsConstants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { NATIVE_ROOT } from "./cua-desktop-session-config.mjs";
import { sessionTestCompileArgs } from "./cua-desktop-session-source.mjs";
import { compile, run, sha256File } from "./cua-desktop-session-toolchain.mjs";

const TEST_CASES = [
  {
    name: "session-binding-confirmation",
    source: "session_binding_test.mm",
    sources: ["session_binding.mm", "confirmation_state.mm"],
  },
  {
    name: "session-control",
    source: "session_control_test.mm",
    sources: ["session_control.mm"],
  },
  {
    name: "session-capture-file",
    source: "session_capture_file_test.mm",
    sources: ["session_capture_file.mm"],
  },
  {
    name: "session-exit-policy",
    source: "session_exit_policy_test.mm",
    sources: [],
  },
];

export async function pathIsReadable(path) {
  return access(path, fsConstants.R_OK)
    .then(() => true)
    .catch(() => false);
}

export async function runNativeTests(toolchain, { srcDir, includeRoot, visualRoot, testRoot }) {
  await mkdir(testRoot, { recursive: true, mode: 0o700 });
  const results = [];
  for (const testCase of TEST_CASES) {
    const output = join(testRoot, testCase.name);
    const args = sessionTestCompileArgs(toolchain, {
      srcDir,
      includeRoot,
      visualRoot,
      testSource: join(NATIVE_ROOT, "tests", testCase.source),
      sources: testCase.sources,
      output,
    });
    await compile(toolchain, args, `test-${testCase.name}`, srcDir);
    const result = await run(output, [], { timeoutMs: 30_000 });
    if (result.code !== 0) {
      throw new Error(
        `native test ${testCase.name} failed\n${result.stdout}\n${result.stderr}`.trim(),
      );
    }
    results.push({
      name: testCase.name,
      status: "pass",
      stdout: result.stdout.trim(),
      sha256: await sha256File(output),
    });
  }
  return results;
}
