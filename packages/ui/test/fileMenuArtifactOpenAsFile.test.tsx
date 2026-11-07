// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IPlatformService } from "@zody/shared";
import { ZodyIntlProvider } from "@/i18n/IntlProvider.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ArtifactOpenAsFileButton } from "@/file-menu/ArtifactOpenAsFileButton.js";
import { MAX_FILE_COPY_BYTES } from "@/file-menu/fileCopy.js";

// F16③ 定向验证（upstream v3.17.1，来源 SHA a60ba6a7）：产物另存走的是 renderer
// 手里那一版 bytes 的直接判断（file-menu/ArtifactOpenAsFileButton.tsx 的
// ArtifactSaveButton），与文件卡另存为的 readFileCopy 分块链路是两条路径；
// >50 MiB 拒绝（不触碰保存端口、提示超限）此前没有 jsdom 用例（F16② 登记），
// 此处补齐。规则见 docs/ui/file-open-apps.md「另存为」与「产物入口」章节。

const toast = vi.fn();
vi.mock("@/components/ui/toast.js", () => ({
  toast: (...args: unknown[]) => toast(...args),
}));
vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

function renderButton(options: { platform: Partial<IPlatformService>; bytes: Uint8Array | null }) {
  return render(
    createElement(
      ZodyIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        PlatformProvider,
        { platform: options.platform as IPlatformService },
        createElement(ArtifactOpenAsFileButton, {
          runId: "dwfrun-1",
          artifactId: "book",
          version: 1,
          fileName: "审计 报告.pdf",
          bytes: options.bytes,
        }),
      ),
    ),
  );
}

function pointerStubs() {
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { configurable: true, value: () => false },
    releasePointerCapture: { configurable: true, value: () => {} },
    setPointerCapture: { configurable: true, value: () => {} },
    scrollIntoView: { configurable: true, value: () => {} },
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ArtifactOpenAsFileButton 另存为大文件拒绝", () => {
  it("Web 仅保存宿主：>50 MiB 不调用保存端口，提示超限", async () => {
    const saveFile = vi.fn(async () => ({ success: true }));
    renderButton({
      platform: { saveFile },
      // 只依赖 byteLength 判断，零填充分配即可，不构造 50 MiB 真实内容。
      bytes: new Uint8Array(MAX_FILE_COPY_BYTES + 1),
    });

    const button = screen.getByTestId("workflow-artifact-save-as");
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);

    await waitFor(() => expect(toast).toHaveBeenCalledWith("文件超过 50 MiB，无法另存为"));
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("桌面菜单内另存为：>50 MiB 同样拒绝，且不物化副本", async () => {
    pointerStubs();
    const saveFile = vi.fn(async () => ({ success: true }));
    const materializeWorkflowArtifactFile = vi.fn(async () => ({ localPath: "/copies/x.pdf" }));
    renderButton({
      platform: {
        saveFile,
        materializeWorkflowArtifactFile,
        openExternalFile: vi.fn(async () => ({ success: true })),
        getFileApplications: vi.fn(async () => []),
      },
      bytes: new Uint8Array(MAX_FILE_COPY_BYTES + 1),
    });

    const trigger = screen.getByTestId("workflow-artifact-open-as-file-menu");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    const saveItem = await screen.findByText("另存为…");
    fireEvent.click(saveItem);

    await waitFor(() => expect(toast).toHaveBeenCalledWith("文件超过 50 MiB，无法另存为"));
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("恰好 50 MiB 边界不被拒绝，交给保存端口", async () => {
    const saveFile = vi.fn(async () => ({ success: true }));
    renderButton({
      platform: { saveFile },
      bytes: new Uint8Array(MAX_FILE_COPY_BYTES),
    });

    fireEvent.click(screen.getByTestId("workflow-artifact-save-as"));
    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    const payload = saveFile.mock.calls[0]?.[0] as { data: ArrayBuffer };
    expect(payload.data.byteLength).toBe(MAX_FILE_COPY_BYTES);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("已保存"));
  });
});
