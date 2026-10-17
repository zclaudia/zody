import { join } from "node:path";
import { skipOccupationOnboardingIfPresent } from "../helpers/occupation-onboarding.js";
import { seedSettings, waitForDefaultWorkspaceReady } from "../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../helpers/v4-conversation.js";

/**
 * RC-E2E-DIALOG-01：打开远控弹层只查看状态，不再顺带启动远控；Bot 入口保持可用。
 *
 * 旧行为在弹层的打开 effect 里直接调用 `startWebRemoteControl`，所以「打开弹层」和「开启远控」
 * 是同一次动作。这条用例锁住解耦后的行为：打开后动作按钮停在「开启」，只有用户显式点击才启动。
 */
// 侧边栏入口和弹层文案都由 locale 决定：这里同时接受固定后的中英文标签，避免 locale 未生效时误判入口不存在。
const REMOTE_CONTROL_TRIGGER =
  'button[aria-label="移动端远程控制"], button[aria-label="Mobile remote control"]';
const DIALOG_SCROLL = '[data-testid="web-remote-control-dialog-scroll"]';
const START_BUTTON = '[data-testid="web-remote-control-start"]';
const STOP_BUTTON = '[data-testid="web-remote-control-stop"]';
const OPEN_BOTS_ENTRY = '[data-testid="web-remote-control-open-bots"]';
// 弹层和 Bot 入口都按文案定位时依赖中文 locale，先固定 locale 再打开入口。
const START_LABEL = "开启";
const QR_IDLE_HINT = "点击「开启」后这里会显示二维码。";
const BOTS_DIALOG_TITLE = "机器人";

describe("远控弹层打开不自动启动", () => {
  it("打开弹层保持未开启状态，并保留可用的 Bots 入口", async () => {
    // 与 bots 域的弹层用例保持一致的前置：先过职业引导，再准备 v4 外壳，最后固定 locale 并刷新。
    await skipOccupationOnboardingIfPresent();
    await prepareV4ConversationE2E({ skipProvider: true });
    await seedSettings({ locale: "zh-CN", localePreference: "zh-CN" });
    await browser.refresh();
    await waitForDefaultWorkspaceReady(60000);

    const trigger = await $(REMOTE_CONTROL_TRIGGER);
    await trigger.waitForClickable({ timeout: 20000 });
    await trigger.click();

    const dialog = await $(DIALOG_SCROLL);
    await dialog.waitForDisplayed({ timeout: 20000 });

    const startButton = await $(START_BUTTON);
    await startButton.waitForDisplayed({ timeout: 20000 });
    expect(await startButton.getText()).toBe(START_LABEL);
    expect(await $(STOP_BUTTON).isExisting()).toBe(false);
    expect(await dialog.getText()).toContain(QR_IDLE_HINT);

    // 旧实现会在打开弹层的同一次 effect 里 start，状态随即离开 idle；
    // 这里等一个稳定窗口后再确认仍停在未开启态，用来证明打开动作没有触发 start。
    await browser.pause(3000);
    expect(await $(START_BUTTON).isExisting()).toBe(true);
    expect(await $(STOP_BUTTON).isExisting()).toBe(false);
    expect(await dialog.getText()).toContain(QR_IDLE_HINT);

    // Bots 入口抽成独立组件后 data-testid 不变，并且仍然能打开 Bots 弹窗。
    const openBots = await $(OPEN_BOTS_ENTRY);
    await openBots.waitForClickable({ timeout: 20000 });
    await openBots.click();
    await browser.waitUntil(
      () =>
        browser.execute((titleText) => {
          return Array.from(document.querySelectorAll<HTMLElement>("[role=dialog]")).some(
            (candidate) => Boolean(candidate.textContent?.includes(titleText)),
          );
        }, BOTS_DIALOG_TITLE),
      { interval: 500, timeout: 20000, timeoutMsg: "Bots 入口没有打开 Bots 弹窗" },
    );

    const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR?.trim();
    if (artifactDir) {
      await browser.saveScreenshot(join(artifactDir, "RC-E2E-DIALOG-01.png"));
    }
  });
});
