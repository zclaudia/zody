import { join } from "node:path";
import { dismissOccupationOnboarding } from "../helpers/occupation-onboarding.js";
import { seedSettings, waitForDefaultWorkspaceReady } from "../helpers/desktop-app.js";

/**
 * RC-E2E-DIALOG-02（T4.1）：远控弹层只展示 App 级远程访问状态并提供快捷开关。
 *
 * 旧弹层在打开时自动启动 relay 会话并生成二维码；改走 gateway 后，开关、gateway 地址和
 * backend 凭证都归设置页管理。这条用例锁住两件事：
 * 1. 打开弹层不会启动任何远控会话（没有二维码/链接）；
 * 2. 弹层展示全局 gateway 与手机状态。
 */
// 侧边栏入口和弹层文案都由 locale 决定：同时接受中英文标签，避免 locale 未生效时误判入口不存在。
const REMOTE_CONTROL_TRIGGER =
  'button[aria-label="移动端远程控制"], button[aria-label="Mobile remote control"]';
const DIALOG_SCROLL = '[data-testid="web-remote-control-dialog-scroll"]';
const STATUS_CARD = '[data-testid="web-remote-control-status-card"]';
const REMOTE_ACCESS_SWITCH = '[data-testid="web-remote-control-remote-access-switch"]';
const GATEWAY_STATUS = '[data-testid="web-remote-control-gateway-status"]';
const MOBILE_STATUS = '[data-testid="web-remote-control-mobile-status"]';
const SETTINGS_HINT = '[data-testid="web-remote-control-settings-hint"]';

async function openRemoteControlDialog() {
  await browser.waitUntil(async () => (await $(REMOTE_CONTROL_TRIGGER)).isExisting(), {
    timeout: 30000,
    timeoutMsg: "侧边栏没有渲染移动端远程控制入口",
  });
  // 入口在 Electron drag 区附近，WebDriver clickable 偶尔会被浮层判定挡住；
  // 这里用 DOM click，仍然走 React 的真实 onClick 链路。
  await browser.execute((selector) => {
    document.querySelector<HTMLElement>(selector)?.click();
  }, REMOTE_CONTROL_TRIGGER);
  await $(DIALOG_SCROLL).waitForDisplayed({ timeout: 20000 });
}

describe("远控弹层展示全局远程访问状态", () => {
  // fork（bot channels 移除）：Bots 入口与 web-remote-control-open-bots testid 已随
  // bot channels 删除，原「保留 Bots 入口」断言一并移除；远控弹窗本体改为单列布局。
  it("打开弹层不启动远控，展示全局状态", async () => {
    await dismissOccupationOnboarding();
    await seedSettings({
      locale: "zh-CN",
      localePreference: "zh-CN",
      remoteAccess: { enabled: false, gatewayUrl: "", namespace: "zcode" },
    });
    await browser.refresh();
    await waitForDefaultWorkspaceReady(60000);

    const trigger = await $(REMOTE_CONTROL_TRIGGER);
    expect(await trigger.isExisting()).toBe(true);
    await openRemoteControlDialog();

    const dialog = await $(DIALOG_SCROLL);
    await dialog.waitForDisplayed({ timeout: 20000 });
    await $(STATUS_CARD).waitForDisplayed({ timeout: 20000 });

    const remoteAccessSwitch = await $(REMOTE_ACCESS_SWITCH);
    expect(await remoteAccessSwitch.getAttribute("data-state")).toBe("unchecked");
    expect(await $(GATEWAY_STATUS).getAttribute("data-state")).toBe("disabled");
    expect(await $(MOBILE_STATUS).getAttribute("data-connected")).toBe("false");
    expect(await $(SETTINGS_HINT).isDisplayed()).toBe(true);
    // 改走 gateway 后弹层不再有二维码、复制链接和刷新按钮。
    expect(await dialog.$("img[alt]:not([alt=''])").isExisting()).toBe(false);
    expect(await dialog.$('button[aria-label="webRemoteControl.copyLink"]').isExisting()).toBe(
      false,
    );

    // 打开动作本身不能隐式启动远控：等一个稳定窗口后开关仍保持关闭。
    await browser.pause(3000);
    expect(await remoteAccessSwitch.getAttribute("data-state")).toBe("unchecked");
    expect(await $(GATEWAY_STATUS).getAttribute("data-state")).toBe("disabled");

    const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR?.trim();
    if (artifactDir) {
      await browser.saveScreenshot(join(artifactDir, "RC-E2E-DIALOG-02.png"));
    }
  });

  it("配置不完整时快捷开关进入 unconfigured 状态", async () => {
    await dismissOccupationOnboarding();
    await seedSettings({
      locale: "zh-CN",
      localePreference: "zh-CN",
      remoteAccess: { enabled: false, gatewayUrl: "", namespace: "zcode" },
    });
    await browser.refresh();
    await waitForDefaultWorkspaceReady(60000);

    const trigger = await $(REMOTE_CONTROL_TRIGGER);
    expect(await trigger.isExisting()).toBe(true);
    await openRemoteControlDialog();

    await $(REMOTE_ACCESS_SWITCH).click();
    await browser.waitUntil(
      async () => (await $(GATEWAY_STATUS).getAttribute("data-state")) === "error",
      { interval: 500, timeout: 20000, timeoutMsg: "远程访问开关没有把 gateway 状态切到 error" },
    );
    expect(await $(GATEWAY_STATUS).getAttribute("data-reason")).toBe("unconfigured");
    expect(await $(REMOTE_ACCESS_SWITCH).getAttribute("data-state")).toBe("checked");
    expect(await $(SETTINGS_HINT).isDisplayed()).toBe(true);

    // 恢复关闭，避免把开启状态泄漏给同文件后续用例。
    await $(REMOTE_ACCESS_SWITCH).click();
    await browser.waitUntil(
      async () => (await $(GATEWAY_STATUS).getAttribute("data-state")) === "disabled",
      { interval: 500, timeout: 20000, timeoutMsg: "关闭远程访问后 gateway 状态没有回到 disabled" },
    );
  });
});
