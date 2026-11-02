import {
  buildRemoteWorkspaceIdentity,
  TID_COMPOSER_REMOTE_CONNECTION,
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_REMOTE_KIND_WSL,
  TID_SSH_DIALOG,
  TID_WSL_USER_INPUT,
  type RemoteTarget,
} from "@zody/shared";
import {
  clearAppData,
  clickTestIdByWebDriver,
  setInputValueByTestIdDom,
  waitForWorkspaceApp,
} from "../../../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";
import {
  clickLastEnabledSSHDialogButton,
  readHostProcesses,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
} from "../../../helpers/ssh-remote-p0.js";

// WSL 是 Windows 原生环境型用例；非 Windows 不伪造 WSL 连接成功。
(process.platform === "win32" ? describe : describe.skip)(
  "E2E_WSL_LOCAL_RUNTIME: 默认发行版本机上传",
  () => {
    after(async () => {
      await browser.electron.restoreAllMocks();
      await clearAppData();
    });

    it("LOCAL-02: 本地 Linux 资源部署后工作区可用且只有一个窗口 Host", async function () {
      this.timeout(15 * 60_000);
      const workspacePath = process.env.ZCODE_E2E_WSL_WORKSPACE_PATH;
      if (!workspacePath?.startsWith("/"))
        throw new Error("LOCAL-02 requires ZCODE_E2E_WSL_WORKSPACE_PATH on the default WSL distro");
      const user = process.env.ZCODE_E2E_WSL_USER?.trim() || undefined;
      await prepareV4ConversationE2E({ skipProvider: true });
      const hosts = await readHostProcesses();
      expect(hosts).toHaveLength(1);
      await clickTestIdByWebDriver(TID_COMPOSER_WORKSPACE_TRIGGER);
      await clickTestIdByWebDriver(TID_COMPOSER_REMOTE_CONNECTION);
      await $(`[data-testid="${TID_SSH_DIALOG}"]`).waitForDisplayed();
      await clickTestIdByWebDriver(TID_REMOTE_KIND_WSL);
      await clickLastEnabledSSHDialogButton("E2E_WSL_LOCAL_RUNTIME");
      await $(`[data-testid="${TID_WSL_USER_INPUT}"]`).waitForDisplayed();
      if (user) await setInputValueByTestIdDom(TID_WSL_USER_INPUT, user);
      await clickLastEnabledSSHDialogButton("E2E_WSL_LOCAL_RUNTIME");
      await waitForSSHDirectoryStep("E2E_WSL_LOCAL_RUNTIME");
      await selectSSHRemoteDirectory(workspacePath, "E2E_WSL_LOCAL_RUNTIME");
      await waitForWorkspaceApp(workspacePath, 120_000);
      // Main 会把默认发行版/用户解析成稳定身份，不能用空 distro 手写期望 identity。
      const target = await browser.execute((path) => {
        const state = (
          window as Window & {
            __zcodeTabStoreE2E?: {
              getState(): { tabs: Array<{ workspacePath?: string; remoteTarget?: RemoteTarget }> };
            };
          }
        ).__zcodeTabStoreE2E?.getState();
        return state?.tabs.find(
          (tab) => tab.workspacePath === path && tab.remoteTarget?.kind === "wsl",
        )?.remoteTarget;
      }, workspacePath);
      if (target?.kind !== "wsl" || !target.distro)
        throw new Error("LOCAL-02 missing resolved WSL distro identity");
      const tab = await waitForRemoteTab({
        caseMarker: "E2E_WSL_LOCAL_RUNTIME",
        expectedIdentity: buildRemoteWorkspaceIdentity(workspacePath, target),
        expectedPath: workspacePath,
      });
      expect(tab.remoteKind).toBe("wsl");
      expect(await readHostProcesses()).toEqual(hosts);
    });
  },
);
