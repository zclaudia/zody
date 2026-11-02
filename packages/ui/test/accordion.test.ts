// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../src/components/ui/accordion.js";

type LayoutReadKind = "getBoundingClientRect" | "getClientRects" | "offsetWidth" | "offsetHeight";

interface MeasurementRecord {
  kind: LayoutReadKind;
  element: Element;
  hidden: boolean;
  width: number;
  height: number;
}

// @radix-ui/react-accordion 的 Content 复用 @radix-ui/react-collapsible，
// 因此 Accordion 同样继承「hidden 节点不读几何」。夹具记录四类布局读取
// （contract 第 1 条），隐藏节点按真实排版返回 0×0。
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

function accordionContentNodes(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="accordion-content"]'));
}

// 正对照：显式在可见节点上触发三类等价布局读取，证明夹具会记录它们；
// 否则收起项上的 0 记录只是「Radix 本来就没调用」的空断言。
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

describe("Accordion hidden measurement", () => {
  it("inherits the hidden measurement guard from the shared collapsible primitive", () => {
    const probe = installMeasurementProbe({ width: 640, height: 72 });
    const tree = (label: string) =>
      createElement(
        Accordion,
        { type: "single", defaultValue: "open-item" },
        createElement(
          AccordionItem,
          { value: "open-item" },
          createElement(AccordionTrigger, null, "Open"),
          createElement(AccordionContent, null, label),
        ),
        createElement(
          AccordionItem,
          { value: "closed-item" },
          createElement(AccordionTrigger, null, "Closed"),
          createElement(AccordionContent, null, "hidden"),
        ),
      );

    const { rerender } = render(tree("visible"));
    const contents = accordionContentNodes();
    expect(contents).toHaveLength(2);
    const [openContent, closedContent] = contents;
    if (openContent === undefined || closedContent === undefined) {
      throw new Error("accordion content is not mounted");
    }
    expect(openContent.hidden).toBe(false);
    expect(closedContent.hidden).toBe(true);
    expect(probe.records.filter((record) => record.element === closedContent)).toHaveLength(0);
    expect(
      probe.records.filter(
        (record) =>
          record.kind === "getBoundingClientRect" &&
          record.element === openContent &&
          !record.hidden,
      ).length,
    ).toBeGreaterThan(0);
    readEquivalentGeometry(openContent);
    expectProbeRecordsEquivalentReads(probe, openContent);

    // Radix 在 render 阶段读取上一次布局测量的 ref；再渲染一次即可观察到写入的 CSS 变量。
    rerender(tree("visible updated"));
    expect(openContent.style.getPropertyValue("--radix-collapsible-content-height")).toBe("72px");
    expect(openContent.style.getPropertyValue("--radix-accordion-content-height")).toBe(
      "var(--radix-collapsible-content-height)",
    );
    expect(closedContent.style.getPropertyValue("--radix-collapsible-content-height")).toBe("");
  });

  it("keeps measuring when another item expands and stops reading the previously open item", () => {
    const probe = installMeasurementProbe({ width: 640, height: 72 });
    const tree = (firstLabel: string, secondLabel: string) =>
      createElement(
        Accordion,
        { type: "single", defaultValue: "first" },
        createElement(
          AccordionItem,
          { value: "first" },
          createElement(AccordionTrigger, null, "First"),
          createElement(AccordionContent, null, firstLabel),
        ),
        createElement(
          AccordionItem,
          { value: "second" },
          createElement(AccordionTrigger, null, "Second"),
          createElement(AccordionContent, null, secondLabel),
        ),
      );

    const { rerender } = render(tree("first visible", "second hidden"));
    const [firstContent, secondContent] = accordionContentNodes();
    if (firstContent === undefined || secondContent === undefined) {
      throw new Error("accordion content is not mounted");
    }
    expect(firstContent.hidden).toBe(false);
    expect(secondContent.hidden).toBe(true);

    // 第一次切换：第二项展开并测量，第一项仍在可见退出帧内；这里只校验第二项被测量。
    fireEvent.click(screen.getByText("Second"));
    expect(secondContent.hidden).toBe(false);
    expect(firstContent.hidden).toBe(true);
    expect(
      probe.records.filter(
        (record) =>
          record.kind === "getBoundingClientRect" &&
          record.element === secondContent &&
          !record.hidden,
      ).length,
    ).toBeGreaterThan(0);

    // 再渲染一次以观察测量写入的 CSS 变量：第二项得到新尺寸，第一项保留最近可见尺寸。
    rerender(tree("first visible updated", "second visible updated"));
    expect(secondContent.style.getPropertyValue("--radix-collapsible-content-height")).toBe("72px");
    expect(firstContent.style.getPropertyValue("--radix-collapsible-content-height")).toBe("72px");
    // 旧展开项的 hidden 读取为 0 也受 effect 依赖 [context.open, present] 影响；guard 的
    // 存在性由初始收起项、批量回退与安装产物守卫证明，这里验证保留最近可见尺寸。
    expect(
      probe.records.filter((record) => record.hidden && record.element === secondContent),
    ).toHaveLength(0);
    expect(
      probe.records.filter((record) => record.hidden && record.element === firstContent),
    ).toHaveLength(0);
  });
});

describe("Accordion visible animation regression", () => {
  it("keeps the height animation hooks on accordion content", () => {
    const html = renderToStaticMarkup(
      createElement(
        Accordion,
        { type: "single" },
        createElement(
          AccordionItem,
          { value: "item" },
          createElement(AccordionTrigger, null, "Trigger"),
          createElement(AccordionContent, { forceMount: true }, "Content"),
        ),
      ),
    );

    expect(html).toContain("data-open:animate-accordion-down");
    expect(html).toContain("data-closed:animate-accordion-up");
    expect(html).toContain("h-(--radix-accordion-content-height)");
    expect(html).toContain('data-slot="accordion-content"');
  });
});
