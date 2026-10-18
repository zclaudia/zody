import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HttpClientPort, HttpClientResponse } from "@zcode/contracts";
import {
  createCliOAuthClient,
  createSharedZCodeCredentialStore,
  SHARED_ZCODE_CREDENTIAL_KEYS as keys,
} from "@zcode/adapters/auth";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import {
  loginBigmodelCodingPlan,
  type LoginZCodeCliOptions,
} from "../../bootstrap/src/auth-login.js";
import type { RunDependencies } from "../src/cli-types.js";
import { runLoginCommand } from "../src/login-command.js";

const authorizeUrl = "https://login.example.test/authorize?state=test-state";
const pollToken = "test-private-poll-token";
const ready = (providerId: "zai" | "bigmodel") => ({
  status: "ready",
  token: "test-backend-jwt",
  user: { user_id: "test-account", name: "Test User" },
  [providerId]:
    providerId === "zai"
      ? { access_token: "test-oauth-token" }
      : { accessToken: "test-business-token", refreshToken: "test-refresh-token" },
});
const TEST_PROJECT_MATERIAL = {
  token: "test-project-token",
  apiKeyId: "test-api-key-id",
  organizationId: "test-org",
  projectId: "test-project",
};
function response(data: unknown, status = 200): HttpClientResponse {
  const body = new TextEncoder().encode(JSON.stringify({ code: 0, data }));
  return {
    url: "https://example.test",
    status,
    statusText: "test",
    headers: {},
    body,
    bytes: body.length,
    durationMs: 0,
  };
}
async function fixture(t: TestContext, providerId: "zai" | "bigmodel" = "bigmodel") {
  const dir = await mkdtemp(join(tmpdir(), "zcode-login-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const personalFile = join(dir, "provider_config.json");
  const personal = new NodePersonalProviderConfigRepository({
    filePath: personalFile,
    pollingIntervalMs: false,
  });
  await personal.update((current) => current);
  personal.dispose();
  const env = {
    ZCODE_DATA_BASE_DIR: dir,
    ZCODE_CREDENTIAL_SECRET: "test-encryption-key",
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: resolve(
      import.meta.dirname,
      "../../../../../config/provider/zcode-builtin.json",
    ),
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalFile,
  };
  const store = createSharedZCodeCredentialStore({ env });
  let now = 1_000_000;
  const sleeps: number[] = [];
  const requests: Parameters<HttpClientPort["request"]>[0][] = [];
  const f = {
    env,
    store,
    sleeps,
    requests,
    advance: (ms: number) => {
      now += ms;
    },
    poll: async (_signal?: AbortSignal): Promise<HttpClientResponse> => response(ready(providerId)),
    options: {} as LoginZCodeCliOptions,
  };
  const httpClient: HttpClientPort = {
    async request(request, options) {
      requests.push(request);
      assert.equal(request.headers?.Authorization, `Bearer ${pollToken}`);
      assert.ok(options?.signal);
      if (request.method === "POST") {
        assert.deepEqual(JSON.parse(new TextDecoder().decode(request.body)), {
          provider: providerId,
        });
        return response({
          flow_id: "flow/with space",
          authorize_url: authorizeUrl,
          expires_at: now / 1000 + 120,
          poll_interval_sec: 1,
        });
      }
      assert.match(request.url, /\/oauth\/cli\/poll\/flow%2Fwith%20space$/);
      return f.poll(options?.signal);
    },
  };
  f.options = {
    env,
    credentialStore: store,
    providerId,
    httpClient,
    noBrowser: true,
    pollToken,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    // OAuth 登录只解析项目访问材料，不再落盘派生 API Key（staging 9af2a442d3 改为请求期换取 Token）。
    apiKeyResolver: {
      async resolveMaterial(input, options) {
        assert.equal(input.family, providerId);
        assert.equal(
          input.accessToken,
          providerId === "zai" ? "test-oauth-token" : "test-business-token",
        );
        assert.ok(options?.signal);
        return TEST_PROJECT_MATERIAL;
      },
    } as unknown as LoginZCodeCliOptions["apiKeyResolver"],
  };
  return f;
}

// fork：以下「browser polling persists credentials and refreshes the running Registry」
// （zai/bigmodel 两个用例）已随 F4.1a 移除——specs/fork-official-deps-removal-tasks.md F4.1a
// 删除了 zcode-builtin(.test).json 中全部 account:* Individual Coding Plan Provider，
// `resolveStandaloneCodingPlanProvider` 读真实 builtin 必然抛「必须为 zai/bigmodel 声明唯一
// Individual Coding Plan Provider」；「登录成功后持久化账号凭据与 Registry 刷新」属 F4.9
// 「CLI 登录与账号运行时」的整体删除范围，用例按已删除行为语义移除，不再改为否定断言。

test("OAuth init does not require an echoed poll secret and accepts both BigModel token spellings", async () => {
  for (const token of [
    { access_token: "token", refresh_token: "refresh" },
    { accessToken: "token", refreshToken: "refresh" },
  ]) {
    const client = createCliOAuthClient({
      providerId: "bigmodel",
      httpClient: {
        async request(request) {
          return request.method === "POST"
            ? response({
                flow_id: "flow",
                authorize_url: authorizeUrl,
                expires_at: 12345,
                poll_interval_sec: 1,
              })
            : response({ ...ready("bigmodel"), bigmodel: token });
        },
      },
    });
    assert.equal(Object.hasOwn(await client.init({ pollToken }), "poll_token"), false);
    const result = await client.poll({ flowId: "flow", pollToken });
    assert.equal(result.status, "ready");
    if (result.status === "ready") assert.equal(result.refreshToken, "refresh");
  }
});

for (const failure of ["failed", "unauthorized", "malformed"] as const) {
  test(`terminal polling failure ${failure} does not write credentials or retry`, async (t) => {
    const f = await fixture(t);
    f.poll = async () =>
      failure === "unauthorized"
        ? response(null, 401)
        : response(
            failure === "failed" ? { status: "failed" } : { ...ready("bigmodel"), bigmodel: {} },
          );
    await assert.rejects(loginBigmodelCodingPlan(f.options));
    assert.equal(await f.store.load(keys.activeProvider), null);
    assert.equal(f.sleeps.length, 0);
  });
}

test("cancelling in-flight polling ignores a late ready response", { timeout: 2000 }, async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  let finish!: (data: HttpClientResponse) => void;
  let started!: () => void;
  const polling = new Promise<void>((resolve) => {
    started = resolve;
  });
  let requestSignal: AbortSignal | undefined;
  f.poll = (signal) => {
    requestSignal = signal;
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const login = loginBigmodelCodingPlan({ ...f.options, abortSignal: controller.signal });
  await polling;
  controller.abort(new Error("test login cancelled"));
  await assert.rejects(login, /test login cancelled/);
  assert.equal(requestSignal?.aborted, true);
  finish(response(ready("bigmodel")));
  await Promise.resolve();
  assert.equal(await f.store.load(keys.activeProvider), null);
});

test("login timeout interrupts an unresponsive transport", { timeout: 2000 }, async (t) => {
  const f = await fixture(t);
  f.poll = () => new Promise(() => {});
  await assert.rejects(loginBigmodelCodingPlan({ ...f.options, timeoutMs: 30 }), {
    code: "auth_timeout",
  });
  assert.equal(await f.store.load(keys.activeProvider), null);
});

test("a response received after flow expiry is not persisted", async (t) => {
  const f = await fixture(t);
  f.poll = async () => {
    f.advance(121_000);
    return response(ready("bigmodel"));
  };
  await assert.rejects(loginBigmodelCodingPlan(f.options), { code: "auth_timeout" });
  assert.equal(await f.store.load(keys.activeProvider), null);
});

test("cancellation during API key resolution does not save the login", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(
    loginBigmodelCodingPlan({
      ...f.options,
      abortSignal: controller.signal,
      apiKeyResolver: {
        async resolveMaterial() {
          controller.abort(new Error("cancel before save"));
          return TEST_PROJECT_MATERIAL;
        },
      } as unknown as LoginZCodeCliOptions["apiKeyResolver"],
    }),
    /cancel before save/,
  );
  assert.equal(await f.store.load(keys.activeProvider), null);
});

// fork：「browser failure keeps authorization URL available and polling completes」与
// 「TUI renders the login URL in the current session and refreshes models after authorization」
// 两个用例已随 F4.1a 移除：两者都断言登录成功后的完整账号 wire（persistStandaloneCodingPlanConnection
// 经 resolveStandaloneCodingPlanProvider 读 builtin 的 account:* provider 写连接与默认模型），
// F4.1a 删除 builtin 账号 provider 后该链路必然抛 config_update_failed（登录链整体删除见 F4.9）；
// 后者还因 opentui 渲染 + 永不 settle 的登录 promise 在失败后挂起整个 node --test 进程。

test("standalone login accepts provider selection and keeps authorization URL out of JSON stdout", async () => {
  let stdout = "";
  let stderr = "";
  let selected = "";
  const deps = {
    env: {},
    cwd: () => process.cwd(),
    loadDotenv: () => ({ keys: [], loaded: false, path: "" }),
    loginZCodeCli: async (options: LoginZCodeCliOptions) => {
      selected = options.providerId!;
      assert.equal(options.noBrowser, true);
      await options.onAuthorizeUrl?.({
        authorize_url: authorizeUrl,
        expires_at: 12345,
        flow_id: "flow",
        poll_interval_sec: 1,
      });
      return {
        providerId: "bigmodel",
        user: { user_id: "test-account" },
        model: "provider/model",
        configPath: "test-config",
        credentialsPath: "test-credentials",
      };
    },
  } as unknown as RunDependencies;
  const context = {
    stdout: {
      write: (text: string) => {
        stdout += text;
      },
    },
    stderr: {
      write: (text: string) => {
        stderr += text;
      },
    },
  } as unknown as Parameters<typeof runLoginCommand>[0];
  const options = { json: true } as Parameters<typeof runLoginCommand>[1];
  assert.equal(await runLoginCommand(context, options, deps, true, ["bigmodel"]), 0);
  assert.equal(selected, "bigmodel");
  assert.equal(JSON.parse(stdout).provider, "bigmodel");
  assert.match(stderr, /login\.example\.test/);
  assert.doesNotMatch(stdout, /authorize/);
});
