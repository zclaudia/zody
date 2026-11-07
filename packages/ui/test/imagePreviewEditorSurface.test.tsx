// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZodyIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast.js", () => ({ toast: toastMock }));

// jsdom 未实现 ResizeObserver / Pointer Capture；Surface 只依赖其存在性，stub 后行为不变。
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

import { ImagePreviewSurface } from "@/image-preview-editor/ImagePreviewSurface.js";
import { registerImageComposerTarget } from "@/image-preview-editor/composerTarget.js";

// F15（上游 a60ba6a7 image-preview-editor/ImagePreviewSurface.tsx）：编辑器 Surface 组件行为。
// 合同见 docs/ui/image-preview-editor.md；导出像素校验归 browser E2E（PA161-04）。

const SRC = "data:image/png;base64,";

function renderSurface(props: Partial<Parameters<typeof ImagePreviewSurface>[0]> = {}) {
  return render(
    createElement(ImagePreviewSurface, {
      src: SRC,
      alt: "shot.png",
      filename: "shot.png",
      onSaved: vi.fn(),
      onClose: vi.fn(),
      ...props,
    }),
  );
}

/** jsdom 不加载图片资源：手工补 naturalWidth/Height 并派发 load，驱动 natural 状态。 */
async function simulateImageLoad(container: HTMLElement) {
  const image = container.querySelector("img");
  expect(image).not.toBeNull();
  Object.defineProperty(image!, "naturalWidth", { configurable: true, value: 640 });
  Object.defineProperty(image!, "naturalHeight", { configurable: true, value: 480 });
  fireEvent.load(image!);
  await waitFor(() => {
    expect((image!.parentElement as HTMLElement).getAttribute("data-image-preview-surface")).toBe(
      "",
    );
  });
}

function drawPenStroke(container: HTMLElement) {
  const surface = container.querySelector<HTMLElement>("[data-image-preview-surface]");
  fireEvent.pointerDown(surface!, { pointerId: 1, button: 0, clientX: 20, clientY: 20 });
  fireEvent.pointerMove(surface!, { pointerId: 1, clientX: 60, clientY: 40 });
  fireEvent.pointerUp(surface!, { pointerId: 1 });
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  toastMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ImagePreviewSurface 工具链与保存", () => {
  it("渲染 toolbar 与七个工具按钮（aria-label 走 imageEditor.* 文案）", () => {
    const { container } = renderSurface();
    expect(screen.getByRole("toolbar", { name: "imageEditor.tools" })).toBeTruthy();
    for (const tool of [
      "select",
      "pen",
      "text",
      "rectangle",
      "ellipse",
      "arrow",
      "eraser",
      "undo",
      "redo",
      "color",
    ]) {
      expect(screen.getByLabelText(`imageEditor.${tool}`)).toBeTruthy();
    }
    expect(container.querySelector("[data-image-preview-save]")).toBeTruthy();
  });

  it("图片未加载完成前工具禁用；加载后启用，且无标注时保存禁用", async () => {
    const { container } = renderSurface();
    const save = () => screen.getByText("imageEditor.save").closest("button")!;
    expect((screen.getByLabelText("imageEditor.pen") as HTMLButtonElement).disabled).toBe(true);
    expect(save().disabled).toBe(true);
    await simulateImageLoad(container);
    expect((screen.getByLabelText("imageEditor.pen") as HTMLButtonElement).disabled).toBe(false);
    // 无标注（displayed.length === 0）时保存仍禁用。
    expect(save().disabled).toBe(true);
  });

  it("画笔绘制提交为一条标注：保存与撤销可用", async () => {
    const { container } = renderSurface();
    await simulateImageLoad(container);
    fireEvent.click(screen.getByLabelText("imageEditor.pen"));
    drawPenStroke(container);
    const save = screen.getByText("imageEditor.save").closest("button")!;
    expect(save.disabled).toBe(false);
    expect((screen.getByLabelText("imageEditor.undo") as HTMLButtonElement).disabled).toBe(false);
  });

  it("按钮缩放改变显示百分比（100% -> 150% -> 100%）", async () => {
    const { container } = renderSurface();
    await simulateImageLoad(container);
    expect(screen.getByText("100%")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("markdownImage.zoomIn"));
    expect(screen.getByText("150%")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("markdownImage.zoomOut"));
    expect(screen.getByText("100%")).toBeTruthy();
  });

  it("无接收方保存：提示 imageEditor.noComposer，不导出、不清标注", async () => {
    const { container } = renderSurface();
    await simulateImageLoad(container);
    fireEvent.click(screen.getByLabelText("imageEditor.pen"));
    drawPenStroke(container);
    fireEvent.click(screen.getByText("imageEditor.save"));
    expect(toastMock).toHaveBeenCalledWith("imageEditor.noComposer");
    // 标注保留：保存按钮仍可用（未被 saving 锁死），撤销仍可执行。
    expect(screen.getByText("imageEditor.save").closest("button")!.disabled).toBe(false);
    fireEvent.click(screen.getByLabelText("imageEditor.undo"));
    expect(screen.getByText("imageEditor.save").closest("button")!.disabled).toBe(true);
  });

  it("有接收方但导出失败（jsdom 无 canvas）：提示 saveFailed，不调用 append，标注保留", async () => {
    const append = vi.fn(() => true);
    const unregister = registerImageComposerTarget({ append });
    const { container } = renderSurface();
    await simulateImageLoad(container);
    fireEvent.click(screen.getByLabelText("imageEditor.pen"));
    drawPenStroke(container);
    fireEvent.click(screen.getByText("imageEditor.save"));
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith("imageEditor.saveFailed");
    });
    expect(append).not.toHaveBeenCalled();
    // 失败保留可编辑历史：保存与撤销回到可用。
    expect(screen.getByText("imageEditor.save").closest("button")!.disabled).toBe(false);
    expect((screen.getByLabelText("imageEditor.undo") as HTMLButtonElement).disabled).toBe(false);

    unregister();
  });

  it("点击视口空白处触发 onClose（宿主据此关闭弹窗）", async () => {
    const onClose = vi.fn();
    const { container } = renderSurface({ onClose });
    await simulateImageLoad(container);
    fireEvent.click(container.querySelector("[data-image-preview-viewport]")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
