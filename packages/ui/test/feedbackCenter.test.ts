// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IFeedbackService } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";

import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";

// fork（F2.9，决策门 D7）：反馈中心收敛为本地面板。
// 「打开反馈地址」入口显隐由构建期 ZCODE_FEEDBACK_ISSUE_URL 决定；这里用可变 getter 模拟
// 构建期 define 的两种注入结果（未注入为空串、注入为完整 URL）。
const sharedMocks = vi.hoisted(() => ({ feedbackIssueUrl: "" as string }));

vi.mock("@zcode/shared", async (importOriginal) => {
  const original = await importOriginal<typeof import("@zcode/shared")>();
  return {
    ...original,
    get ZCODE_FEEDBACK_ISSUE_URL() {
      return sharedMocks.feedbackIssueUrl;
    },
  };
});

import { FeedbackCenter } from "@/feedback/FeedbackCenter.js";

function makePlatform(): IPlatformService {
  return {
    exportLogs: vi.fn(async () => ({ success: true, path: "/tmp/logs.zip" })),
    openExternal: vi.fn(async () => {}),
  } as unknown as IPlatformService;
}

function renderFeedbackCenter(platform: IPlatformService) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        TabStoreProvider,
        null,
        createElement(FeedbackCenter, {
          feedbackService: {} as IFeedbackService,
          platform,
        }),
      ),
    ),
  );
}

describe("FeedbackCenter（反馈本地化面板）", () => {
  afterEach(() => {
    cleanup();
    sharedMocks.feedbackIssueUrl = "";
    useFeedbackStore.setState({ open: false, featureRequestOpen: false });
  });

  it("面板提供本地导出诊断日志入口，不再渲染官方工单提交与工单列表", () => {
    useFeedbackStore.setState({ open: true });
    renderFeedbackCenter(makePlatform());

    expect(screen.getByText("导出诊断日志")).toBeTruthy();
    expect(screen.queryByText("提交反馈")).toBeNull();
    expect(screen.queryByText("我的反馈")).toBeNull();
  });

  it("未配置 ZCODE_FEEDBACK_ISSUE_URL 时不显示打开反馈地址入口", () => {
    sharedMocks.feedbackIssueUrl = "";
    useFeedbackStore.setState({ open: true });
    renderFeedbackCenter(makePlatform());

    expect(screen.queryByTestId("feedback-open-issue-page")).toBeNull();
    expect(screen.queryByText("打开反馈地址")).toBeNull();
  });

  it("配置 ZCODE_FEEDBACK_ISSUE_URL 后显示入口，点击打开配置的地址", async () => {
    sharedMocks.feedbackIssueUrl = "https://example.com/feedback";
    useFeedbackStore.setState({ open: true });
    const platform = makePlatform();
    renderFeedbackCenter(platform);

    fireEvent.click(screen.getByTestId("feedback-open-issue-page"));

    await waitFor(() => {
      expect(platform.openExternal).toHaveBeenCalledWith("https://example.com/feedback");
    });
  });

  it("点击导出诊断日志走本地 platform.exportLogs，不发网络请求", async () => {
    useFeedbackStore.setState({ open: true });
    const platform = makePlatform();
    renderFeedbackCenter(platform);

    fireEvent.click(screen.getByText("导出诊断日志"));

    await waitFor(() => {
      expect(platform.exportLogs).toHaveBeenCalledTimes(1);
    });
  });

  it("「给产品提需求」入口同样落到本地面板（openFeatureRequest 合并判定）", () => {
    useFeedbackStore.setState({ featureRequestOpen: true });
    renderFeedbackCenter(makePlatform());

    expect(screen.getByText("导出诊断日志")).toBeTruthy();
  });
});
