// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TID_SETTINGS_PERSONALIZATION_CANCEL,
  TID_SETTINGS_PERSONALIZATION_EDITOR,
  TID_SETTINGS_PERSONALIZATION_SAVE,
  TID_SETTINGS_PERSONALIZATION_SIZE_HINT,
  USER_INSTRUCTIONS_MAX_BYTES,
} from "@zody/shared";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZodyIntl: () => ({
    locale: "zh-CN",
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));

import { PersonalizationSection } from "@/settings/PersonalizationSection.js";

type PersonalizationService = {
  getUserInstructions: ReturnType<typeof vi.fn>;
  saveUserInstructions: ReturnType<typeof vi.fn>;
};

function createService(content = ""): PersonalizationService {
  return {
    getUserInstructions: vi.fn(async () => ({ content, filePath: "/home/.zody/AGENTS.md" })),
    saveUserInstructions: vi.fn(async (next: string) => ({
      filePath: "/home/.zody/AGENTS.md",
      content: next,
    })),
  };
}

function editorValue(): string {
  return (screen.getByTestId(TID_SETTINGS_PERSONALIZATION_EDITOR) as HTMLTextAreaElement).value;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * 设置页「个性化」UI 验收，对应 docs/ui/settings-personalization.md 的 PZ08–PZ11。
 * 组件语义来源：上游 v3.17.1（commit a60ba6a7）PersonalizationSection。
 */
describe("PersonalizationSection", () => {
  it("PZ08 Web/手机端（isDesktop=false）只显示本地桌面端指引，读写服务零调用", () => {
    const service = createService();
    render(
      createElement(PersonalizationSection, {
        settingService: service,
        isDesktop: false,
      }),
    );

    expect(screen.getByText("settings.personalization.localOnly")).toBeTruthy();
    expect(screen.queryByTestId(TID_SETTINGS_PERSONALIZATION_EDITOR)).toBeNull();
    expect(service.getUserInstructions).not.toHaveBeenCalled();
    expect(service.saveUserInstructions).not.toHaveBeenCalled();
  });

  it("PZ09 桌面端读取失败时编辑器禁用并给重试入口，不建立草稿基线", async () => {
    const service = createService();
    service.getUserInstructions.mockRejectedValue(new Error("EACCES"));

    render(createElement(PersonalizationSection, { settingService: service, isDesktop: true }));

    await waitFor(() => {
      expect(screen.getByText("settings.personalization.loadFailed")).toBeTruthy();
    });
    const editor = screen.getByTestId(TID_SETTINGS_PERSONALIZATION_EDITOR) as HTMLTextAreaElement;
    expect(editor.disabled).toBe(true);
    // 失败态提供重试入口；无基线时保存门控必须关闭。
    expect(screen.getByText("common.retry")).toBeTruthy();
    expect(
      (screen.getByTestId(TID_SETTINGS_PERSONALIZATION_SAVE) as HTMLButtonElement).disabled,
    ).toBe(true);

    // 重试成功后恢复可编辑，草稿基线取自重试结果。
    service.getUserInstructions.mockResolvedValue({ content: "重试后的内容", filePath: "/f" });
    fireEvent.click(screen.getByText("common.retry"));
    await waitFor(() => {
      expect(editorValue()).toBe("重试后的内容");
    });
    expect(editor.disabled).toBe(false);
  });

  it("PZ10 桌面端超限草稿阻断保存（按钮与 Ctrl/Cmd+S）且不发起保存调用", async () => {
    const service = createService("基线内容");

    render(createElement(PersonalizationSection, { settingService: service, isDesktop: true }));
    await waitFor(() => {
      expect(editorValue()).toBe("基线内容");
    });

    fireEvent.change(screen.getByTestId(TID_SETTINGS_PERSONALIZATION_EDITOR), {
      target: { value: "ü".repeat(USER_INSTRUCTIONS_MAX_BYTES / 2 + 1) },
    });

    await waitFor(() => {
      expect(screen.getByTestId(TID_SETTINGS_PERSONALIZATION_SIZE_HINT)).toBeTruthy();
    });
    expect(
      (screen.getByTestId(TID_SETTINGS_PERSONALIZATION_SAVE) as HTMLButtonElement).disabled,
    ).toBe(true);

    // Ctrl/Cmd+S 与保存按钮同门控：超限时不发起保存。
    fireEvent.keyDown(screen.getByTestId(TID_SETTINGS_PERSONALIZATION_EDITOR), {
      key: "s",
      metaKey: true,
    });
    expect(service.saveUserInstructions).not.toHaveBeenCalled();

    // 回到限内后保存恢复可用并成功调用。
    fireEvent.change(screen.getByTestId(TID_SETTINGS_PERSONALIZATION_EDITOR), {
      target: { value: "回到限内" },
    });
    await waitFor(() => {
      expect(
        (screen.getByTestId(TID_SETTINGS_PERSONALIZATION_SAVE) as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByTestId(TID_SETTINGS_PERSONALIZATION_SAVE));
    await waitFor(() => {
      expect(service.saveUserInstructions).toHaveBeenCalledWith("回到限内");
    });
  });

  it("PZ11 未保存草稿跨分区切换存活（文件未变时），取消丢弃修改恢复基线", async () => {
    const service = createService("磁盘基线");

    const { unmount } = render(
      createElement(PersonalizationSection, { settingService: service, isDesktop: true }),
    );
    await waitFor(() => {
      expect(editorValue()).toBe("磁盘基线");
    });
    fireEvent.change(screen.getByTestId(TID_SETTINGS_PERSONALIZATION_EDITOR), {
      target: { value: "未保存草稿" },
    });

    // 切走分区（卸载）再回来：模块级 store 是草稿唯一所有者，文件内容仍等于基线时恢复草稿。
    unmount();
    render(createElement(PersonalizationSection, { settingService: service, isDesktop: true }));
    await waitFor(() => {
      expect(editorValue()).toBe("未保存草稿");
    });

    // 取消丢弃修改，恢复已保存内容。
    fireEvent.click(screen.getByTestId(TID_SETTINGS_PERSONALIZATION_CANCEL));
    expect(editorValue()).toBe("磁盘基线");
  });

  it("个性化分区文案在中英文 locale 中成对提供", () => {
    const keys = [
      "settings.personalization.title",
      "settings.personalization.description",
      "settings.personalization.placeholder",
      "settings.personalization.editorLabel",
      "settings.personalization.saved",
      "settings.personalization.saveFailed",
      "settings.personalization.loadFailed",
      "settings.personalization.localOnly",
      "settings.personalization.unsaved",
      "settings.personalization.sizeCount",
      "settings.personalization.sizeOverLimit",
    ] as const;

    for (const key of keys) {
      expect(enUS[key], `en-US 缺少 ${key}`).toBeTruthy();
      expect(zhCN[key], `zh-CN 缺少 ${key}`).toBeTruthy();
    }
  });
});
