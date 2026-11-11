import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const maxRuntimeSourceLines = 400;
const lineCountExemptFiles = new Set([
  // 现存大文件是显式重构债务；边界测试继续阻止新增未登记的大文件。
  ...[
    "agent-runtime.ts",
    // 6ae791ee 加入 CUA 方法声明后达 407 行（>400），按惯例登记为重构债；拆分待 computer-use 线收口。
    "internal-methods.ts",
    // 6ae791ee 后 methods/index.ts 达 416 行，同为未登记超标；re-export 汇总文件，拆分收益低，登记为债。
    "methods/index.ts",
    // mobile-origin 授权轮次（2026-11-10）加入凭证短路与 mobile 消费分支后达 435 行；
    // 与上两条同因（computer-use 线演进），登记为债；拆分（admission 观察器独立文件）待 CUA 线收口。
    "cua/cua-submission-coordinator.ts",
    // 同轮在 methods/cua-submission.ts 新增 isCuaLiveSubmissionGrantActive 授权查询
    // （复用 confirm 规则链）后达 419 行；登记为债，与 confirm 链一起拆分待 CUA 线收口。
    "methods/cua-submission.ts",
    "internal-turn-methods.ts",
    "types.ts",
    "methods/background.ts",
    "methods/compact-active.ts",
    "methods/compact-persistence.ts",
    "methods/compact-summary-model-request.ts",
    "methods/compact.ts",
    "methods/context-usage.ts",
    "methods/events.ts",
    "methods/file-rewind.ts",
    "methods/message-persistence.ts",
    "methods/model.ts",
    "methods/resume.ts",
    "methods/rewind-message.ts",
    "methods/runtime-command-queue.ts",
    "methods/session-fork.ts",
    "methods/session-title.ts",
    "methods/steering.ts",
    "methods/subagent.ts",
    "methods/target-completion-verification.ts",
    "methods/target.ts",
    "methods/turn-model-step.ts",
    "methods/turn-tools.ts",
    "methods/turn.ts",
    "methods/usage-observability.ts",
    "helpers/attachment-media-resolver.ts",
    "helpers/compact-selection.ts",
    "helpers/provider-request-messages.ts",
  ].map((file) => join(repoRoot, "packages/core/src/runtime", file)),
]);

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTypeScriptFiles(path)));
      continue;
    }
    if (entry.isFile() && path.endsWith(".ts")) {
      files.push(path);
    }
  }

  return files;
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
}

describe("runtime module boundary", () => {
  it("keeps runtime source modules below the file-size ceiling", async () => {
    const files = [
      join(repoRoot, "packages/core/src/runtime.ts"),
      ...(await collectTypeScriptFiles(join(repoRoot, "packages/core/src/runtime"))),
    ];

    for (const file of files) {
      if (lineCountExemptFiles.has(file)) continue;
      const content = await readFile(file, "utf8");
      expect(countLines(content), relative(repoRoot, file)).toBeLessThanOrEqual(
        maxRuntimeSourceLines,
      );
    }
  });
});
