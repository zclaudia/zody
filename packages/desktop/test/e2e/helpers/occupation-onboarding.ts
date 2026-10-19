import { TID_TASK_SETTINGS_BUTTON } from "@zcode/shared";
import { sel } from "./selectors.js";

// 新隔离 profile 的职业引导会覆盖工作区；通过真实 UI 完成，不伪造业务记录。
export async function skipOccupationOnboardingIfPresent() {
  // 修复原因：首启停在「职业引导与设置入口都尚未渲染」的过渡态（如 fork 的 BYOK
  // WelcomeScreen 阶段）时，$().isExisting() 会以 no such element 直接抛错而不是
  // 返回 false，waitUntil 把条件函数的异常原样上抛导致用例误报；轮询条件必须
  // 自吞元素缺失，让 waitUntil 只按超时语义判定。
  const isExistingSafe = async (selector: string) => {
    try {
      return await $(selector).isExisting();
    } catch {
      return false;
    }
  };
  await browser.waitUntil(
    async () =>
      (await isExistingSafe('[data-testid="onboarding-page"]')) ||
      (await isExistingSafe(sel(TID_TASK_SETTINGS_BUTTON))),
    { timeout: 30000 },
  );
  // 新隔离 profile 可能进入职业引导，按真实 UI 跳过三步，不改全局测试夹具。
  for (
    let step = 0;
    step < 3 && (await $('[data-testid="onboarding-page"]').isExisting());
    step++
  ) {
    const skip = $('//button[normalize-space(.)="Skip" or normalize-space(.)="跳过"]');
    await skip.waitForClickable({ timeout: 15000 });
    await skip.click();
  }
  await $('[data-testid="onboarding-page"]').waitForExist({ reverse: true, timeout: 15000 });
}

// 用产品支持的 Escape 退出引导（与“退出引导”按钮同一 closeOnboarding 路径，且不依赖界面语言）：
// 只持久化 dismissed 决策，不像“跳过”那样把 memoryEnabled 等偏好落成保守默认值，
// 供通用工作区就绪等待使用。
export async function dismissOccupationOnboarding() {
  await browser.keys("Escape");
}
