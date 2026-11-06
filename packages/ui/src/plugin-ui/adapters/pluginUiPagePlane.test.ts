// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginUiPagePlane } from "./pluginUiPagePlane.js";

// F18（上游 a60ba6a7 pluginUiPagePlane）：声明保留的页面隐藏时保留不可交互的执行表面；
// hasVisibleAnchor 是回收后自动重建的判据（docs/plugin-ui-background-execution.md §12.2.8/§12.2.9）。
const root = () => document.querySelector<HTMLElement>("[data-sandbox-page-root]")!;

class FakeIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
vi.stubGlobal("ResizeObserver", FakeResizeObserver);

describe("pluginUiPagePlane execution surface", () => {
  afterEach(() => {
    document.querySelector("[data-sandbox-page-parking]")?.remove();
    vi.restoreAllMocks();
  });

  it("keeps a hidden executable surface for retained pages and clears it on release", () => {
    const plane = createPluginUiPagePlane({ onVisibility: () => {}, onCrash: () => {} });
    expect(root().style.display).toBe("none");
    plane.setExecutionActive(true);
    // display:none 会停止页面依赖的 rAF；保留页保持可执行且不接收输入的低透明表面。
    expect(root().style.display).toBe("block");
    expect(root().style.opacity).toBe("0.001");
    expect(root().style.position).toBe("fixed");
    plane.setExecutionActive(false);
    expect(root().style.display).toBe("none");
    plane.dispose();
  });

  it("reports visible anchors with non-zero bounds and drops them on unbind", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 100,
      height: 50,
      top: 0,
      left: 0,
      right: 100,
      bottom: 50,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    // jsdom 未实现 checkVisibility；实现侧对缺失环境按可见处理（防御探测）。
    const plane = createPluginUiPagePlane({ onVisibility: () => {}, onCrash: () => {} });
    expect(plane.hasVisibleAnchor()).toBe(false);
    const node = document.createElement("div");
    document.body.append(node);
    const off = plane.bind({ node, kind: "flow" });
    expect(plane.hasVisibleAnchor()).toBe(true);
    off();
    node.remove();
    expect(plane.hasVisibleAnchor()).toBe(false);
    plane.dispose();
  });
});
