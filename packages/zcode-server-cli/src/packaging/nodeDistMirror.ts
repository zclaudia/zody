/**
 * Node dist 下载源的唯一解析点（本包内）。
 *
 * 默认使用官方 `https://nodejs.org/dist`；需要镜像时用 `ZCODE_NODE_DIST_MIRROR` 显式覆盖，例如
 * `ZCODE_NODE_DIST_MIRROR=https://cdn.npmmirror.com/binaries/node`。
 * 与 `scripts/prepare-prebuilds.mjs` 的 `nodeDistBase()` 是同一约定和同一默认值，两处必须保持一致。
 *
 * 修改原因：Zody 首发规格要求默认官方下载源，镜像只能显式启用
 * （specs/zody-brand-residual-cleanup.md「下载镜像」）；连不上 nodejs.org 的 runner 通过环境变量覆盖。
 *
 * 单独成模块而不是留在 stageCli.ts：后者末尾是顶层 `await main()`，import 即执行，
 * 无法在测试里引用。
 */
export const DEFAULT_NODE_DIST_BASE = "https://nodejs.org/dist";

export function resolveNodeDistBase(env: NodeJS.ProcessEnv = process.env): string {
  const mirror = env.ZCODE_NODE_DIST_MIRROR?.trim();
  return (mirror || DEFAULT_NODE_DIST_BASE).replace(/\/+$/u, "");
}
