import type { McpToolUiDescriptor, PluginSandboxHandle } from "./contract.js";
import {
  MCP_APPS_CSP_RELAXATION_META_KEY,
  MCP_APPS_CSP_RELAXATION_META_KEY_CANONICAL,
  MCP_APPS_SET_WIDGET_STATE_METHOD,
  MCP_APPS_TRUNCATED_META_KEY,
  MCP_APPS_TRUNCATED_META_KEY_CANONICAL,
  PLUGIN_SANDBOX_PORT_NAME,
  buildMcpAppsClientCapabilities,
  buildMcpAppsCspExperimentalCapability,
} from "./contract.js";
import {
  buildMcpAppsExperimentalCapabilities,
  buildMcpAppsTruncatedMeta,
  buildMcpAppsWidgetStateContextEntries,
} from "./toolMeta.js";

/** 一个带 UI 资源的工具 `_meta` 归一化后应得到的描述。 */
export const exampleToolUiDescriptor: McpToolUiDescriptor = {
  resourceUri: "ui://example-plugin/widget.html",
  visibility: ["model", "app"],
  preferredDisplayMode: "inline",
  csp: { connectDomains: ["https://api.example.com"], resourceDomains: [] },
  prefersBorder: true,
};

/** main 登记成功后返回给 renderer 的句柄；partition 按 server 身份派生，同一 server 的页面共享。 */
export const exampleSandboxHandle: PluginSandboxHandle = {
  instance: {
    runtimeId: "test-agent",
    generation: 1,
    token: "test-token",
    appIdentity: "a".repeat(64),
  },
  sandboxId: "sb-01",
  initId: 1,
  shellUrl: "zcode-sandbox://shell-sb-01/",
  partition: "persist:plugin-sandbox-v1-0123456789abcdef",
  // 句柄能带的全部资源级字段都写上：contract.test 用它过 host 的 strict 回包 schema，字段漏同步会在这里失败。
  resourceMeta: {
    prefersBorder: true,
    heightHint: 320,
    minFrameHeight: 120,
    showInline: false,
    permissions: ["clipboardWrite"],
  },
};

/** agent 对 MCP server `initialize` 时宣告的 ui 扩展能力。 */
export const exampleClientCapabilities = buildMcpAppsClientCapabilities();
/** 宿主在 hostCapabilities.experimental 里宣告的 CSP 放宽键。 */
export const exampleCspExperimental = buildMcpAppsCspExperimentalCapability();
/** 资源级 `_meta` 里声明放宽的写法。 */
export const exampleResourceMetaWithRelaxations = {
  ui: { csp: { connectDomains: ["https://api.example.com"] } },
  [MCP_APPS_CSP_RELAXATION_META_KEY]: { unsafeEval: true },
};
export const exampleSetWidgetStateMethod = MCP_APPS_SET_WIDGET_STATE_METHOD;
export const examplePortName = PLUGIN_SANDBOX_PORT_NAME;
/** 过渡期宿主 experimental 双宣告（csp + widgetState + resourceSubscribe + surface）。 */
export const exampleExperimentalCapabilities = buildMcpAppsExperimentalCapabilities({
  canSetWidgetState: true,
  canSubscribeResources: true,
  surfaceId: "panel",
});
/** 资源 `_meta` 双键等值写法：同一放宽声明在 canonical 与 legacy 键上各一份。 */
export const exampleResourceMetaWithDualRelaxations = {
  [MCP_APPS_CSP_RELAXATION_META_KEY_CANONICAL]: { unsafeEval: true },
  [MCP_APPS_CSP_RELAXATION_META_KEY]: { unsafeEval: true },
};
/** hostContext 初值双键。 */
export const exampleWidgetStateContextEntries = buildMcpAppsWidgetStateContextEntries({
  tab: "chart",
});
/** 工具结果截断标记双键。 */
export const exampleTruncatedMeta = buildMcpAppsTruncatedMeta(2048);
export const exampleTruncatedMetaKeys = {
  canonical: MCP_APPS_TRUNCATED_META_KEY_CANONICAL,
  legacy: MCP_APPS_TRUNCATED_META_KEY,
};
