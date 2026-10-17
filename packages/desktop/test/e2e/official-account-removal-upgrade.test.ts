import { readFile } from "node:fs/promises";
import { TID_OAUTH_ERROR, TID_OAUTH_LOGIN_BUTTON, TID_TASK_SETTINGS_BUTTON } from "@zcode/shared";
import { clearAppData, getE2EAppDataPaths, waitForTestIdByDom } from "./helpers/desktop-app.js";
import { reloadElectronSessionSafely } from "./helpers/e2e-electron-reload.js";

/**
 * fork F4.1a 场景 2：从带官方账号数据的旧版本升级。
 *
 * wdio.conf 的 seed（isOfficialAccountRemovalUpgradeSpec）为该 spec 预置旧版本存量：
 * - provider_config.json 的 defaultModelSelection 指向 account:*；
 * - agents-state.json 的内置子代理覆盖指向 account:*；
 * - credentials.json 携带 oauth:* / zcodejwttoken；
 * - app settings 保留 providerFamilyDomain。
 *
 * 升级后产品规则：启动不失败、不弹欢迎登录页（BYOK 桩可用），存量官方账号数据
 * 按 F4.1a 迁移清理，且绝不静默改选其他付费 provider（defaultModelSelection 清空）。
 */

interface StoredProviderConfigFile {
  config?: { defaultModelSelection?: { providerId?: string; modelId?: string } | null };
}

interface StoredAgentsStateFile {
  // 磁盘缺字段时值为 undefined；展开 undefined 是 no-op，无需空对象兜底。
  builtInModelSelectionOverrides: Record<string, unknown>;
  pluginAgentModelSelectionOverrides: Record<string, unknown>;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf-8")) as T;
}

/** 全新/升级首启会先显示使用引导；与 help-menu-about 相同用 Escape 退出后进工作区。 */
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

async function expectNoWelcomeLoginSurface(): Promise<void> {
  // 登录门若仍以 providerFamilyDomain/user 判定，这里会以 startup-provider-required
  // 打开欢迎屏并渲染 OAuth 登录按钮；BYOK 桩可用时必须保持关闭。
  await browser.pause(3_000);
  const oauthLoginButtonCount = await browser.execute(
    (oauthButtonId) => document.querySelectorAll(`[data-testid="${oauthButtonId}"]`).length,
    TID_OAUTH_LOGIN_BUTTON,
  );
  expect(oauthLoginButtonCount).toBe(0);
  const oauthErrorText = await browser.execute(
    (oauthErrorId) =>
      document.querySelector<HTMLElement>(`[data-testid="${oauthErrorId}"]`)?.textContent ?? null,
    TID_OAUTH_ERROR,
  );
  expect(oauthErrorText).toBeNull();
}

describe("F4.1a 从带官方账号数据的旧版本升级", () => {
  after(async () => {
    await clearAppData();
  });

  it("Host 侧存量官方账号数据在启动迁移中被清理，模型选择回落「未配置」", async () => {
    await enterMainWorkspaceAfterOnboarding();
    await expectNoWelcomeLoginSurface();

    const { appDataDir, credentialsFile } = getE2EAppDataPaths();
    const providerConfigFile = `${appDataDir}/provider_config.json`;
    const agentsStateFile = `${appDataDir}/agents-state.json`;

    // 迁移在 Host 启动早期执行；文件读取等启动写回稳定后再断言。
    await browser.waitUntil(
      async () => {
        const providerConfig = await readJson<StoredProviderConfigFile>(providerConfigFile);
        return providerConfig.config?.defaultModelSelection === undefined;
      },
      {
        timeout: 30_000,
        timeoutMsg: "provider_config.json 的 account:* defaultModelSelection 没有被清空",
      },
    );

    await browser.waitUntil(
      async () => {
        const credentials = await readJson<Record<string, string>>(credentialsFile);
        const officialKeys = Object.keys(credentials).filter(
          (key) => key.startsWith("oauth:") || key === "zcodejwttoken",
        );
        return officialKeys.length === 0;
      },
      { timeout: 30_000, timeoutMsg: "credentials.json 的官方账号键没有被清理" },
    );

    const agentsState = await readJson<StoredAgentsStateFile>(agentsStateFile);
    const overrideEntries = Object.values({
      ...agentsState.builtInModelSelectionOverrides,
      ...agentsState.pluginAgentModelSelectionOverrides,
    }) as Array<{ providerId?: string } | undefined>;
    const leftoverAccountOverrides = overrideEntries.filter((entry) =>
      entry?.providerId?.startsWith("account:"),
    );
    // wdio 的 expect 不支持第二参数消息；失败时把残留条目并入断言值以便诊断。
    expect(
      leftoverAccountOverrides.map(
        (entry) => `providerId=${entry?.providerId ?? "<undefined>"}`,
      ),
    ).toEqual([]);

    // app settings 的 providerFamilyDomain 保留可解析（schema 兼容读取，不删字段）。
    const settingsFile = `${appDataDir}/setting.json`;
    const settings = await readJson<{ providerFamilyDomain?: string }>(settingsFile);
    expect(settings.providerFamilyDomain).toBe("zai");
  });

  it("渲染端 localStorage 中 account:* 的最近模型记录在重启迁移后被剔除", async () => {
    // 先种入旧版本遗留的 localStorage 记录（providerId 指向已下线 account:*）。
    await browser.execute(() => {
      window.localStorage.setItem(
        "zcode-model-selection-recent-v1:/e2e-upgrade-workspace",
        JSON.stringify({
          modelSelection: { providerId: "account:zai-individual-coding-plan", modelId: "GLM-5.3" },
          mode: "build",
        }),
      );
      window.localStorage.setItem(
        `zcode-v4-composer-drafts:v1:${encodeURIComponent("/e2e-upgrade-workspace")}`,
        JSON.stringify({
          version: 1,
          scopes: {
            __draft__: {
              text: "旧草稿正文",
              modelSelection: {
                providerId: "account:bigmodel-individual-coding-plan",
                modelId: "GLM-5.3",
              },
              updatedAt: 1,
            },
          },
        }),
      );
    });

    // 渲染端迁移挂在 Root 启动：冷重启触发一次新的迁移执行（幂等）。
    await reloadElectronSessionSafely(browser);
    await enterMainWorkspaceAfterOnboarding();
    await expectNoWelcomeLoginSurface();

    interface RendererStorageState {
      recentClean: boolean;
      recentKeepsMode: boolean;
      draftClean: boolean;
      draftKeepsText: boolean;
    }
    await browser.waitUntil(
      async () =>
        ((await browser.execute(() => {
          const readRecord = (key: string) => {
            const raw = window.localStorage.getItem(key);
            return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
          };
          const recent = readRecord(
            "zcode-model-selection-recent-v1:/e2e-upgrade-workspace",
          ) as { modelSelection?: { providerId?: string }; mode?: string } | null;
          const draftFile = readRecord(
            `zcode-v4-composer-drafts:v1:${encodeURIComponent("/e2e-upgrade-workspace")}`,
          ) as {
            scopes?: Record<string, { modelSelection?: { providerId?: string }; text?: string }>;
          } | null;
          return {
            recentClean: !recent?.modelSelection?.providerId?.startsWith("account:"),
            recentKeepsMode: recent?.mode === "build",
            draftClean: !Object.values(draftFile?.scopes ?? {}).some((scope) =>
              scope.modelSelection?.providerId?.startsWith("account:"),
            ),
            draftKeepsText: Object.values(draftFile?.scopes ?? {}).some(
              (scope) => scope.text === "旧草稿正文",
            ),
          } satisfies RendererStorageState;
        })) as RendererStorageState),
      {
        timeout: 30_000,
        timeoutMsg: "渲染端 localStorage 的 account:* 模型记录没有被剔除",
      },
    );

    // waitUntil 收口后复核细节字段，让失败信息可诊断。
    const state = (await browser.execute(() => {
      const recent = window.localStorage.getItem(
        "zcode-model-selection-recent-v1:/e2e-upgrade-workspace",
      );
      const draftFile = window.localStorage.getItem(
        `zcode-v4-composer-drafts:v1:${encodeURIComponent("/e2e-upgrade-workspace")}`,
      );
      return { recent, draftFile };
    })) as { recent: string | null; draftFile: string | null };
    const recent = state.recent
      ? (JSON.parse(state.recent) as { modelSelection?: unknown; mode?: string })
      : null;
    const draftFile = state.draftFile
      ? (JSON.parse(state.draftFile) as {
          scopes?: Record<string, { modelSelection?: unknown; text?: string }>;
        })
      : null;
    expect(recent?.modelSelection).toBeUndefined();
    expect(recent?.mode).toBe("build");
    const draftScopes = Object.values(draftFile?.scopes ?? {});
    expect(draftScopes.some((scope) => scope.modelSelection !== undefined)).toBe(false);
    expect(draftScopes.some((scope) => scope.text === "旧草稿正文")).toBe(true);
  });
});
