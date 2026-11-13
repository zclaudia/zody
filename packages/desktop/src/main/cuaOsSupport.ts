import { release } from "node:os";
import type { CuaOsSupport } from "@zody/shared";

// 承诺地板 = 随包窄链 Desktop Session.app 的 target.minimumMacOSVersion（14.2）。
// 2026-11-09 分发轮次：CUA 能力面收敛为窄链，旧宽链 Helper 的 12.0 地板不再适用；
// 该值与 cuaNarrowAgentProfile.ts 的 CUA_NARROW_MINIMUM_MACOS_VERSION、
// macos-cua-narrow-resources-constants.mjs 的 NARROW_TARGET 同步维护。
export const CUA_MINIMUM_MACOS_VERSION = "14.2";
const CUA_MINIMUM_DARWIN_MAJOR = 23; // Darwin major - 9 = macOS major（23↔14, 24↔15）

export function darwinMajorToMacosMajor(major: number): number {
  return major - 9;
}

export function resolveCuaOsSupport(
  platform = process.platform,
  darwinRelease = release(),
): CuaOsSupport {
  if (platform !== "darwin") return { kind: "not-applicable" };
  const major = Number.parseInt(darwinRelease.split(".")[0] ?? "0", 10);
  if (Number.isNaN(major)) return { kind: "supported" };
  if (major < CUA_MINIMUM_DARWIN_MAJOR) {
    return {
      kind: "macos-below-minimum",
      minimumMacOs: CUA_MINIMUM_MACOS_VERSION,
      currentMacOs: String(darwinMajorToMacosMajor(major)),
    };
  }
  return { kind: "supported" };
}
