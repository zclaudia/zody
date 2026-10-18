import {
  TID_OAUTH_ERROR,
  TID_OAUTH_LOGIN_BUTTON,
  TID_TASK_SETTINGS_BUTTON,
  TID_V4_COMPOSER,
} from "@zcode/shared";
import { clearAppData, waitForTestIdByDom } from "./helpers/desktop-app.js";

/**
 * fork F4.1a 场景 1：全新安装 BYOK 首启。
 *
 * F4.1c 基座默认「无官方账号、无 providerFamilyDomain、已种入本地桩 BYOK provider」。
 * 登录门改为 `!hasUsableProvider` 后，全新安装不应再被强制推进欢迎登录页：
 * 应用直接进入主界面，欢迎屏的 OAuth 登录按钮不出现。
 */

/** 全新安装首启会先显示使用引导；与 help-menu-about 相同用 Escape 退出后进工作区。 */
async function enterMainWorkspaceAfterOnboarding(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const onboarding = await $('[data-testid="onboarding-page"]');
      if (await onboarding.isDisplayed()) await browser.keys("Escape");
      return $(`[data-testid="${TID_TASK_SETTINGS_BUTTON}"]`).isExisting();
    },
    { timeout: 60_000, timeoutMsg: "首启引导关闭后未进入工作区" },
  );
}

describe("F4.1a 全新安装 BYOK 首启", () => {
  after(async () => {
    await clearAppData();
  });

  it("无官方账号数据时首启直接进入主界面，不弹欢迎登录页", async () => {
    await enterMainWorkspaceAfterOnboarding();

    // 登录门若仍以 providerFamilyDomain 判定，这里会以 startup-provider-required
    // 打开欢迎屏并渲染 OAuth 登录按钮；BYOK 桩可用时必须保持关闭。
    await browser.pause(3_000);
    const oauthLoginButtonCount = await browser.execute(
      (oauthButtonId) =>
        document.querySelectorAll(`[data-testid="${oauthButtonId}"]`).length,
      TID_OAUTH_LOGIN_BUTTON,
    );
    expect(oauthLoginButtonCount).toBe(0);

    const oauthErrorText = await browser.execute(
      (oauthErrorId) =>
        document.querySelector<HTMLElement>(`[data-testid="${oauthErrorId}"]`)?.textContent ?? null,
      TID_OAUTH_ERROR,
    );
    expect(oauthErrorText).toBeNull();

    // 主界面具备可交互的会话输入区，证明 BYOK provider 视图水合完成。
    await waitForTestIdByDom(TID_V4_COMPOSER, {
      timeout: 30_000,
      timeoutMsg: "首启后 v4 composer 未渲染，BYOK provider 视图未就绪",
    });
  });
});
