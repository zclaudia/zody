// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "../src/ToolCallBlocks/ToolLayout.js";
import { handleToolSummaryActionKeyDown } from "../src/ToolCallBlocks/ToolSummaryRow.js";

type LayoutReadKind = "getBoundingClientRect" | "getClientRects" | "offsetWidth" | "offsetHeight";

interface MeasurementRecord {
  kind: LayoutReadKind;
  element: Element;
  hidden: boolean;
  width: number;
  height: number;
}

// 浏览器夹具：记录每次布局读取的调用元素、当时的 hidden 状态与返回几何。
// 除 getBoundingClientRect 外，还覆盖 contract 第 1 条列出的等价读取
// （getClientRects / offsetWidth / offsetHeight），隐藏节点上四类读取都应为 0。
// 隐藏节点按真实排版返回 0×0，用于断言批量隐藏卡片不触发几何读取；不代表真实排版耗时。
function installMeasurementProbe(size: { width: number; height: number }) {
  const records: MeasurementRecord[] = [];
  const geometryFor = (element: Element) => {
    const hidden = element instanceof HTMLElement ? element.hidden : false;
    return hidden ? { width: 0, height: 0 } : { width: size.width, height: size.height };
  };
  const record = (kind: LayoutReadKind, element: Element, width: number, height: number) => {
    records.push({
      kind,
      element,
      hidden: element instanceof HTMLElement ? element.hidden : false,
      width,
      height,
    });
  };

  const rectSpy = vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Element) {
      const { width, height } = geometryFor(this);
      record("getBoundingClientRect", this, width, height);
      return new DOMRect(0, 0, width, height);
    });
  const clientRectsSpy = vi
    .spyOn(Element.prototype, "getClientRects")
    .mockImplementation(function (this: Element) {
      const { width, height } = geometryFor(this);
      record("getClientRects", this, width, height);
      return [new DOMRect(0, 0, width, height)] as unknown as DOMRectList;
    });
  const offsetWidthSpy = vi
    .spyOn(HTMLElement.prototype, "offsetWidth", "get")
    .mockImplementation(function (this: HTMLElement) {
      const { width } = geometryFor(this);
      record("offsetWidth", this, width, 0);
      return width;
    });
  const offsetHeightSpy = vi
    .spyOn(HTMLElement.prototype, "offsetHeight", "get")
    .mockImplementation(function (this: HTMLElement) {
      const { height } = geometryFor(this);
      record("offsetHeight", this, 0, height);
      return height;
    });

  return {
    records,
    restore: () => {
      rectSpy.mockRestore();
      clientRectsSpy.mockRestore();
      offsetWidthSpy.mockRestore();
      offsetHeightSpy.mockRestore();
    },
  };
}

function collapsibleContentNodes(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="collapsible-content"]'));
}

// 正对照：显式在可见节点上触发三类等价布局读取，证明夹具会记录它们；
// 否则隐藏节点上的 0 记录只是「Radix 本来就没调用」的空断言。
function readEquivalentGeometry(element: HTMLElement) {
  element.getClientRects();
  void element.offsetWidth;
  void element.offsetHeight;
}

function expectProbeRecordsEquivalentReads(
  probe: { records: MeasurementRecord[] },
  element: Element,
) {
  const kinds = probe.records
    .filter((record) => record.element === element && !record.hidden)
    .map((record) => record.kind);
  expect(kinds).toEqual(
    expect.arrayContaining(["getClientRects", "offsetWidth", "offsetHeight"] as LayoutReadKind[]),
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ToolLayout", () => {
  it("keeps collapsible detail spacing inside the animated content body", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolLayout, {
          toolId: "tool-layout-spacing",
          icon: createElement("span", { "aria-hidden": true }, "icon"),
          forceOpen: true,
          kindLabel: "已探索",
          primaryText: "1 个搜索",
          renderContent: () => createElement("div", { className: "tool-detail" }, "detail"),
        }),
      ),
    );

    expect(html).toContain('class="w-full flex flex-col"');
    expect(html).not.toContain('class="w-full flex flex-col gap-2"');
    expect(html).toMatch(
      /data-testid="tool-summary-trigger-tool-layout-spacing"[^>]*class="[^"]*\binline-flex\b[^"]*\bmax-w-full\b/,
    );
    expect(html).not.toMatch(
      /data-testid="tool-summary-trigger-tool-layout-spacing"[^>]*class="[^"]*(?:^|\s)w-full(?:\s|")/,
    );
    expect(html).not.toMatch(/data-slot="collapsible-content"[^>]*class="[^"]*\bpt-2\b[^"]*"/);
    expect(html).toMatch(
      /data-slot="collapsible-content"[^>]*>[\s\S]*?<div class="pt-2"><div class="tool-detail">detail<\/div><\/div>/,
    );
  });

  it("preserves detail spacing for force-open non-toggle content", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolLayout, {
          toolId: "tool-layout-force-open-spacing",
          icon: createElement("span", { "aria-hidden": true }, "icon"),
          canToggle: false,
          forceOpen: true,
          kindLabel: "已探索",
          primaryText: "1 个搜索",
          renderContent: () => createElement("div", { className: "tool-detail" }, "detail"),
        }),
      ),
    );

    expect(html).not.toContain('data-slot="collapsible-content"');
    expect(html).toMatch(
      /class="[^"]*\btext-popover-foreground\b[^"]*\bpt-2\b[^"]*"><div class="tool-detail">detail<\/div>/,
    );
  });

  it("keeps running tool icons static while animating kind labels", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolLayout, {
          toolId: "tool-layout-running-label",
          icon: createElement("span", { "aria-hidden": true }, "icon"),
          canToggle: false,
          isRunning: true,
          kindLabel: "读取",
          primaryText: "mod.rs",
        }),
      ),
    );

    expect(html).toContain("icon");
    expect(html).not.toContain("lucide-loader");
    expect(html).not.toContain("animate-spin");
    expect(html).toContain("读取");
    expect(html).toContain("animated-gradient-text");
  });

  it("does not reserve a summary content gap when an expanded tool has no summary", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolLayout, {
          toolId: "tool-layout-empty-expanded-summary",
          icon: createElement("span", { "aria-hidden": true }, "icon"),
          forceOpen: true,
          kindLabel: "终端",
          primaryText: null,
          renderContent: () => createElement("div", null, "detail"),
        }),
      ),
    );

    expect(html).not.toContain("tool-summary-content");
    expect(html).toMatch(
      /tool-summary-kind-label[\s\S]*?终端<\/span><svg[^>]*lucide-chevron-right/,
    );
  });

  it("prioritizes edit file content when the conversation container narrows", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolLayout, {
          toolId: "tool-layout-edit-file-priority",
          icon: createElement("span", { "aria-hidden": true }, "icon"),
          canToggle: false,
          kindLabel: "已编辑",
          primaryText: "long-file-name.tsx",
          prioritizePrimaryText: true,
        }),
      ),
    );

    expect(html).toMatch(
      /class="[^"]*tool-summary-kind-label[^"]*@max-\[360px\]\/conversation:hidden/,
    );
    expect(html).toMatch(/class="[^"]*tool-summary-content[^"]*flex-1[^"]*overflow-hidden/);
  });

  it("renders a summary action without collapsible semantics or inline detail", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolLayout, {
          toolId: "tool-layout-summary-action",
          icon: createElement("span", { "aria-hidden": true }, "icon"),
          kindLabel: "子智能体",
          primaryText: "Explore workspace",
          summaryAction: {
            ariaLabel: "在右侧打开",
            onActivate: vi.fn(),
            testId: "subagent-summary-action",
          },
          renderContent: () => createElement("div", { className: "tool-detail" }, "detail"),
        }),
      ),
    );

    expect(html).toContain('data-testid="subagent-summary-action"');
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-label="在右侧打开"');
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain("lucide-chevron-right");
    expect(html).not.toContain("tool-detail");
  });

  it("activates summary actions from Enter and Space only", () => {
    const onActivate = vi.fn();
    const preventDefault = vi.fn();

    expect(handleToolSummaryActionKeyDown({ key: "Enter", preventDefault }, onActivate)).toBe(true);
    expect(handleToolSummaryActionKeyDown({ key: " ", preventDefault }, onActivate)).toBe(true);
    expect(handleToolSummaryActionKeyDown({ key: "Escape", preventDefault }, onActivate)).toBe(
      false,
    );
    expect(onActivate).toHaveBeenCalledTimes(2);
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });
});

describe("ToolLayout hidden measurement", () => {
  it("does not read geometry for hidden detail bodies in a batch of collapsed tools", () => {
    const probe = installMeasurementProbe({ width: 900, height: 180 });

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          "div",
          null,
          Array.from({ length: 30 }, (_, index) =>
            createElement(ToolLayout, {
              key: index,
              toolId: `tool-layout-hidden-batch-${index}`,
              icon: createElement("span", { "aria-hidden": true }, "icon"),
              kindLabel: "读取",
              primaryText: `file-${index}.ts`,
              renderContent: () =>
                createElement("div", { className: "tool-detail" }, `detail-${index}`),
            }),
          ),
        ),
      ),
    );

    const contents = collapsibleContentNodes();
    expect(contents).toHaveLength(30);
    expect(contents.every((content) => content.hidden)).toBe(true);
    const contentNodes = new Set<Element>(contents);
    const hiddenReads = probe.records.filter(
      (record) => record.hidden && contentNodes.has(record.element),
    );
    expect(hiddenReads).toHaveLength(0);
  });

  it("measures only the expanded card in a hidden batch and stops reading after it collapses", () => {
    const probe = installMeasurementProbe({ width: 900, height: 180 });

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          "div",
          null,
          Array.from({ length: 30 }, (_, index) =>
            createElement(ToolLayout, {
              key: index,
              toolId: `tool-layout-batch-toggle-${index}`,
              icon: createElement("span", { "aria-hidden": true }, "icon"),
              kindLabel: "读取",
              primaryText: `file-${index}.ts`,
              renderContent: () =>
                createElement("div", { className: "tool-detail" }, `detail-${index}`),
            }),
          ),
        ),
      ),
    );

    const contents = collapsibleContentNodes();
    expect(contents).toHaveLength(30);
    expect(contents.every((content) => content.hidden)).toBe(true);

    const trigger = screen.getByTestId("tool-summary-trigger-tool-layout-batch-toggle-7");
    fireEvent.click(trigger);

    const opened = contents[7];
    if (opened === undefined) {
      throw new Error("opened collapsible content is not mounted");
    }
    expect(opened.hidden).toBe(false);
    // 正对照：夹具确实能观察到可见卡片的测量，避免「0 读取」因探针失效而空过。
    const visibleReads = probe.records.filter(
      (record) =>
        record.kind === "getBoundingClientRect" && record.element === opened && !record.hidden,
    );
    expect(visibleReads.length).toBeGreaterThan(0);
    readEquivalentGeometry(opened);
    expectProbeRecordsEquivalentReads(probe, opened);
    // 其余 29 张仍是 hidden，不得出现任何布局读取。
    expect(
      probe.records.filter((record) => record.hidden && record.element !== opened),
    ).toHaveLength(0);
    const measuredHeight = opened.style.getPropertyValue("--radix-collapsible-content-height");
    expect(measuredHeight).toBe("180px");

    // 收起后不再补测的作用类似：present 变 false 不重跑测量 effect；
    // guard 的存在性由初始 hidden 批量用例与 CJS/ESM 产物守卫证明。
    fireEvent.click(trigger);
    expect(opened.hidden).toBe(true);
    expect(
      probe.records.filter((record) => record.hidden && record.element === opened),
    ).toHaveLength(0);
    expect(opened.style.getPropertyValue("--radix-collapsible-content-height")).toBe(
      measuredHeight,
    );
  });

  it("measures a detail body only while visible and keeps the last visible size after collapse", () => {
    const probe = installMeasurementProbe({ width: 900, height: 180 });

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolLayout, {
          toolId: "tool-layout-measure-toggle",
          icon: createElement("span", { "aria-hidden": true }, "icon"),
          kindLabel: "读取",
          primaryText: "mod.rs",
          renderContent: () => createElement("div", { className: "tool-detail" }, "detail"),
        }),
      ),
    );

    const content = collapsibleContentNodes()[0];
    if (content === undefined) {
      throw new Error("collapsible content is not mounted");
    }
    expect(content.hidden).toBe(true);

    const trigger = screen.getByTestId("tool-summary-trigger-tool-layout-measure-toggle");
    fireEvent.click(trigger);
    expect(content.hidden).toBe(false);
    expect(
      probe.records.filter(
        (record) =>
          record.kind === "getBoundingClientRect" && record.element === content && !record.hidden,
      ).length,
    ).toBeGreaterThan(0);
    readEquivalentGeometry(content);
    expectProbeRecordsEquivalentReads(probe, content);
    const measuredHeight = content.style.getPropertyValue("--radix-collapsible-content-height");
    expect(measuredHeight).toBe("180px");

    // 关闭后 hidden 读取为 0 还因为 Radix 的 useLayoutEffect 依赖是 [context.open, present]：
    // 收起先以可见帧测量，随后 present=false 不重跑该 effect。本断言证明「hidden 后不再补测
    // 并保留最近可见尺寸」；补丁存在性由初始 hidden、批量与 Accordion 用例守卫。
    fireEvent.click(trigger);
    expect(content.hidden).toBe(true);
    expect(
      probe.records.filter((record) => record.element === content && record.hidden),
    ).toHaveLength(0);
    expect(content.style.getPropertyValue("--radix-collapsible-content-height")).toBe(
      measuredHeight,
    );
  });
});
