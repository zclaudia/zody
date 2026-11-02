// 用真实 capture_owner/AuthorityClient + fake visual ABI 编译并运行 stop harness。
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  FIXED_ARCH,
  FIXED_DEPLOYMENT_TARGET,
  NATIVE_ROOT,
  R10_NATIVE_ROOT,
  R11_NATIVE_ROOT,
} from "./cua-desktop-session-config.mjs";
import {
  compile,
  probeToolchain,
  run,
  sha256File,
} from "./cua-desktop-session-toolchain.mjs";
import { prepareSessionSourceStage } from "./cua-desktop-session-source.mjs";
import { STOP_VISUAL_OUTPUT_BOUNDARY } from "./cua-desktop-stop-visual-config.mjs";
import { stopBuildError } from "./cua-desktop-stop-visual-errors.mjs";

export function stopCaptureOwnerCompileArgs(
  toolchain,
  { srcDir, libRoot, testSource, output },
) {
  const sdk = toolchain.sdk.path;
  return [
    "-std=c++17",
    "-x",
    "objective-c++",
    "-fobjc-arc",
    "-arch",
    FIXED_ARCH,
    "-isysroot",
    sdk,
    `-mmacosx-version-min=${FIXED_DEPLOYMENT_TARGET}`,
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-DCUA_R11_HAVE_VISUAL",
    "-DCUA_R11_STOP_TEST_CALLBACK_RELEASE_TIMEOUT_MS=150",
    "-I",
    srcDir,
    "-I",
    libRoot,
    join(srcDir, "authority_client.mm"),
    join(srcDir, "capture_owner.mm"),
    join(srcDir, "machine_lease.mm"),
    testSource,
    "-L",
    join(sdk, "usr/lib/swift"),
    "-Wl,-rpath,/usr/lib/swift",
    "-liconv",
    "-lbsm",
    "-framework",
    "Foundation",
    "-framework",
    "Security",
    "-framework",
    "CoreFoundation",
    "-framework",
    "CoreGraphics",
    "-framework",
    "AppKit",
    "-framework",
    "ScreenCaptureKit",
    "-o",
    output,
  ];
}

export async function buildAndRunStopCaptureOwnerHarness({ outputRoot } = {}) {
  const root = resolve(
    outputRoot ?? join(STOP_VISUAL_OUTPUT_BOUNDARY, "stop-worker", "harness"),
  );
  const stageRoot = join(root, "work", "session-source");
  await rm(stageRoot, { recursive: true, force: true });
  const stage = await prepareSessionSourceStage({
    stageRoot,
    r11Root: R11_NATIVE_ROOT,
    r10Root: R10_NATIVE_ROOT,
  });
  const toolchain = await probeToolchain();
  const testRoot = join(root, "tests");
  await mkdir(testRoot, { recursive: true, mode: 0o700 });
  const output = join(testRoot, "stop-capture-owner");
  const args = stopCaptureOwnerCompileArgs(toolchain, {
    srcDir: stage.srcDir,
    libRoot: join(root, "lib"),
    testSource: join(NATIVE_ROOT, "tests", "stop_capture_owner_test.mm"),
    output,
  });
  await compile(toolchain, args, "stop-capture-owner", stage.srcDir);
  const result = await run(output, [], { timeoutMs: 30_000 });
  await writeFile(
    join(testRoot, "stop-capture-owner.log"),
    `${result.stdout}\n${result.stderr}\n`,
    { mode: 0o600 },
  );
  if (result.code !== 0) {
    throw stopBuildError(
      "native-harness",
      "stop capture_owner harness failed",
      {
        stdout: result.stdout,
        stderr: result.stderr,
      },
    );
  }
  return {
    status: "pass",
    path: output,
    sha256: await sha256File(output),
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}
