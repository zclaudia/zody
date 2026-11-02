/**
 * darwin 组合候选的平台裁剪占位，不是“koffi 成功可用”的实现。
 *
 * controller 已核实的唯一运行时引用都在 win32-only 分支之后：
 *   - apps/zcode-cli/packages/adapters/src/mcp/windows-job-object.ts:31
 *     `(options.platform ?? process.platform) !== "win32"` 直接 return，
 *     动态 `import("koffi")` 在其后的 createWindowsJobObjectApi 内。
 *   - apps/zcode-cli/packages/adapters/src/mcp/stdio-transport.ts:96
 *     同样有 win32 guard 后才懒加载 koffi。
 *
 * 本候选是 darwin arm64 专用（entry 显式拒绝其它 platform/arch）；把该 win32-only FFI
 * 显式裁剪成“不可用”占位，保持 sealed bundle 不引用外部 `.node`/DYLD，也不冒充完整
 * CLI 等价或绕过 macOS 原生依赖。macOS 侧真正用到的原生能力（node:sqlite 等）仍由
 * 固定签名 Node 提供，未在此裁剪。
 */
throw new Error(
  "koffi is a win32-only FFI dynamic import; the darwin native composition candidate trims it",
);
