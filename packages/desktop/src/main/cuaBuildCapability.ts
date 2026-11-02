import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CuaBuildCapability } from "@zody/shared";

// 打包后窄资源槽位：electron-builder extraResources 把 cua-narrow/manifest.json 落在
// Resources 根（仅 darwin 分支装配），afterPack 的 assertPackagedCuaNarrowResource 校验
// 同一事实。这里只做存在性判定，不复述 manifest 校验——Main 不需要解析其内容。
const CUA_NARROW_SLOT_DIR = "cua-narrow";
const CUA_NARROW_MANIFEST = "manifest.json";

// 窄链当前唯一已实测的工具面（对应构建 profile 的 capability screenshot.single-window）。
// 呈现「打包了窄资源 ≠ 当前会话可用」的边界由消费方文案负责，这里不掺 eligibility 判定。
const NARROW_CAPABILITIES = ["screenshot.single-window"];

export function resolveCuaBuildCapability({
  isPackaged,
  resourcesPath,
}: {
  isPackaged: boolean;
  resourcesPath: string;
}): CuaBuildCapability {
  // dev 模式无打包资源，一律按占位呈现（fail-closed），与官方占位构建口径一致。
  if (!isPackaged) return { kind: "placeholder" };
  const manifestPath = join(resourcesPath, CUA_NARROW_SLOT_DIR, CUA_NARROW_MANIFEST);
  if (!existsSync(manifestPath)) return { kind: "placeholder" };
  return { kind: "narrow", capabilities: [...NARROW_CAPABILITIES] };
}
