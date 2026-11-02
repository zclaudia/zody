// 兼容旧调用点：真正的 R11 构建由 controller 验收的 final-build 所有者实现。
// 这里只保留参数默认值与环境目录支持，不再包含 step1 的编译/清单逻辑。
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRound11Helper as buildFinalRound11Helper } from "./cua-helper-round11-final-build.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

export const OUTPUT_ROOT = resolve(
  process.env.CUA_HELPER_ROUND11_OUTPUT_ROOT ??
    resolve(REPO_ROOT, "output", "cua-helper-round11", "worker"),
);
export const VISUAL_OUTPUT_ROOT = resolve(
  process.env.CUA_HELPER_ROUND11_VISUAL_OUTPUT_ROOT ??
    resolve(REPO_ROOT, "output", "cua-helper-round11", "visual-worker"),
);

export function buildRound11Helper({
  outputRoot = OUTPUT_ROOT,
  visualRoot = VISUAL_OUTPUT_ROOT,
} = {}) {
  return buildFinalRound11Helper({ outputRoot, visualRoot });
}
