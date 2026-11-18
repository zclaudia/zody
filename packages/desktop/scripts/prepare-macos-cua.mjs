#!/usr/bin/env node
// CI 与人工准备命令使用实际构建同一入口；不签名、不运行App或SDK。
import { resolveMacosCuaDemoBuildSelection } from "./macos-cua-build-selection.mjs";
import { getTargetPlatform } from "./target-platform.mjs";

try {
  const target = getTargetPlatform();
  const selection = await resolveMacosCuaDemoBuildSelection({
    targetOs: target.os,
    targetArch: target.arch,
  });
  process.stdout.write(
    `${JSON.stringify({
      status: selection ? "ready" : "skipped",
      target: target.key,
      manifestSha256: selection?.manifestSha256 ?? null,
      source: selection?.source ?? null,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(`[prepare:macos-cua] ${error.message}\n`);
  process.exitCode = 1;
}
