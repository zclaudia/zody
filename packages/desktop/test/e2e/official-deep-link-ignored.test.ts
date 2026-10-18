import {
  TID_OAUTH_ERROR,
  TID_OAUTH_LOGIN_BUTTON,
  TID_TASK_SETTINGS_BUTTON,
} from "@zcode/shared";
import { clearAppData, waitForTestIdByDom } from "./helpers/desktop-app.js";

/**
 * fork F4.1a 场景 3：官方账号深链被忽略。
 *
 * 产品规则（总纲阶段 4）：`zcode://oauth/callback`、`zcode://payment/callback`
 * 收到时忽略并记 info 日志，不报错弹窗，也不把用户带进 OAuth/支付流程。
 *
 * 触发方式与既有 OAuth spec 相同：向 Electron app 投递 `open-url` 事件。
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

describe("F4.1a 官方账号深链被忽略", () => {
  after(async () => {
    await clearAppData();
  });

  it("oauth/callback 深链只被忽略，不打开 OAuth 流程也不弹错误", async () => {
    await enterMainWorkspaceAfterOnboarding();

    const delivered = await browser.electron.execute((electron) => {
      electron.app.emit(
        "open-url",
        { preventDefault() {} } as never,
        "zcode://oauth/callback?code=e2e-auth-code&state=e2e-ignored-state",
      );
      return true;
    });
    expect(delivered).toBe(true);

    await browser.pause(3_000);
    expectNoOAuthSurface();
  });

  it("payment/callback 深链只被忽略，不弹错误", async () => {
    await enterMainWorkspaceAfterOnboarding();

    const delivered = await browser.electron.execute((electron) => {
      electron.app.emit(
        "open-url",
        { preventDefault() {} } as never,
        "zcode://payment/callback?provider=zai&channel=alipay&status=success",
      );
      return true;
    });
    expect(delivered).toBe(true);

    await browser.pause(3_000);
    expectNoOAuthSurface();
  });
});

async function expectNoOAuthSurface(): Promise<void> {
  // 深链被忽略：不弹 OAuth 登录面板（欢迎屏保持关闭），也不渲染 OAuth 错误提示。
  const oauthSurface = (await browser.execute(
    (oauthButtonId, oauthErrorId) => ({
      oauthLoginButtons: document.querySelectorAll(`[data-testid="${oauthButtonId}"]`).length,
      oauthError: document.querySelector<HTMLElement>(`[data-testid="${oauthErrorId}"]`)
        ?.textContent,
      appHeaderVisible: Boolean(document.querySelector(`[data-testid="${"app-header"}"]`)),
    }),
    TID_OAUTH_LOGIN_BUTTON,
    TID_OAUTH_ERROR,
  )) as { oauthLoginButtons: number; oauthError: string | null; appHeaderVisible: boolean };

  expect(oauthSurface.oauthLoginButtons).toBe(0);
  expect(oauthSurface.oauthError ?? null).toBeNull();
  expect(oauthSurface.appHeaderVisible).toBe(true);
}
