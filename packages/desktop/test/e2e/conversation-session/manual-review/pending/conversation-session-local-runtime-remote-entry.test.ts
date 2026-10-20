import {
  TID_COMPOSER_REMOTE_CONNECTION,
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_REMOTE_KIND_DOCKER,
  TID_REMOTE_KIND_SERVER,
  TID_REMOTE_KIND_SSH,
  TID_REMOTE_KIND_WSL,
  TID_SSH_DIALOG,
  TID_SSH_HOST_INPUT,
} from "@zcode/shared";
import { clearAppData, clickTestIdByWebDriver } from "../../../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";
import { clickLastEnabledSSHDialogButton } from "../../../helpers/ssh-remote-p0.js";

describe("E2E_LOCAL_RUNTIME_ENTRY: SSH/WSL 恢复入口", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("LOCAL-09: 只显示 SSH/Windows WSL，连接设置没有远端下载选项", async function () {
    this.timeout(90_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await clickTestIdByWebDriver(TID_COMPOSER_WORKSPACE_TRIGGER);
    await clickTestIdByWebDriver(TID_COMPOSER_REMOTE_CONNECTION);
    await $(`[data-testid="${TID_SSH_DIALOG}"]`).waitForDisplayed();
    expect(await $(`[data-testid="${TID_REMOTE_KIND_SSH}"]`).isDisplayed()).toBe(true);
    expect(await $(`[data-testid="${TID_REMOTE_KIND_WSL}"]`).isExisting()).toBe(
      process.platform === "win32",
    );
    expect(await $(`[data-testid="${TID_REMOTE_KIND_DOCKER}"]`).isExisting()).toBe(false);
    expect(await $(`[data-testid="${TID_REMOTE_KIND_SERVER}"]`).isExisting()).toBe(false);
    await clickLastEnabledSSHDialogButton("E2E_LOCAL_RUNTIME_ENTRY");
    await $(`[data-testid="${TID_SSH_HOST_INPUT}"]`).waitForDisplayed();
    const text = await $(`[data-testid="${TID_SSH_DIALOG}"]`).getText();
    expect(text).toMatch(/随包运行时|bundled runtime/i);
    expect(text).not.toMatch(/远端服务器下载|Download on remote server/i);
  });
});
