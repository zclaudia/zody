// 从 @zcode/core 根 barrel 导入会让 esbuild 追踪具有顶层副作用的 Agent/tool 模块，
// 把 Bash registry、subagent 和 runtime 一起打进官方插件。Browser 发布物只能依赖窄 subpath。
import { setupBrowserRuntime as setupCoreBrowserRuntime } from "@zcode/core/browser-client";
import { readNodeReplBrowserRuntimeBridge } from "@zcode/node-repl-host/runtime-bridge";

export async function setupBrowserRuntime(input: {
  globals: Record<PropertyKey, unknown>;
}): Promise<void> {
  const bridge = readNodeReplBrowserRuntimeBridge(input.globals);
  bridge.assertAvailable();
  // 默认 backend 由设置页写入、Host 经协议返回；缺省时仍由 selection 规则选择 IAB。
  // 读取设置失败不能阻断 browser runtime 初始化；后续 list/execute 仍会暴露真实不可用。
  const defaultBrowserId = await bridge.getDefaultBrowserId?.().catch(() => undefined);
  bridge.assertAvailable();
  setupCoreBrowserRuntime({
    globals: input.globals as Record<string, unknown>,
    transport: bridge,
    documentationRoot: bridge.documentationRoot,
    assertAvailable: bridge.assertAvailable,
    ...(defaultBrowserId ? { defaultBrowserId } : {}),
  });
}
