// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../src/components/ui/collapsible.js";

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
// 隐藏节点按真实排版返回 0×0（固定返回可见尺寸会让「隐藏后保留最近可见尺寸」失去区分力），
// 但它仍只验证「是否读取了几何」，不代表真实排版耗时。
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

function collapsibleContentNode(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="collapsible-content"]');
}

// 正对照：显式在可见节点上触发三类等价布局读取，证明夹具会记录它们。
// Radix 当前只调用 getBoundingClientRect；没有这段正对照，hidden 节点上
// getClientRects/offsetWidth/offsetHeight 为 0 只是「本来就没调用」的空断言。
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

describe("Collapsible", () => {
  it("keeps the closed animation end frame while content is still mounted", () => {
    const html = renderToStaticMarkup(
      createElement(
        Collapsible,
        { defaultOpen: false },
        createElement(CollapsibleTrigger, null, "Toggle"),
        createElement(CollapsibleContent, { forceMount: true }, "Details"),
      ),
    );

    expect(html).toContain("data-[state=closed]:[animation-fill-mode:forwards]");
    expect(html).toContain(
      "group-data-[state=closed]/collapsible-content:[animation-fill-mode:forwards]",
    );
    expect(html).toContain('data-slot="collapsible-content"');
    expect(html).toContain('data-state="closed"');
    const contentTag = html.match(/<div[^>]*data-slot="collapsible-content"[^>]*>/)?.[0];
    expect(contentTag).toBeDefined();
    expect(contentTag).not.toMatch(/\shidden(?:=|\s|>)/u);
  });

  it("does not expose collapsible animation layers to default CSS transitions", () => {
    const html = renderToStaticMarkup(
      createElement(
        Collapsible,
        { defaultOpen: true },
        createElement(CollapsibleTrigger, null, "Toggle"),
        createElement(CollapsibleContent, null, "Details"),
      ),
    );

    expect(html).toContain("transition-none");
    expect(html).toContain(
      "transition-none duration-300 ease-in-out group-data-[state=open]/collapsible-content:animate-in",
    );
  });
});

describe("Collapsible hidden measurement", () => {
  it("does not read geometry for content rendered hidden", () => {
    const probe = installMeasurementProbe({ width: 480, height: 96 });

    render(
      createElement(
        Collapsible,
        { defaultOpen: false },
        createElement(CollapsibleTrigger, null, "Toggle"),
        createElement(CollapsibleContent, null, "Details"),
      ),
    );

    const content = collapsibleContentNode();
    if (content === null) {
      throw new Error("collapsible content is not mounted");
    }
    expect(content.hidden).toBe(true);
    // 隐藏节点上不得出现任何布局读取：getBoundingClientRect / getClientRects /
    // offsetWidth / offsetHeight 均由夹具记录。
    expect(probe.records.filter((record) => record.element === content)).toHaveLength(0);
  });

  it("measures content that is open on mount and publishes the measured size", () => {
    const probe = installMeasurementProbe({ width: 480, height: 96 });
    const tree = (label: string) =>
      createElement(
        Collapsible,
        { defaultOpen: true },
        createElement(CollapsibleTrigger, null, "Toggle"),
        createElement(CollapsibleContent, null, label),
      );

    const { rerender } = render(tree("Details"));
    const content = collapsibleContentNode();
    if (content === null) {
      throw new Error("collapsible content is not mounted");
    }
    expect(content.hidden).toBe(false);
    expect(
      probe.records.filter(
        (record) =>
          record.kind === "getBoundingClientRect" && record.element === content && !record.hidden,
      ).length,
    ).toBeGreaterThan(0);
    readEquivalentGeometry(content);
    expectProbeRecordsEquivalentReads(probe, content);

    // Radix 在 render 阶段读取上一次布局测量的 ref；再渲染一次即可观察到写入的 CSS 变量。
    rerender(tree("Details updated"));
    expect(content.style.getPropertyValue("--radix-collapsible-content-height")).toBe("96px");
    expect(content.style.getPropertyValue("--radix-collapsible-content-width")).toBe("480px");
  });

  it("stops measuring once expanded content becomes hidden and keeps the last visible size", () => {
    const probe = installMeasurementProbe({ width: 480, height: 96 });

    render(
      createElement(
        Collapsible,
        { defaultOpen: false },
        createElement(CollapsibleTrigger, null, "Toggle"),
        createElement(CollapsibleContent, null, "Details"),
      ),
    );

    const content = collapsibleContentNode();
    if (content === null) {
      throw new Error("collapsible content is not mounted");
    }
    expect(content.hidden).toBe(true);

    fireEvent.click(screen.getByText("Toggle"));
    expect(content.hidden).toBe(false);
    expect(
      probe.records.filter(
        (record) =>
          record.kind === "getBoundingClientRect" && record.element === content && !record.hidden,
      ).length,
    ).toBeGreaterThan(0);
    const measuredHeight = content.style.getPropertyValue("--radix-collapsible-content-height");
    expect(measuredHeight).toBe("96px");

    // 关闭后的 hidden 读取为 0 也受 Radix effect 依赖影响：[context.open, present] 在
    // present=false 时不再重跑，因此本断言证明「hidden 后不再补测并保留最近可见尺寸」；
    // 补丁存在性由初始 hidden 挂载、ToolLayout 批量与 Accordion 用例及 CJS/ESM 产物守卫证明。
    fireEvent.click(screen.getByText("Toggle"));
    expect(content.hidden).toBe(true);
    expect(
      probe.records.filter((record) => record.element === content && record.hidden),
    ).toHaveLength(0);
    expect(content.style.getPropertyValue("--radix-collapsible-content-height")).toBe(
      measuredHeight,
    );
  });

  it("keeps measuring force-mounted content that remains visible while closed", () => {
    const probe = installMeasurementProbe({ width: 480, height: 96 });

    render(
      createElement(
        Collapsible,
        { defaultOpen: false },
        createElement(CollapsibleTrigger, null, "Toggle"),
        createElement(CollapsibleContent, { forceMount: true }, "Details"),
      ),
    );

    const content = collapsibleContentNode();
    if (content === null) {
      throw new Error("collapsible content is not mounted");
    }
    expect(content.hidden).toBe(false);
    expect(
      probe.records.filter(
        (record) =>
          record.kind === "getBoundingClientRect" && record.element === content && !record.hidden,
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe("Collapsible patch installation", () => {
  // CJS 与 ESM 是两份独立产物：只改一侧时，另一侧会静默退回无条件测量，
  // 而上面的组件测试只走 ESM 解析。这里直接校验安装产物，防止单侧丢失。
  // 测试可从仓库根或 packages/ui 两种 cwd 运行，因此按模块解析定位安装产物，
  // 不用 process.cwd() 拼路径（包级 cwd 下会指向不存在的 node_modules）。
  const requireFromTest = createRequire(import.meta.url);
  const installedDistDir = dirname(requireFromTest.resolve("@radix-ui/react-collapsible"));
  it.each(["index.js", "index.mjs"])(
    "guards hidden geometry reads in the installed %s",
    async (file) => {
      const source = await readFile(resolve(installedDistDir, file), "utf8");

      expect(source.match(/getBoundingClientRect\(\)/gu)).toHaveLength(1);
      expect(source).toMatch(
        /if \(!node\.hidden\) \{\s*const rect = node\.getBoundingClientRect\(\);/u,
      );
    },
  );
});
