// F26④（上游 v3.17.1 a60ba6a7）：YOLO 模式切换三入口中「菜单 + cycleSessionMode 快捷键」
// 两入口的桌面 E2E；权限对话框入口由 PA158 pending spec 的「先确认一次」步骤覆盖。
// 镜像上游 conversation-session/conversation-session-yolo-confirmation.test.ts（YC01/02/07），
// 用例裁决对应本仓 catalog PA159-01/02/03（docs/yolo-mode-risk-confirmation.md）。
// manual-review/pending：人工评审与转正未完成，不计为正式 Desktop 通过。
import {
  getV4ModelConfig,
  prepareV4ConversationE2E,
  switchV4Mode,
} from "../../../helpers/v4-conversation.js";
import { TID_CHAT_MODE_SELECT_TRIGGER, TID_CHAT_MODE_SELECT_ITEM, testId } from "@zody/shared";

async function selectYolo() {
  await $(`[data-testid="${TID_CHAT_MODE_SELECT_TRIGGER}"]`).click();
  await $(`[data-testid="${testId(TID_CHAT_MODE_SELECT_ITEM, "yolo")}"]`).click();
  await $('[data-testid="yolo-confirmation-dialog"]').waitForDisplayed();
  expect(await $('[data-testid="yolo-confirmation-confirm"]').isEnabled()).toBe(false);
  expect(await $('[data-testid="yolo-confirmation-risk"]').getAttribute("aria-checked")).toBe(
    "false",
  );
}

describe("YC01/02/07 YOLO 切换确认", () => {
  before(async () => {
    await prepareV4ConversationE2E();
  });
  it("取消、Escape、确认和快捷键都保持提交前确认边界", async () => {
    for (const mode of ["build", "guarded"]) {
      await switchV4Mode(mode);
      const before = await getV4ModelConfig();
      await selectYolo();
      expect(await getV4ModelConfig()).toEqual(before);
      await $('[data-testid="yolo-confirmation-risk"]').click();
      expect(await $('[data-testid="yolo-confirmation-confirm"]').isEnabled()).toBe(true);
      expect(await getV4ModelConfig()).toEqual(before);
      await $('[data-testid="yolo-confirmation-cancel"]').click();
      expect(await getV4ModelConfig()).toEqual(before);
      await selectYolo();
      await $('[data-testid="yolo-confirmation-risk"]').click();
      await browser.keys("Escape");
      await $('[data-testid="yolo-confirmation-dialog"]').waitForDisplayed({ reverse: true });
      expect(await getV4ModelConfig()).toEqual(before);
      await switchV4Mode("yolo");
      expect((await getV4ModelConfig()).mode).toBe("yolo");
    }
    await switchV4Mode("guarded");
    await browser.keys(["Control", "Shift", "m"]);
    await browser.keys(["NULL"]);
    await $('[data-testid="yolo-confirmation-dialog"]').waitForDisplayed();
    expect(await $('[data-testid="yolo-confirmation-confirm"]').isEnabled()).toBe(false);
    await browser.keys(["Control", "Shift", "m"]);
    await browser.keys(["NULL"]);
    expect((await getV4ModelConfig()).mode).toBe("guarded");
    await $('[data-testid="yolo-confirmation-risk"]').click();
    expect(await $('[data-testid="yolo-confirmation-confirm"]').isEnabled()).toBe(true);
    await browser.keys("Space");
    expect(await $('[data-testid="yolo-confirmation-confirm"]').isEnabled()).toBe(false);
    await browser.keys("Enter");
    expect((await getV4ModelConfig()).mode).toBe("guarded");
    await browser.keys("Space");
    await $('[data-testid="yolo-confirmation-confirm"]').click();
    expect((await getV4ModelConfig()).mode).toBe("yolo");
  });
});
