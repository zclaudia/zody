import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_LOGIN_API_KEY_SKIP_BUTTON,
  TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_MODEL_PROVIDER_TEMPLATE_BACK_BUTTON,
  TID_MODEL_PROVIDER_TEMPLATE_PICKER,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zody/shared";
import {
  clearAppData,
  clickTestIdByDom,
  readModelProviders,
} from "../../../helpers/desktop-app.js";
import { skipOccupationOnboardingIfPresent } from "../../../helpers/occupation-onboarding.js";

describe("E2E_PROVIDER_EMPTY_STATE 模型设置空状态", () => {
  after(clearAppData);

  it("MP-EMPTY-01/03/04/05：无 Provider 时显示空提示，刷新与添加返回后不再转圈", async function () {
    this.timeout(90_000);
    await browser
      .waitUntil(
        () =>
          browser.execute(
            (skipId, settingsId) =>
              Boolean(
                document.querySelector(`[data-testid="${skipId}"]`) ||
                document.querySelector('[data-testid="onboarding-page"]') ||
                document.querySelector(`[data-testid="${settingsId}"]`),
              ),
            TID_LOGIN_API_KEY_SKIP_BUTTON,
            TID_TASK_SETTINGS_BUTTON,
          ),
        { timeout: 30_000, timeoutMsg: "首启界面未就绪" },
      )
      .catch(async (cause: unknown) => {
        const surface = await browser.execute(() => document.body.innerText.slice(0, 1200));
        throw new Error(`首启界面未就绪，当前界面：${surface}`, { cause });
      });
    if (
      await browser.execute(
        (id) => Boolean(document.querySelector(`[data-testid="${id}"]`)),
        TID_LOGIN_API_KEY_SKIP_BUTTON,
      )
    ) {
      await clickTestIdByDom(TID_LOGIN_API_KEY_SKIP_BUTTON);
    }
    await skipOccupationOnboardingIfPresent();
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
    // runner 会 seed 两个 replay Provider；从真实删除入口移除它们，
    // 同时验证最后一个 Provider 删除后 View 能收敛到空状态，不直接篡改运行中配置。
    for (const provider of await readModelProviders()) {
      const navId = testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${provider.id}`);
      await clickTestIdByDom(navId);
      await $('[data-testid="model-provider-actions-button"]').click();
      await $(
        '//*[@role="menuitem" and (normalize-space(.)="Delete" or normalize-space(.)="删除")]',
      ).click();
      await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM);
      await $(`[data-testid="${navId}"]`).waitForExist({ reverse: true, timeout: 15_000 });
    }
    expect(await readModelProviders()).toHaveLength(0);
    const empty = () => $('[data-model-provider-empty="true"]');
    await empty().waitForDisplayed({ timeout: 15_000 });
    expect(await empty().getText()).toMatch(/No custom model providers yet|暂无自定义模型供应商/);
    // 空状态与页头不再各放一个添加入口：空状态内没有按钮，页头按钮是唯一入口。
    expect(await empty().$("button").isExisting()).toBe(false);
    expect(await $(`[data-testid="${TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON}"]`).isDisplayed()).toBe(
      true,
    );
    expect(await $('[data-model-provider-split-panel="true"]').isExisting()).toBe(false);
    expect(await $('[data-model-provider-navigation-scroll="true"]').isExisting()).toBe(false);
    expect(await $('[data-model-provider-detail-scroll="true"] .animate-spin').isExisting()).toBe(
      false,
    );

    await $('button[aria-label="Refresh"], button[aria-label="刷新"]').click();
    await $('button[aria-label="Refresh"], button[aria-label="刷新"]').waitForClickable({
      timeout: 15_000,
    });
    expect(await empty().isDisplayed()).toBe(true);
    expect(await $('[data-model-provider-detail-scroll="true"] .animate-spin').isExisting()).toBe(
      false,
    );

    await clickTestIdByDom(TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON);
    await $(`[data-testid="${TID_MODEL_PROVIDER_TEMPLATE_PICKER}"]`).waitForDisplayed({
      timeout: 15_000,
    });
    expect(await empty().isExisting()).toBe(false);
    await clickTestIdByDom(TID_MODEL_PROVIDER_TEMPLATE_BACK_BUTTON);
    await empty().waitForDisplayed({ timeout: 15_000 });
    expect(await $('[data-model-provider-detail-scroll="true"] .animate-spin').isExisting()).toBe(
      false,
    );
    expect(await readModelProviders()).toHaveLength(0);
  });
});
