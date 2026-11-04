import { describe, expect, it } from "vitest";
import {
  MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE_ERROR_CODE,
} from "@zody/shared";
import { resolveChatErrorBannerDisplayMessage, shouldSuppressChatErrorBanner } from "@/ChatErrorBanner.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";

function createIntl(messages: Record<string, string>): IntlInstance {
  return {
    formatMessage({ id }, values = {}) {
      const template = messages[id] ?? id;
      return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
      );
    },
  };
}

describe("ChatErrorBanner i18n", () => {
  it.each([zhCN, enUS])(
    "localizes only the current live model code and leaves history readable",
    (messages) => {
      const intl = createIntl(messages);
      const message = "saved historical message";
      expect(
        resolveChatErrorBannerDisplayMessage(
          { code: "ZODY_RUNTIME_MODEL_UNAVAILABLE", message },
          intl,
        ),
      ).not.toBe(message);
      expect(
        resolveChatErrorBannerDisplayMessage(
          { code: "ZCODE_RUNTIME_MODEL_UNAVAILABLE", message },
          intl,
        ),
      ).toBe(message);
      expect(
        shouldSuppressChatErrorBanner({
          code: "ZCODE_RUNTIME_MODEL_UNAVAILABLE",
          message: "历史任务使用的模型已不可用",
        }),
      ).toBe(false);
    },
  );

  it.each([
    [zhCN, "当前附件总量过大，请移除部分附件或压缩后重试。"],
    [
      enUS,
      "Current attachments are too large for one request. Remove or compress attachments and try again.",
    ],
  ] as const)("localizes the shared attachment budget error", (messages, expected) => {
    expect(
      resolveChatErrorBannerDisplayMessage(
        {
          code: "MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE",
          message: "Runtime fallback message",
        },
        createIntl(messages),
      ),
    ).toBe(expected);
  });

  it("localizes current media-budget attachment errors from stable runtime codes", () => {
    const zhIntl = createIntl(zhCN);
    const enIntl = createIntl(enUS);

    expect(
      resolveChatErrorBannerDisplayMessage(
        {
          code: MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE_ERROR_CODE,
          message:
            "Current video attachments are too large to send. Remove or shrink videos and try again.",
        },
        zhIntl,
      ),
    ).toBe("当前视频附件过大，请移除部分视频或压缩后重试。");

    expect(
      resolveChatErrorBannerDisplayMessage(
        {
          code: MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE_ERROR_CODE,
          message:
            "Current image attachments are too large to send. Remove or shrink images and try again.",
        },
        enIntl,
      ),
    ).toBe("Current image attachments are too large. Remove or compress images and try again.");
  });

  // fork（F4.3）：闲时票据 3102 本地化用例随闲时任务全链路删除。
});
