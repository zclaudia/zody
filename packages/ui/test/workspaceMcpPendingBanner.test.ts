// @vitest-environment jsdom
// 根 Vitest 只收集 .test.ts；本文件使用 createElement，不需要 TSX 扩展名。

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodyIntlProvider } from "@/i18n/IntlProvider.js";
import {
  TID_V4_WORKSPACE_MCP_PENDING_BANNER,
  TID_V4_WORKSPACE_MCP_PENDING_DISMISS,
  TID_V4_WORKSPACE_MCP_PENDING_REVIEW,
} from "@zody/shared";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import {
  WorkspaceMcpPendingBanner,
  workspaceMcpPendingDismissStore,
} from "@/v4/WorkspaceMcpPendingBanner.js";

// fork（F23，上游 a60ba6a7）：workspace MCP 信任门横幅 A（spec §8.1）。

// 模拟 settingsNavigation，验证 [去设置] 同时设置 intent（与 hook 横幅同两步式）。
const settingsIntentMock = vi.hoisted(() => ({
  setPendingSettingsSectionIntent: vi.fn(),
}));

vi.mock("@/lib/settingsNavigation.js", () => ({
  setPendingSettingsSectionIntent: settingsIntentMock.setPendingSettingsSectionIntent,
}));

// 模拟 TabStoreProvider 的 openSettingsTab。
const openSettingsTabMock = vi.hoisted(() => vi.fn());

vi.mock("@/store/TabStoreProvider.js", () => ({
  useOptionalTabStore: () => openSettingsTabMock,
}));

const sampleAdmission = {
  pendingCount: 2,
  bundleDigest: "a".repeat(64),
  workspaceIdentity: "/workspace",
};

function renderBanner(admission = sampleAdmission): string {
  return renderToStaticMarkup(
    createElement(
      ZodyIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(WorkspaceMcpPendingBanner, { sessionId: "sess-1", admission }),
    ),
  );
}

function renderInteractive(admission = sampleAdmission) {
  return render(
    createElement(
      ZodyIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(WorkspaceMcpPendingBanner, { sessionId: "sess-1", admission }),
    ),
  );
}

describe("WorkspaceMcpPendingBanner（F23 横幅 A）", () => {
  beforeEach(() => {
    workspaceMcpPendingDismissStore.clear();
    settingsIntentMock.setPendingSettingsSectionIntent.mockClear();
    openSettingsTabMock.mockClear();
  });

  afterEach(() => cleanup());

  it("pendingCount > 0 时渲染提示条并显示数量", () => {
    const html = renderBanner();
    expect(html).toContain(`data-testid="${TID_V4_WORKSPACE_MCP_PENDING_BANNER}"`);
    expect(html).toContain("2");
  });

  it("pendingCount === 0 时不渲染", () => {
    const html = renderBanner({ pendingCount: 0, bundleDigest: "b".repeat(64) });
    expect(html).not.toContain(`data-testid="${TID_V4_WORKSPACE_MCP_PENDING_BANNER}"`);
  });

  it("admission 为 null 时不渲染（v4 snapshot default null，无待信任即无提示）", () => {
    const html = renderBanner(null);
    expect(html).not.toContain(`data-testid="${TID_V4_WORKSPACE_MCP_PENDING_BANNER}"`);
  });

  it("dismiss 后同 bundle 不再现（幂等 key = sessionId + bundleDigest）", () => {
    workspaceMcpPendingDismissStore.dismiss("sess-1", sampleAdmission.bundleDigest);
    expect(renderBanner()).not.toContain(`data-testid="${TID_V4_WORKSPACE_MCP_PENDING_BANNER}"`);
  });

  it("bundle 变化（digest 变更需重信任场景）后 dismiss 失效，提示条重新出现", () => {
    workspaceMcpPendingDismissStore.dismiss("sess-1", sampleAdmission.bundleDigest);
    const html = renderBanner({ pendingCount: 3, bundleDigest: "c".repeat(64) });
    expect(html).toContain(`data-testid="${TID_V4_WORKSPACE_MCP_PENDING_BANNER}"`);
    expect(html).toContain("3");
  });

  it("点击忽略后立即隐藏；bundleDigest 变化后重新出现", () => {
    renderInteractive();
    expect(screen.getByTestId(TID_V4_WORKSPACE_MCP_PENDING_BANNER)).toBeTruthy();

    fireEvent.click(screen.getByTestId(TID_V4_WORKSPACE_MCP_PENDING_DISMISS));
    expect(screen.queryByTestId(TID_V4_WORKSPACE_MCP_PENDING_BANNER)).toBeNull();

    // 不同 bundle（声明集合变化）→ 重新提示。
    workspaceMcpPendingDismissStore.clear();
    renderInteractive({ ...sampleAdmission, bundleDigest: "c".repeat(64) });
    expect(screen.getByTestId(TID_V4_WORKSPACE_MCP_PENDING_BANNER)).toBeTruthy();
  });

  it("[去设置]：设置 mcp 分区 intent 并打开设置页", () => {
    renderInteractive();
    fireEvent.click(screen.getByTestId(TID_V4_WORKSPACE_MCP_PENDING_REVIEW));
    expect(settingsIntentMock.setPendingSettingsSectionIntent).toHaveBeenCalledWith("mcp");
    expect(openSettingsTabMock).toHaveBeenCalled();
  });

  it("横幅不携带任何声明细节（脱敏摘要只在设置页展示，spec §8.1）", () => {
    const html = renderBanner();
    // admission 载荷里只有数量与 bundle 摘要；行级 display/env/命令行不得出现在横幅。
    expect(html).not.toContain("declarationDigest");
    expect(html).not.toContain("command");
    expect(html).not.toContain("env");
  });

  it("i18n key zh/en 双侧存在（缺 key 会把原始 id 渲染到界面）", () => {
    const keys = [
      "chat.workspaceMcpPending.message",
      "chat.workspaceMcpPending.goToSettings",
      "chat.workspaceMcpPending.dismiss",
    ];
    for (const key of keys) {
      expect(zhCN[key], `zh-CN 缺 ${key}`).toBeTruthy();
      expect(enUS[key], `en-US 缺 ${key}`).toBeTruthy();
    }
  });

  it("zh/en 文案都包含 count 参数占位（A9 i18n parity）", () => {
    expect(zhCN["chat.workspaceMcpPending.message"]).toContain("{count}");
    expect(enUS["chat.workspaceMcpPending.message"]).toContain("{count}");
  });
});
