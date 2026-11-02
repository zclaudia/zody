import { describe, expect, it } from "vitest";
import { isImeCompositionEnterEvent } from "../src/mentions/MentionPlugin.js";

/**
 * 走查 composer-2：@ / / 面板打开时用中文输入法搜索，确认拼音组合的 Enter
 * 会被 CRITICAL 优先级的面板 Enter 处理器拦截为「选中高亮建议」，组合中的
 * 拼音被 mention 替换。两处面板（MentionPlugin / SlashCommandPlugin）共用
 * isImeCompositionEnterEvent 判定，这里验证判定本身的所有分支。
 */
describe("isImeCompositionEnterEvent", () => {
  it("isComposing=true 的 Enter 视为组合确认，不拦截为面板选中", () => {
    expect(isImeCompositionEnterEvent({ isComposing: true, keyCode: 13 })).toBe(true);
  });

  it("keyCode=229 兜底视为组合期（旧 WebView 不置 isComposing 的场景）", () => {
    expect(isImeCompositionEnterEvent({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeCompositionEnterEvent({ isComposing: true, keyCode: 229 })).toBe(true);
  });

  it("普通 Enter（非组合）保持既有行为，正常选中面板建议", () => {
    expect(isImeCompositionEnterEvent({ isComposing: false, keyCode: 13 })).toBe(false);
    // Lexical 从移动端合成派发时 keyCode 可能为 0。
    expect(isImeCompositionEnterEvent({ isComposing: false, keyCode: 0 })).toBe(false);
  });

  it("事件为 null/undefined（手动 fireCommand）按非组合处理，不改变桌面行为", () => {
    expect(isImeCompositionEnterEvent(null)).toBe(false);
    expect(isImeCompositionEnterEvent(undefined)).toBe(false);
  });
});
