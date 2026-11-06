import { describe, expect, it } from "vitest";
import {
  MCP_APPS_EXTENSION_ID,
  MCP_APPS_RESOURCE_MIME_TYPE,
  MCP_APPS_UI_RESOURCE_SCHEME,
  MCP_APPS_LEGACY_RESOURCE_URI_META_KEY,
  MCP_APPS_CSP_RELAXATION_META_KEY,
  MCP_APPS_CSP_RELAXATION_META_KEY_CANONICAL,
  MCP_APPS_TRUNCATED_META_KEY,
  MCP_APPS_TRUNCATED_META_KEY_CANONICAL,
  MCP_APPS_WIDGET_STATE_EXPERIMENTAL_KEY,
  MCP_APPS_WIDGET_STATE_EXPERIMENTAL_KEY_CANONICAL,
  MCP_APPS_RESOURCE_SUBSCRIBE_EXPERIMENTAL_KEY,
  MCP_APPS_RESOURCE_SUBSCRIBE_EXPERIMENTAL_KEY_CANONICAL,
  MCP_APPS_SURFACE_EXPERIMENTAL_KEY,
  MCP_APPS_SURFACE_EXPERIMENTAL_KEY_CANONICAL,
  MCP_APPS_WIDGET_STATE_CONTEXT_KEY,
  MCP_APPS_WIDGET_STATE_CONTEXT_KEY_CANONICAL,
  buildMcpAppsClientCapabilities,
  buildMcpAppsCspExperimentalCapability,
  isMcpAppsUiReadResourceMimeAllowed,
} from "./contract.js";
import {
  MCP_APPS_META_KEY_COMPAT,
  buildMcpAppsExperimentalCapabilities,
  buildMcpAppsTruncatedMeta,
  buildMcpAppsWidgetStateContextEntries,
  normalizeMcpAppCspRelaxations,
  normalizeMcpToolUiMeta,
  readMcpAppsMetaEntry,
  resolveMcpAppsCspRelaxations,
} from "./toolMeta.js";
import { normalizeMcpAppResourceMeta } from "./resourceMeta.js";
import {
  exampleClientCapabilities,
  exampleResourceMetaWithRelaxations,
  exampleSandboxHandle,
  exampleToolUiDescriptor,
  exampleTruncatedMeta,
} from "./contract.example.js";

describe("mcp-apps-protocol contract", () => {
  it.each([
    ["PDF 文档", " Application/PDF ; version=1.7 "],
    ["办公文档", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["电子表格", "application/vnd.ms-excel"],
    ["开放演示文档", "application/vnd.oasis.opendocument.presentation"],
    ["矢量图片", "image/svg+xml; charset=utf-8"],
    ["相机图片", "image/heic"],
    ["动画图片", "image/gif"],
    ["音频", "audio/mpeg"],
    ["WAV 别名", "audio/x-wav"],
    ["视频", "video/mp4"],
    ["归档", "application/zip"],
    ["GZIP 别名", "application/x-gzip"],
    ["字体", "font/woff2"],
    ["结构化数据", "application/yaml"],
    ["JSON 模型", "model/gltf+json"],
    ["已有文本前缀", "text/csv; charset=utf-8"],
    ["已有二进制", "application/octet-stream"],
    ["已有模型", "model/gltf-binary"],
  ])("页面资源接纳%s（%s）", (_label, mimeType) => {
    expect(isMcpAppsUiReadResourceMimeAllowed(mimeType)).toBe(true);
  });

  it.each([
    "application/x-msdownload",
    "application/x-executable",
    "application/vnd.example.unknown",
    "image/x-example-unknown",
    "application/pdf-malware",
    "application/pdf,application/x-msdownload",
    "",
    " ; charset=utf-8",
  ])("资源扩容仍拒绝未知或不合法 MIME：%s", (mimeType) => {
    expect(isMcpAppsUiReadResourceMimeAllowed(mimeType)).toBe(false);
  });

  it("扩展标识与 UI 资源 mimeType 与官方 SDK 常量一致", () => {
    expect(MCP_APPS_EXTENSION_ID).toBe("io.modelcontextprotocol/ui");
    expect(MCP_APPS_RESOURCE_MIME_TYPE).toBe("text/html;profile=mcp-app");
    expect(MCP_APPS_LEGACY_RESOURCE_URI_META_KEY).toBe("ui/resourceUri");
    expect(buildMcpAppsClientCapabilities()).toEqual(exampleClientCapabilities);
  });

  it("resourceUri 同时接受标准键、弃用扁平键与 openai/outputTemplate", () => {
    expect(normalizeMcpToolUiMeta({ ui: { resourceUri: "ui://a/b" } })?.resourceUri).toBe(
      "ui://a/b",
    );
    expect(normalizeMcpToolUiMeta({ "ui/resourceUri": "ui://a/c" })?.resourceUri).toBe("ui://a/c");
    expect(normalizeMcpToolUiMeta({ "openai/outputTemplate": "ui://a/d" })?.resourceUri).toBe(
      "ui://a/d",
    );
    expect(normalizeMcpToolUiMeta({ ui: { resourceUri: "https://a/b" } })).toBeNull();
  });

  it("zcode/csp 只认已知布尔键", () => {
    expect(normalizeMcpAppCspRelaxations(exampleResourceMetaWithRelaxations)).toEqual({
      unsafeEval: true,
    });
    expect(normalizeMcpAppCspRelaxations({ "zcode/csp": { unsafeEval: false, other: true } })).toBe(
      null,
    );
  });

  it("示例描述与句柄满足契约形状", () => {
    expect(exampleToolUiDescriptor.resourceUri.startsWith(MCP_APPS_UI_RESOURCE_SCHEME)).toBe(true);
    expect(exampleSandboxHandle.shellUrl).toBe(
      `zcode-sandbox://shell-${exampleSandboxHandle.sandboxId}/`,
    );
    expect(exampleSandboxHandle.partition.startsWith("persist:plugin-sandbox-")).toBe(true);
  });
});

const MCP_APPS_WIRE_LITERALS: ReadonlyArray<readonly [string, string]> = [
  [MCP_APPS_CSP_RELAXATION_META_KEY, "zcode/csp"],
  [MCP_APPS_CSP_RELAXATION_META_KEY_CANONICAL, "zody/csp"],
  [MCP_APPS_TRUNCATED_META_KEY, "zcode/truncated"],
  [MCP_APPS_TRUNCATED_META_KEY_CANONICAL, "zody/truncated"],
  [MCP_APPS_WIDGET_STATE_EXPERIMENTAL_KEY, "zcode/widgetState"],
  [MCP_APPS_WIDGET_STATE_EXPERIMENTAL_KEY_CANONICAL, "zody/widgetState"],
  [MCP_APPS_RESOURCE_SUBSCRIBE_EXPERIMENTAL_KEY, "zcode/resourceSubscribe"],
  [MCP_APPS_RESOURCE_SUBSCRIBE_EXPERIMENTAL_KEY_CANONICAL, "zody/resourceSubscribe"],
  [MCP_APPS_SURFACE_EXPERIMENTAL_KEY, "zcode/surface"],
  [MCP_APPS_SURFACE_EXPERIMENTAL_KEY_CANONICAL, "zody/surface"],
  [MCP_APPS_WIDGET_STATE_CONTEXT_KEY, "zcode/widgetState"],
  [MCP_APPS_WIDGET_STATE_CONTEXT_KEY_CANONICAL, "zody/widgetState"],
];

const MCP_APPS_KEY_MATRIX = Object.entries(MCP_APPS_META_KEY_COMPAT);

/** 通用矩阵 parser：任意对象都算合法，只验证读取器本身的双键/冲突语义。 */
const parseJsonValue = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

describe("MCP Apps 双命名空间兼容（R50）", () => {
  it("legacy/canonical wire 字面值字节锁定", () => {
    for (const [actual, expected] of MCP_APPS_WIRE_LITERALS) expect(actual).toBe(expected);
  });

  it("键对注册表覆盖 5 个登记键且方向与 fail-closed 与 spec 一致", () => {
    expect(Object.keys(MCP_APPS_META_KEY_COMPAT)).toEqual([
      "csp",
      "truncated",
      "widgetState",
      "resourceSubscribe",
      "surface",
    ]);
    for (const pair of Object.values(MCP_APPS_META_KEY_COMPAT)) {
      expect(pair.canonical.startsWith("zody/")).toBe(true);
      expect(pair.legacy.startsWith("zcode/")).toBe(true);
    }
    expect(MCP_APPS_META_KEY_COMPAT.csp).toMatchObject({
      direction: "bidirectional",
      failClosed: true,
    });
    expect(MCP_APPS_META_KEY_COMPAT.truncated.failClosed).toBe(false);
  });

  it.each(MCP_APPS_KEY_MATRIX)("双键读取矩阵（%s）", (_id, pair) => {
    const value = { marker: _id };
    const other = { marker: `${_id}-other` };
    expect(readMcpAppsMetaEntry({}, pair, parseJsonValue)).toEqual({ status: "absent" });
    expect(readMcpAppsMetaEntry({ [pair.canonical]: value }, pair, parseJsonValue)).toEqual({
      status: "accepted",
      value,
      source: "canonical",
    });
    expect(readMcpAppsMetaEntry({ [pair.legacy]: value }, pair, parseJsonValue)).toEqual({
      status: "accepted",
      value,
      source: "legacy",
    });
    expect(
      readMcpAppsMetaEntry({ [pair.canonical]: value, [pair.legacy]: value }, pair, parseJsonValue),
    ).toEqual({ status: "accepted", value, source: "both" });
    expect(
      readMcpAppsMetaEntry({ [pair.canonical]: value, [pair.legacy]: other }, pair, parseJsonValue),
    ).toEqual({
      status: "conflict",
      canonicalKey: pair.canonical,
      legacyKey: pair.legacy,
      canonical: value,
      legacy: other,
    });
    // 双键任一侧非法按冲突处理，不放行可用的一侧（单键非法仍视作未声明）。
    expect(
      readMcpAppsMetaEntry(
        { [pair.canonical]: value, [pair.legacy]: "invalid" },
        pair,
        parseJsonValue,
      ).status,
    ).toBe("conflict");
  });

  it("CSP 双键等值接受、冲突 fail-closed（权限不扩大）", () => {
    const conflict = {
      [MCP_APPS_CSP_RELAXATION_META_KEY_CANONICAL]: { unsafeEval: true },
      [MCP_APPS_CSP_RELAXATION_META_KEY]: { unsafeEval: false },
    };
    expect(
      resolveMcpAppsCspRelaxations({ [MCP_APPS_CSP_RELAXATION_META_KEY]: { unsafeEval: true } }),
    ).toEqual({ status: "accepted", value: { unsafeEval: true } });
    expect(
      resolveMcpAppsCspRelaxations({
        [MCP_APPS_CSP_RELAXATION_META_KEY_CANONICAL]: { wasmUnsafeEval: true },
      }),
    ).toEqual({ status: "accepted", value: { wasmUnsafeEval: true } });
    // 归一化相等（false 等于未声明）即接受，不按原始 JSON 字面比较。
    expect(
      resolveMcpAppsCspRelaxations({
        [MCP_APPS_CSP_RELAXATION_META_KEY_CANONICAL]: { unsafeEval: true },
        [MCP_APPS_CSP_RELAXATION_META_KEY]: { unsafeEval: true, wasmUnsafeEval: false },
      }),
    ).toEqual({ status: "accepted", value: { unsafeEval: true } });
    expect(resolveMcpAppsCspRelaxations(conflict)).toEqual({
      status: "conflict",
      canonical: { unsafeEval: true },
      legacy: { unsafeEval: false },
    });
    expect(normalizeMcpAppCspRelaxations(conflict)).toBeNull();
    expect(normalizeMcpAppResourceMeta(conflict)?.cspRelaxations).toBeUndefined();
    // 一侧不可用也是冲突：不得用另一侧的 true 放行 eval。
    expect(
      normalizeMcpAppCspRelaxations({
        [MCP_APPS_CSP_RELAXATION_META_KEY_CANONICAL]: { unsafeEval: true },
        [MCP_APPS_CSP_RELAXATION_META_KEY]: { unsafeEval: "yes" },
      }),
    ).toBeNull();
  });

  it("出站 helper 从同一输入生成等值双表示", () => {
    const capabilities = buildMcpAppsExperimentalCapabilities({
      canSetWidgetState: true,
      canSubscribeResources: true,
      surfaceId: "panel",
    });
    expect(Object.keys(capabilities)).toHaveLength(8);
    expect(capabilities[MCP_APPS_WIDGET_STATE_EXPERIMENTAL_KEY_CANONICAL]).toBe(
      capabilities[MCP_APPS_WIDGET_STATE_EXPERIMENTAL_KEY],
    );
    expect(capabilities[MCP_APPS_RESOURCE_SUBSCRIBE_EXPERIMENTAL_KEY_CANONICAL]).toBe(
      capabilities[MCP_APPS_RESOURCE_SUBSCRIBE_EXPERIMENTAL_KEY],
    );
    expect(capabilities[MCP_APPS_SURFACE_EXPERIMENTAL_KEY]).toEqual({ id: "panel" });
    expect(capabilities[MCP_APPS_CSP_RELAXATION_META_KEY]).toEqual(
      buildMcpAppsCspExperimentalCapability()[MCP_APPS_CSP_RELAXATION_META_KEY],
    );
    const minimal = buildMcpAppsExperimentalCapabilities({
      canSetWidgetState: false,
      canSubscribeResources: false,
    });
    expect(Object.keys(minimal)).toHaveLength(2);
    const context = buildMcpAppsWidgetStateContextEntries({ tab: "chart" });
    expect(context[MCP_APPS_WIDGET_STATE_CONTEXT_KEY]).toBe(
      context[MCP_APPS_WIDGET_STATE_CONTEXT_KEY_CANONICAL],
    );
    const truncated = buildMcpAppsTruncatedMeta(2048);
    expect(truncated[MCP_APPS_TRUNCATED_META_KEY]).toBe(
      truncated[MCP_APPS_TRUNCATED_META_KEY_CANONICAL],
    );
    expect(exampleTruncatedMeta[MCP_APPS_TRUNCATED_META_KEY]).toEqual({ bytes: 2048 });
  });

  it("未登记 zcode/* 键不被读取或改写（不做前缀泛化）", () => {
    const unknown = {
      "zcode/csp-extra": { unsafeEval: true },
      "zcode/unknown": { bytes: 1 },
      ui: { resourceUri: "ui://a/b" },
    };
    const snapshot = structuredClone(unknown);
    expect(normalizeMcpAppCspRelaxations(unknown)).toBeNull();
    expect(normalizeMcpAppResourceMeta(unknown)).toBeNull();
    expect(normalizeMcpToolUiMeta(unknown)).toEqual({
      resourceUri: "ui://a/b",
      visibility: ["model", "app"],
    });
    expect(unknown).toEqual(snapshot);
  });

  // F18（上游 a60ba6a7）：后台保留声明只认资源级 _meta.ui.backgroundRetention 布尔；
  // 顶层键与工具级 metadata 都不授予（docs/plugin-ui-background-execution.md §12.2.2）。
  it("只归一化资源级 _meta.ui.backgroundRetention 布尔，工具级不授予", () => {
    const meta = (ui: unknown) => normalizeMcpAppResourceMeta({ ui });
    expect(meta({ backgroundRetention: true })).toEqual({ backgroundRetention: true });
    expect(meta({ backgroundRetention: false })).toEqual({ backgroundRetention: false });
    expect(meta({ backgroundRetention: "yes" })).toBeNull();
    expect(normalizeMcpAppResourceMeta({ backgroundRetention: true })).toBeNull();
    expect(
      normalizeMcpToolUiMeta({ ui: { resourceUri: "ui://a/b", backgroundRetention: true } }),
    ).not.toHaveProperty("backgroundRetention");
  });
});
