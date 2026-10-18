import { describe, expect, it } from "vitest";
import { createE2EStartupCredentialSeed } from "./e2e/helpers/e2e-startup-credentials.js";

const restoredOAuthCredentials = {
  "oauth:active_provider": "zai",
  "oauth:zai:access_token": "fake-access-token",
  "oauth:zai:user_info": "{}",
  zcodejwttoken: "fake-zcode-jwt",
};

describe("desktop e2e startup credentials", () => {
  it("纯 Provider 冷恢复 spec 不播种会访问账号控制面的假登录态", () => {
    expect(
      createE2EStartupCredentialSeed({
        specs: [
          "/repo/packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-unbound-resume.test.ts",
        ],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }),
    ).toEqual({});
  });

  it.each([
    "conversation-session-v4-composer-toolbar.test.ts",
    "conversation-session-draft-model-switch-first-send.test.ts",
    "conversation-session-composer-draft-switching.test.ts",
    "conversation-session-ssh-provisioning-failure.test.ts",
  ])("Composer Draft spec %s 不播种无关账号身份", (spec) => {
    expect(
      createE2EStartupCredentialSeed({
        specs: [`/repo/packages/desktop/test/e2e/conversation-session/${spec}`],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }),
    ).toEqual({});
  });

  it.each([
    "conversation-session-automation-cron-create.test.ts",
    "conversation-session-fork-merged-assistant.test.ts",
    "conversation-session-goal-run-cases.test.ts",
    "conversation-session-running-guide-steer.test.ts",
    "conversation-session-tool-cross-product.test.ts",
    "conversation-session-v4-fork-edit-branch.test.ts",
  ])("fork/goal/tool spec %s 不播种无关账号身份", (spec) => {
    expect(
      createE2EStartupCredentialSeed({
        specs: [`/repo/packages/desktop/test/e2e/conversation-session/${spec}`],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }),
    ).toEqual({});
  });

  // F4.1c 把默认基座翻转为「非官方种子 spec 一律空凭据」；普通 spec 不再保留
  // OAuth 展示态（历史断言与 helpers/e2e-startup-credentials.ts 的注释矛盾）。
  it("普通 spec 不再播种 OAuth 展示态，也不注入会触发失效广播的 zcode JWT", () => {
    expect(
      createE2EStartupCredentialSeed({
        specs: [
          "/repo/packages/desktop/test/e2e/conversation-session/conversation-session-v4-sendnow.test.ts",
        ],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }),
    ).toEqual({});
  });

  // fork（F4.1a）：「旧版本升级」场景保留官方账号存量种子，供 Host 启动迁移清理。
  it("F4.1a 升级场景 spec 保留 OAuth 展示态但不注入 zcode JWT", () => {
    expect(
      createE2EStartupCredentialSeed({
        specs: [
          "/repo/packages/desktop/test/e2e/official-account-removal-upgrade.test.ts",
        ],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }),
    ).toEqual({
      auth_token: "fake-auth-token",
      "oauth:active_provider": "zai",
      "oauth:zai:access_token": "fake-access-token",
      "oauth:zai:user_info": "{}",
    });
  });

  // fork（F4.4）：Start Plan 手动领取 spec（marketing-touch-entitlement）已删除，
  // 其 JWT 种子白名单条目与断言一并移除。
});
