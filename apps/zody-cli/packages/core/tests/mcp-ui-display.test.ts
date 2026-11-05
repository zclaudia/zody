import {
  mcpToolDisplayUiPayloadSchema,
  ZODY_MCP_ERROR_PRESENTATION_MESSAGE_ONLY,
  ZODY_MCP_ERROR_PRESENTATION_META_KEY,
  ZODY_MCP_ERROR_PRESENTATION_META_KEY_CANONICAL,
} from "@zody/contracts";
import { mcpToolDisplayUiSchema } from "@zody/shared/mcp-apps";
import { describe, expect, it } from "vitest";
import { formatMcpToolResult } from "../src/mcp/index.js";

/**
 * 双侧 parse fixture 锁（R53）。
 *
 * `contracts/src/tools/tool-result-metadata.ts` 的 `mcpToolDisplayUiPayloadSchema` 是
 * `@zody/shared/mcp-apps` 的 `mcpToolDisplayUiSchema` 的手写镜像：CLI contracts 仍是 zod v3，
 * shared 是 zod v4，schema 对象不能直接复用，也不允许 CLI 生产代码反向 import shared 实现。
 * 这里用**同一 fixture** 在两侧各解析一次，锁住字段集合与接受/拒绝行为一致；生产侧真正落库的
 * display 由 contracts 的 schema 校验，UI 水合由 shared 的 schema 再校验一遍，两侧任何一侧漂移
 * 都会在这里失败。
 *
 * 这是测试文件对 shared schema 对象的只读 import：不构成生产依赖，也不复制 shared 的实现函数。
 */
const fixture = {
  pluginId: "plugin:demo:widget",
  resourceUri: "ui://demo/widget.html",
  preferredDisplayMode: "fullscreen",
  prefersBorder: true,
  csp: {
    connectDomains: ["https://api.example.test"],
    resourceDomains: ["https://cdn.example.test"],
  },
  structuredContent: '{"ok":true}',
  widgetMeta: '{"theme":"dark"}',
  content: '[{"type":"text","text":"ok"}]',
  truncated: true,
  truncatedBytes: 128,
  isError: true,
  showInline: true,
  surface: "demo-surface",
} as const;

describe("mcp tool display ui: contracts(zod v3) ↔ shared(zod v4) fixture lock", () => {
  it("parses the same fixture to the same value on both sides", () => {
    const cli = mcpToolDisplayUiPayloadSchema.safeParse(fixture);
    const shared = mcpToolDisplayUiSchema.safeParse(fixture);

    expect(cli.success).toBe(true);
    expect(shared.success).toBe(true);
    expect(cli.success && shared.success ? cli.data : undefined).toEqual(fixture);
    expect(cli.success && shared.success ? shared.data : undefined).toEqual(fixture);
  });

  it("carries exactly the same top-level field set", () => {
    expect(Object.keys(mcpToolDisplayUiPayloadSchema.shape).sort()).toEqual(
      Object.keys(mcpToolDisplayUiSchema.shape).sort(),
    );
    expect(Object.keys(mcpToolDisplayUiPayloadSchema.shape).sort()).toEqual([
      "content",
      "csp",
      "isError",
      "pluginId",
      "preferredDisplayMode",
      "prefersBorder",
      "resourceUri",
      "showInline",
      "structuredContent",
      "surface",
      "truncated",
      "truncatedBytes",
      "widgetMeta",
    ]);
  });

  it("rejects the same extra top-level key on both sides", () => {
    const extra = { ...fixture, widgetStateVisibility: "always" };
    expect(mcpToolDisplayUiPayloadSchema.safeParse(extra).success).toBe(false);
    expect(mcpToolDisplayUiSchema.safeParse(extra).success).toBe(false);
  });

  it("rejects the same out-of-range surface id on both sides", () => {
    const invalid = { ...fixture, surface: "not a surface id" };
    expect(mcpToolDisplayUiPayloadSchema.safeParse(invalid).success).toBe(false);
    expect(mcpToolDisplayUiSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects non-literal isError / showInline values on both sides", () => {
    for (const value of [
      { ...fixture, isError: false },
      { ...fixture, showInline: false },
    ]) {
      expect(mcpToolDisplayUiPayloadSchema.safeParse(value).success).toBe(false);
      expect(mcpToolDisplayUiSchema.safeParse(value).success).toBe(false);
    }
  });

  it("locks the known nested csp subset (CLI projection carries connect/resource only)", () => {
    // contracts 的 display 投影只透出 connectDomains/resourceDomains（frame/baseUri 不进卡片），
    // shared 的通用 schema 保留四类域。顶层字段集一致；这处嵌套差异是既有的投影约束，
    // 本单元不改写它，只在此显式登记，避免被误当成“漂移”。
    const cliCsp = mcpToolDisplayUiPayloadSchema.shape.csp.unwrap();
    const sharedCsp = mcpToolDisplayUiSchema.shape.csp.unwrap();
    expect(Object.keys(cliCsp.shape).sort()).toEqual(["connectDomains", "resourceDomains"]);
    expect(Object.keys(sharedCsp.shape).sort()).toEqual([
      "baseUriDomains",
      "connectDomains",
      "frameDomains",
      "resourceDomains",
    ]);
  });
});

/**
 * errorPresentation 的 live 入站边界（R53、spec §1.3/§2）。
 *
 * `formatMcpToolResult` 是模型通道上唯一消费该键的地方；它与历史回放共用 contracts 的
 * 同语义双键读取器。冲突只拒绝应用该字段：整条结果仍返回，只是退回通用 MCP 错误前缀
 * （不放宽成 message-only，也不丢结果）。
 */
describe("errorPresentation dual-key reading on the live MCP result boundary", () => {
  const failed = (meta: Record<string, unknown> | undefined) =>
    formatMcpToolResult({
      content: [{ type: "text", text: "tool failed" }],
      isError: true,
      _meta: meta,
    });

  it("honors message-only from either single representation", () => {
    expect(
      failed({ [ZODY_MCP_ERROR_PRESENTATION_META_KEY]: ZODY_MCP_ERROR_PRESENTATION_MESSAGE_ONLY }),
    ).toBe("tool failed");
    expect(
      failed({
        [ZODY_MCP_ERROR_PRESENTATION_META_KEY_CANONICAL]: ZODY_MCP_ERROR_PRESENTATION_MESSAGE_ONLY,
      }),
    ).toBe("tool failed");
  });

  it("honors equal dual representations once", () => {
    expect(
      failed({
        [ZODY_MCP_ERROR_PRESENTATION_META_KEY]: ZODY_MCP_ERROR_PRESENTATION_MESSAGE_ONLY,
        [ZODY_MCP_ERROR_PRESENTATION_META_KEY_CANONICAL]: ZODY_MCP_ERROR_PRESENTATION_MESSAGE_ONLY,
      }),
    ).toBe("tool failed");
  });

  it("rejects a conflicting field without dropping the result", () => {
    const content = failed({
      [ZODY_MCP_ERROR_PRESENTATION_META_KEY]: ZODY_MCP_ERROR_PRESENTATION_MESSAGE_ONLY,
      [ZODY_MCP_ERROR_PRESENTATION_META_KEY_CANONICAL]: "stack-trace",
    });
    // 结果本身保留；退回通用前缀，说明该字段未被应用。
    expect(content).toBe("MCP tool returned an error:\ntool failed");
  });

  it("falls back to the generic prefix for an unknown or malformed single value", () => {
    expect(failed({ [ZODY_MCP_ERROR_PRESENTATION_META_KEY_CANONICAL]: 42 })).toBe(
      "MCP tool returned an error:\ntool failed",
    );
    expect(failed({ [ZODY_MCP_ERROR_PRESENTATION_META_KEY]: "stack-trace" })).toBe(
      "MCP tool returned an error:\ntool failed",
    );
    expect(failed(undefined)).toBe("MCP tool returned an error:\ntool failed");
  });

  it("leaves successful results untouched regardless of the field", () => {
    expect(
      formatMcpToolResult({
        content: [{ type: "text", text: "ok" }],
        _meta: {
          [ZODY_MCP_ERROR_PRESENTATION_META_KEY]: ZODY_MCP_ERROR_PRESENTATION_MESSAGE_ONLY,
          [ZODY_MCP_ERROR_PRESENTATION_META_KEY_CANONICAL]: "stack-trace",
        },
      }),
    ).toBe("ok");
  });
});
