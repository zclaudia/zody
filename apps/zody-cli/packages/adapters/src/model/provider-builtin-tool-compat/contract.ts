/**
 * Provider 内置工具线协议兼容的公开入口（docs/provider-builtin-tool-rounds.md
 * 「Step ① adapters 流兼容层」）。只由 anthropic-stream-compat 在 Anthropic fetch 边界调用。
 * 来源：上游 a60ba6a7 provider-builtin-tool-compat/contract.ts。
 */
export {
  PROVIDER_BUILTIN_TOOL_SERVER_NAME,
  ProviderBuiltinToolStreamRewriter,
  rewriteProviderBuiltinToolContent,
} from "./compat.js";
export type { SseFrame } from "./compat.js";
