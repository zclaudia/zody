// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { zodyLogoUrl } from "@/brand.js";
import { ZodyIntlProvider } from "@/i18n/IntlProvider.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import { ConversationDraftEmptyState } from "@/v4/ConversationDraftEmptyState.js";

afterEach(() => {
  cleanup();
});

describe("ConversationDraftEmptyState logo", () => {
  it("uses one decorative Zody logo and a localized label in both themes", () => {
    const { container } = render(
      createElement(
        ZodyIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationDraftEmptyState),
      ),
    );

    const logos = container.querySelectorAll("img");

    expect(logos).toHaveLength(1);
    expect(logos[0]?.getAttribute("src")).toBe(zodyLogoUrl);
    expect(logos[0]?.getAttribute("alt")).toBe("");
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toContain("Zody");
    expect(container.textContent).toContain(zhCN["taskList.newThread"]);
  });
});
