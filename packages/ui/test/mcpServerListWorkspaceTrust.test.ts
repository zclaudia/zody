// @vitest-environment jsdom

import type { ZodyMcpServer, ZodyWorkspaceMcpTrustResult } from "@zody/shared";
import {
  TID_MCP_WORKSPACE_REVOKE_BUTTON,
  TID_MCP_WORKSPACE_TRUST_BUTTON,
  TID_MCP_WORKSPACE_TRUST_SUMMARY,
} from "@zody/shared";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZodyIntlProvider } from "@/i18n/IntlProvider.js";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import { McpServerList } from "@/settings/McpServerList.js";
import {
  resolveWorkspaceMcpTrustReasonMessageId,
  resolveWorkspaceMcpTrustTarget,
} from "@/settings/workspaceMcpTrustActions.js";

// fork（F23，上游 a60ba6a7）：workspace MCP 信任门横幅 B——设置页行级信任状态
// （spec docs/specs/workspace-mcp-trust.md §8.2/§8.3）。

const DIGEST = "a".repeat(64);

function serverWithReview(trusted: boolean, overrides: Partial<ZodyMcpServer> = {}): ZodyMcpServer {
  return {
    id: `zcodeagentmcp:${trusted ? "trusted" : "pending"}`,
    name: trusted ? "trusted" : "pending",
    config: { command: "node", args: ["server.js"] },
    enabled: true,
    source: "zcodeagentmcp",
    scope: "workspace",
    status: "unknown",
    error: "Workspace MCP server is pending trust review.",
    failureKind: "status_unavailable",
    toolCount: 0,
    workspaceTrust: {
      declarationDigest: DIGEST,
      sourcePaths: ["/ws/.zody/config.json"],
      // 脱敏 display：只有命令行、cwd 与 env 键名（A10 由 Host 侧构造保证）。
      display: '{\n  "command": "node server.js",\n  "cwd": "/ws",\n  "env": ["TOKEN"]\n}',
      trusted,
      configuredEnabled: true,
      transport: "stdio",
    },
    ...overrides,
  };
}

function plainServer(): ZodyMcpServer {
  return {
    id: "zcodeagentmcp:personal",
    name: "personal",
    config: { command: "node" },
    enabled: true,
    source: "zcodeagentmcp",
    scope: "user",
  };
}

function renderList(
  servers: ZodyMcpServer[],
  onWorkspaceTrust?: (server: ZodyMcpServer, trusted: boolean) => void | Promise<void>,
) {
  return render(
    createElement(
      ZodyIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        TooltipProvider,
        null,
        createElement(McpServerList, {
          servers,
          onCreate: () => undefined,
          onEdit: () => undefined,
          onToggle: () => undefined,
          onWorkspaceTrust,
          emptyTitle: "empty",
          emptyDescription: "empty",
        }),
      ),
    ),
  );
}

afterEach(() => cleanup());

describe("McpServerList workspace 信任行（F23 横幅 B）", () => {
  it("未信任行：展示脱敏声明摘要与待信任标签，[信任] 点击回传 (server, true)", () => {
    const onWorkspaceTrust = vi.fn(async () => undefined);
    const pending = serverWithReview(false);
    renderList([pending], onWorkspaceTrust);

    const summary = screen.getByTestId(`${TID_MCP_WORKSPACE_TRUST_SUMMARY}-pending`);
    expect(summary.textContent).toContain("node server.js");
    expect(summary.textContent).toContain("TOKEN");
    expect(summary.textContent).toContain("待信任");
    // 脱敏摘要只含 env 键名；密钥值不得出现（display 由 Host 脱敏，UI 原样投影）。
    expect(summary.textContent).not.toContain("super-secret");

    fireEvent.click(screen.getByTestId(`${TID_MCP_WORKSPACE_TRUST_BUTTON}-pending`));
    expect(onWorkspaceTrust).toHaveBeenCalledWith(pending, true);
  });

  it("已信任行：[撤销] 点击回传 (server, false)，且撤销生效边界文案可见（A1/§8.2）", () => {
    const onWorkspaceTrust = vi.fn(async () => undefined);
    const trusted = serverWithReview(true);
    renderList([trusted], onWorkspaceTrust);

    expect(screen.getByTestId(`${TID_MCP_WORKSPACE_REVOKE_BUTTON}-trusted`)).toBeTruthy();
    // 生效边界必须可见（不能只藏在 tooltip）：撤销在新建/重启会话后生效。
    expect(screen.getByText("撤销在新建/重启会话后生效。")).toBeTruthy();

    fireEvent.click(screen.getByTestId(`${TID_MCP_WORKSPACE_REVOKE_BUTTON}-trusted`));
    expect(onWorkspaceTrust).toHaveBeenCalledWith(trusted, false);
  });

  it("未注入动作服务（wiring 未落地）时不渲染信任/撤销按钮，摘要与状态仍展示", () => {
    renderList([serverWithReview(false)]);
    expect(screen.queryByTestId(`${TID_MCP_WORKSPACE_TRUST_BUTTON}-pending`)).toBeNull();
    expect(screen.queryByTestId(`${TID_MCP_WORKSPACE_REVOKE_BUTTON}-pending`)).toBeNull();
    expect(screen.getByTestId(`${TID_MCP_WORKSPACE_TRUST_SUMMARY}-pending`)).toBeTruthy();
  });

  it("非 workspace 声明行（无审核摘要）不出现信任 UI（A6 来源豁免的 UI 面）", () => {
    renderList([plainServer()], () => undefined);
    expect(screen.queryByTestId(`${TID_MCP_WORKSPACE_TRUST_SUMMARY}-personal`)).toBeNull();
    expect(screen.queryByTestId(`${TID_MCP_WORKSPACE_TRUST_BUTTON}-personal`)).toBeNull();
  });

  it("i18n key zh/en 双侧存在且撤销边界文案齐备（A9 parity）", () => {
    const keys = [
      "settings.mcp.trust.pendingLabel",
      "settings.mcp.trust.pendingReason",
      "settings.mcp.trust.trustAction",
      "settings.mcp.trust.revokeAction",
      "settings.mcp.trust.revokeBoundary",
      "settings.mcp.trust.rejectedDeclarationChanged",
      "settings.mcp.trust.rejectedUnavailable",
    ];
    for (const key of keys) {
      expect(zhCN[key], `zh-CN 缺 ${key}`).toBeTruthy();
      expect(enUS[key], `en-US 缺 ${key}`).toBeTruthy();
    }
    expect(zhCN["settings.mcp.trust.revokeBoundary"]).toContain("新建/重启会话");
    expect(enUS["settings.mcp.trust.revokeBoundary"]).toContain("new or restarted sessions");
  });
});

describe("resolveWorkspaceMcpTrustTarget / 拒绝原因文案（决策输入绑定）", () => {
  it("无审核摘要（非 workspace 声明）不得发起决策", () => {
    expect(resolveWorkspaceMcpTrustTarget(plainServer(), "/ws", true)).toBeNull();
    expect(resolveWorkspaceMcpTrustTarget(serverWithReview(false), null, true)).toBeNull();
  });

  it("决策输入绑定精确声明摘要与目标 workspace 身份（S2 逐条 digest）", () => {
    const target = resolveWorkspaceMcpTrustTarget(
      serverWithReview(false),
      "/ws",
      true,
      "identity-1",
    );
    expect(target).toEqual({
      workspacePath: "/ws",
      workspaceIdentity: "identity-1",
      serverName: "pending",
      declarationDigest: DIGEST,
      trusted: true,
    });
    const revoke = resolveWorkspaceMcpTrustTarget(serverWithReview(true), "/ws", false);
    expect(revoke?.trusted).toBe(false);
  });

  it("拒绝原因映射到 i18n id（未登记原因兜底 unavailable）", () => {
    expect(resolveWorkspaceMcpTrustReasonMessageId("workspace_mcp_declaration_changed")).toBe(
      "settings.mcp.trust.rejectedDeclarationChanged",
    );
    expect(resolveWorkspaceMcpTrustReasonMessageId("workspace_mcp_trust_unavailable")).toBe(
      "settings.mcp.trust.rejectedUnavailable",
    );
    const unknown: ZodyWorkspaceMcpTrustResult["reasonCode"] = undefined;
    expect(resolveWorkspaceMcpTrustReasonMessageId(unknown)).toBe(
      "settings.mcp.trust.rejectedUnavailable",
    );
  });
});
