import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { HttpClientPort, HttpClientRequest, HttpClientResponse } from "@zcode/contracts";
import { createSharedZCodeCredentialStore } from "@zcode/adapters/auth";
import {
  configureCodingPlanApiKey,
  hasConfiguredStandaloneCodingPlan,
  loginZCodeCli,
} from "../src/auth-login.js";

const TEST_ENV = {
  ZCODE_CREDENTIAL_SECRET: "bootstrap-test-secret",
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: fileURLToPath(
    new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
  ),
};

describe("ZCode CLI login", () => {
  it("没有任何 Standalone 账号凭据时不会误报已配置 Coding Plan", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-no-login-"));
    const credentialStore = createSharedZCodeCredentialStore({
      baseDir: dir,
      env: TEST_ENV,
    });
    try {
      await expect(
        hasConfiguredStandaloneCodingPlan({ credentialStore, env: TEST_ENV }),
      ).resolves.toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  // F4.1a 已从 config/provider/zcode-builtin.json 删除全部 account:* 官方账号 provider，
  // CLI 登录存/清账号凭据的端到端行为随 F4.9（CLI 登录与账号运行时）整体删除：
  // 「polls OAuth, stores account credentials, and updates the configured default」
  // 「clears shared ZAI credentials and standalone account access on logout」
  // 「退出不解密来源为 oauth/undefined 的历史旧 Key」四个用例断言的正是已删除行为，
  // builtin 配置不可能再物化 Individual Coding Plan Provider，故按语义删除而非改写。
  // OAuth init/轮询/超时/中止的传输层行为由下方保留用例继续覆盖。

  it("uses the production ZCode endpoint by default for OAuth init", async () => {
    const httpClient = new FakeHttpClient([
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          flow_id: "flow-failed",
          poll_token: "poll-token",
          authorize_url: "https://chat.z.ai/oauth/authorize?state=failed",
          expires_at: 9999999999,
          poll_interval_sec: 2,
        },
      }),
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          status: "failed",
        },
      }),
    ]);

    await expect(
      loginZCodeCli({
        env: TEST_ENV,
        httpClient,
        noBrowser: true,
        now: () => 1_000,
        pollToken: "poll-token",
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "auth_failed",
    });

    expect(httpClient.requests[0]?.url).toBe("https://zcode.z.ai/api/v1/oauth/cli/init");
  });

  it("manual Coding Plan API Key uses the same Account Access and Selection facts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-api-key-login-"));
    const credentialStore = createSharedZCodeCredentialStore({
      baseDir: join(dir, "home"),
      env: TEST_ENV,
    });
    const personalProviderConfigPath = join(dir, "provider_config.json");
    const zcodeBuiltinProviderConfigPath = join(dir, "zcode-builtin.json");
    const configuredProviderId = "configured-bigmodel-individual";
    await writeFile(
      zcodeBuiltinProviderConfigPath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        config: {
          providerConfigRules: {
            templateRules: [],
            providerRules: [
              {
                providerId: configuredProviderId,
                config: {
                  group: "bigmodel-family",
                  builtinModelIds: ["model-from-config"],
                  access: {
                    type: "zhipu-account",
                    accountType: "bigmodel",
                    mode: "individual-coding-plan",
                  },
                },
              },
            ],
          },
          modelConfigRules: {
            modelRules: [],
            modelApiRules: [],
            providerSiteRules: [],
            templateModelRules: [],
            builtinProviderModelRules: [],
          },
        },
      }),
    );

    try {
      const result = await configureCodingPlanApiKey({
        apiKey: "manual-key",
        credentialStore,
        env: {
          ...TEST_ENV,
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: zcodeBuiltinProviderConfigPath,
        },
        personalProviderConfigPath,
        providerId: "bigmodel",
      });

      expect(result).toEqual({
        configPath: personalProviderConfigPath,
        model: `${configuredProviderId}/model-from-config`,
        providerId: "bigmodel",
      });
      await expect(
        hasConfiguredStandaloneCodingPlan({
          credentialStore,
          env: {
            ...TEST_ENV,
            ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: zcodeBuiltinProviderConfigPath,
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("reports failed and expired OAuth flows as retryable login errors", async () => {
    const failedClient = new FakeHttpClient([
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          flow_id: "flow-failed",
          poll_token: "poll-token",
          authorize_url: "https://chat.z.ai/oauth/authorize?state=failed",
          expires_at: 9999999999,
          poll_interval_sec: 2,
        },
      }),
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          status: "failed",
        },
      }),
    ]);

    await expect(
      loginZCodeCli({
        env: TEST_ENV,
        httpClient: failedClient,
        noBrowser: true,
        now: () => 1_000,
        pollToken: "poll-token",
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "auth_failed",
    });

    const expiredClient = new FakeHttpClient([
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          flow_id: "flow-expired",
          poll_token: "poll-token",
          authorize_url: "https://chat.z.ai/oauth/authorize?state=expired",
          expires_at: 1,
          poll_interval_sec: 2,
        },
      }),
    ]);

    await expect(
      loginZCodeCli({
        env: TEST_ENV,
        httpClient: expiredClient,
        noBrowser: true,
        now: () => 2_000,
        pollToken: "poll-token",
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "auth_timeout",
    });
  });

  it("aborts a ZAI OAuth login while waiting for authorization", async () => {
    const abortController = new AbortController();
    let sleepStarted: (() => void) | undefined;
    const sleepPromise = new Promise<void>((resolve) => {
      sleepStarted = resolve;
    });
    const httpClient = new FakeHttpClient([
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          flow_id: "flow-abort",
          poll_token: "poll-token",
          authorize_url: "https://chat.z.ai/oauth/authorize?state=abort",
          expires_at: 9999999999,
          poll_interval_sec: 2,
        },
      }),
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          status: "pending",
        },
      }),
    ]);

    const loginPromise = loginZCodeCli({
      abortSignal: abortController.signal,
      env: TEST_ENV,
      httpClient,
      noBrowser: true,
      now: () => 1_000,
      pollToken: "poll-token",
      sleep: async () => {
        sleepStarted?.();
        await new Promise<void>(() => undefined);
      },
    });

    await sleepPromise;
    abortController.abort(new Error("login cancelled"));

    await expect(loginPromise).rejects.toThrow("login cancelled");
    expect(httpClient.requests).toHaveLength(2);
  });
});

class FakeHttpClient implements HttpClientPort {
  readonly requests: HttpClientRequest[] = [];

  constructor(private readonly responses: HttpClientResponse[]) {}

  async request(request: HttpClientRequest): Promise<HttpClientResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No fake response configured");
    }
    return response;
  }
}

function jsonResponse(body: unknown): HttpClientResponse {
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  return {
    body: encoded,
    bytes: encoded.byteLength,
    durationMs: 1,
    headers: {
      "content-type": "application/json",
    },
    status: 200,
    statusText: "OK",
    url: "https://zcode.example/api/v1",
  };
}
