import { useCallback, useState } from "react";
import {
  TID_V4_USER_INPUT_DIALOG,
  TID_V4_USER_INPUT_OPTION,
  TID_V4_USER_INPUT_TEXT,
  testId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import type { V4UserInputViewModel } from "@/v4/pendingInteractionAdapter.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { useIsMobileTextInputViewport } from "@/lib/mobileTextInput.js";

export interface V4UserInputDialogProps {
  model: V4UserInputViewModel;
  onSubmit: (answer: { optionId?: string; freeText?: string }) => void;
}

/** v4 userInput 交互最小弹窗（竖切）。 */
export function V4UserInputDialog({ model, onSubmit }: V4UserInputDialogProps) {
  const [freeText, setFreeText] = useState("");
  // Bugfix(keyboard-2): 该弹窗也渲染在手机 Web 远控（agent 阻塞等待用户输入的关键路径），
  // 14px 输入框聚焦会触发 iOS Safari 页面放大；手机触屏视口用固定 16px 平台兼容 token，
  // 桌面与宽屏 Web 不附加该类、保持原有字号。
  const isMobileTextInputViewport = useIsMobileTextInputViewport();

  const handleOption = useCallback(
    (optionId: string) => {
      runUserAction({
        input: { featureId: "conversation.blocking.user_input", action: "select_option", trigger: "button" },
        operation: () => onSubmit({ optionId }),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "user_input_submit",
      });
    },
    [onSubmit],
  );

  const handleFreeTextSubmit = useCallback(() => {
    const trimmed = freeText.trim();
    if (!trimmed && model.freeText) return;
    onSubmit(model.freeText ? { freeText: trimmed } : { optionId: model.options[0]?.optionId });
  }, [freeText, model.freeText, model.options, onSubmit]);

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black/40 p-4"
      data-testid={TID_V4_USER_INPUT_DIALOG}
    >
      {/* Bugfix(dialogs-1): 卡片限高并内部滚动——选项多或键盘弹起时内容不再超出视口且可滚动。
          外层从单层居中改为纵向 flex：末尾占位元素消费 .zcode-keyboard-inset-bottom（spec D2，
          iOS 软键盘弹起时把居中区域整体顶起，输入框/提交按钮不被键盘遮挡；桌面占位高度为 0，
          渲染与原单层居中完全一致）。 */}
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="max-h-full w-full max-w-lg overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-lg">
          <p className="mb-3 text-ui-base text-[var(--color-foreground)]">{model.prompt}</p>
          {model.options.length > 0 ? (
            <div className="mb-3 flex flex-col gap-2">
              {model.options.map((option) => (
                <Button
                  key={option.optionId}
                  type="button"
                  variant="outline"
                  data-testid={testId(TID_V4_USER_INPUT_OPTION, option.optionId)}
                  onClick={() => handleOption(option.optionId)}
                  // 触控目标 ≥44×44px（spec D1）：手机触屏态抬升命中区，桌面保持 h-7 密度。
                  className="[@media(hover:none)_and_(pointer:coarse)]:min-h-11"
                >
                  {option.label}
                </Button>
              ))}
            </div>
          ) : null}
          {model.freeText ? (
            <div className="flex flex-col gap-2">
              <Input
                type={model.sensitive ? "password" : "text"}
                value={freeText}
                onChange={(event) => setFreeText(event.target.value)}
                data-testid={TID_V4_USER_INPUT_TEXT}
                className={isMobileTextInputViewport ? "text-mobile-input-safe leading-6" : undefined}
              />
              <Button
                type="button"
                onClick={handleFreeTextSubmit}
                className="[@media(hover:none)_and_(pointer:coarse)]:min-h-11"
              >
                提交
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      {/* 键盘避让占位：写入口唯一所有者是 installMobileKeyboardInsetTracker（spec D2 §2.2），
          这里只读变量；收起时回落到安全区，桌面 env/变量均为 0，不产生额外空间。 */}
      <div className="zcode-keyboard-inset-bottom shrink-0" aria-hidden="true" />
    </div>
  );
}
