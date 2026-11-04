import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZodyIntlProvider, useZodyIntl } from "@/i18n/IntlProvider.js";
import { getConversationTelemetryParityScenario } from "@/lib/conversationTelemetryParityScenarioDefinitions.js";
import { buildChatErrorBannerTelemetryPayload } from "@/lib/chatErrorBannerTelemetry.js";
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

const migratedIds = [
  "zcode.error.CLAUDE_UNKNOWN_COMMAND",
  "zcode.error.CLAUDE_UNKNOWN_COMMAND_WITH_ARGS",
  "zcode.error.MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE",
  "zcode.error.MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE",
  "zcode.error.MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE",
  "zcode.error.NO_ACTIVE_TASK_OWNER",
  "zcode.error.OWNER_COMMAND_FAILED",
  "zcode.error.STALE_TASK_OWNER_COMMAND",
  "zcode.error.TASK_OWNED_BY_OTHER_HOST",
  "zcode.error.ZCODE_BIGMODEL_TEAM_PLAN_MEMBER_REQUIRED",
  "zcode.error.ZODY_RUNTIME_MODEL_UNAVAILABLE",
  "zcode.error.modelSuspiciousEmpty",
  "zcode.error.providerBusiness.1005",
  "zcode.error.providerBusiness.1006",
  "zcode.error.providerBusiness.2007",
  "zcode.error.providerBusiness.3001",
  "zcode.error.providerBusiness.3002",
  "zcode.error.providerBusiness.3006",
  "zcode.error.providerBusiness.3007",
  "zcode.error.providerBusiness.3008",
  "zcode.error.providerBusiness.3009",
  "zcode.error.providerBusiness.3010",
  "zcode.error.providerBusiness.3102",
  "zcode.error.providerBusiness.429",
  "zcode.initFailed",
  "zcode.unavailable",
] as const;

function realIntl(locale: "en-US" | "zh-CN"): IntlInstance {
  let current: IntlInstance | undefined;
  function Capture() {
    current = useZodyIntl().intl;
    return null;
  }
  renderToStaticMarkup(
    createElement(ZodyIntlProvider, { initialLocale: locale }, createElement(Capture)),
  );
  if (!current) throw new Error("Intl provider did not render");
  return current;
}

describe("first-party message ID hard cut", () => {
  it.each([
    ["en-US", enUS],
    ["zh-CN", zhCN],
  ] as const)("uses the 26 actual %s catalog entries and no old aliases", (locale, catalog) => {
    const intl = realIntl(locale);
    expect(
      createHash("sha256")
        .update([...migratedIds].sort().join("\n") + "\n")
        .digest("hex"),
    ).toBe("92aae49da0e66cafdf208770158f0b9347ef47a1a1e37c0ce07f9a070e8e0555");
    const expected = migratedIds.map((old) => `zody.${old.slice(6)}`).sort();
    const actual = Object.keys(catalog)
      .filter(
        (key) =>
          key.startsWith("zody.error.") || key === "zody.unavailable" || key === "zody.initFailed",
      )
      .sort();
    expect(actual).toEqual(expected);
    for (const old of migratedIds) {
      const current = `zody.${old.slice(6)}`;
      expect(catalog[old]).toBeUndefined();
      expect(typeof catalog[current]).toBe("string");
      expect(intl.formatMessage({ id: old })).toBe(old);
      expect(intl.formatMessage({ id: current })).toBe(catalog[current]);
    }
  });

  it.each([
    ["en-US", enUS],
    ["zh-CN", zhCN],
  ] as const)("routes real %s error branches to catalog text", (locale, catalog) => {
    const intl = realIntl(locale);
    const codes = [
      "TASK_OWNED_BY_OTHER_HOST",
      "STALE_TASK_OWNER_COMMAND",
      "NO_ACTIVE_TASK_OWNER",
      "OWNER_COMMAND_FAILED",
      "MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE",
      "MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE",
      "MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE",
      "ZODY_RUNTIME_MODEL_UNAVAILABLE",
      "ZCODE_BIGMODEL_TEAM_PLAN_MEMBER_REQUIRED",
    ];
    for (const code of codes)
      expect(resolveChatErrorBannerDisplayMessage({ code, message: "fallback" }, intl)).toBe(
        catalog[`zody.error.${code}`],
      );
    for (const code of [
      "1005",
      "1006",
      "2007",
      "3001",
      "3002",
      "3006",
      "3007",
      "3008",
      "3009",
      "3010",
      "3102",
      "429",
    ])
      expect(resolveChatErrorBannerDisplayMessage({ code, message: "fallback" }, intl)).toBe(
        catalog[`zody.error.providerBusiness.${code}`],
      );
    expect(
      resolveChatErrorBannerDisplayMessage(
        { code: "CLAUDE_UNKNOWN_COMMAND", message: "Claude Code 未知命令 /bad。" },
        intl,
      ),
    ).toBe(intl.formatMessage({ id: "zody.error.CLAUDE_UNKNOWN_COMMAND" }, { command: "/bad" }));
    expect(
      resolveChatErrorBannerDisplayMessage(
        { code: "CLAUDE_UNKNOWN_COMMAND", message: "Claude Code 未知命令 /bad（参数：x）。" },
        intl,
      ),
    ).toBe(
      intl.formatMessage(
        { id: "zody.error.CLAUDE_UNKNOWN_COMMAND_WITH_ARGS" },
        { command: "/bad", args: "x" },
      ),
    );
    expect(
      resolveChatErrorBannerDisplayMessage(
        { code: "UNKNOWN", message: "Model returned no text" },
        intl,
      ),
    ).toBe(catalog["zody.error.modelSuspiciousEmpty"]);
    expect(
      resolveChatErrorBannerDisplayMessage(
        { code: "ZCODE_RUNTIME_MODEL_UNAVAILABLE", message: "old raw" },
        intl,
      ),
    ).toBe("old raw");
    expect(
      resolveChatErrorBannerDisplayMessage({ code: "UNKNOWN", message: "unknown raw" }, intl),
    ).toBe("unknown raw");
  });

  it("passes actual resolved 3007 text to parity and telemetry", () => {
    const intl = realIntl("en-US");
    const error = { code: "3007", message: "fallback" };
    const displayMessage = resolveChatErrorBannerDisplayMessage(error, intl);
    expect(displayMessage).toBe(enUS["zody.error.providerBusiness.3007"]);
    const visible = getConversationTelemetryParityScenario("TDP17").operations.find(
      (x) => x.kind === "visible.error",
    );
    expect(visible).toMatchObject({ displayMessage, code: "3007" });
    const telemetry = buildChatErrorBannerTelemetryPayload({
      displayMessage,
      error,
      providerBusinessRecoveryAction: null,
    });
    expect(telemetry.properties).toMatchObject({
      error_code: "3007",
      error_message: displayMessage,
    });
    expect(displayMessage).not.toBe("zody.error.providerBusiness.3007");
    expect(displayMessage).not.toBe("zcode.error.providerBusiness.3007");
  });
});
