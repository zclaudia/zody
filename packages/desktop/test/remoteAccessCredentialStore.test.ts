import { describe, expect, it, vi } from "vitest";
import {
  REMOTE_ACCESS_GATEWAY_BACKEND_CREDENTIAL_KEY,
  createRemoteAccessCredentialStore,
  type RemoteAccessCredentialStatus,
  type RemoteAccessCredentialStore,
} from "../src/main/remote-access/remoteAccessCredentialStore.js";

function createHarness(): {
  credentials: Record<string, string | undefined>;
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  store: RemoteAccessCredentialStore;
} {
  const credentials: Record<string, string | undefined> = {};
  const logger = { info: vi.fn(), warn: vi.fn() };
  const store = createRemoteAccessCredentialStore({
    credentialService: {
      load: async (key) => credentials[key] ?? null,
      save: async (key, value) => {
        credentials[key] = value;
      },
      delete: async (key) => {
        credentials[key] = undefined;
      },
    },
    logger,
  });

  return { credentials, logger, store };
}

describe("createRemoteAccessCredentialStore", () => {
  it("把 backend 凭证存在固定 key 下，可读可清", async () => {
    const { credentials, store } = createHarness();

    await store.save("  zgb_pasted-with-space\n");
    expect(credentials[REMOTE_ACCESS_GATEWAY_BACKEND_CREDENTIAL_KEY]).toBe("zgb_pasted-with-space");
    await expect(store.load()).resolves.toBe("zgb_pasted-with-space");

    await store.clear();
    expect(credentials[REMOTE_ACCESS_GATEWAY_BACKEND_CREDENTIAL_KEY]).toBeUndefined();
    await expect(store.load()).resolves.toBeUndefined();
  });

  it("getStatus 只回答「是否已配置」，不返回凭证本身", async () => {
    const { store } = createHarness();

    await expect(store.getStatus()).resolves.toEqual({ configured: false });

    await store.save("zgb_issued-by-gateway");
    const status: RemoteAccessCredentialStatus = await store.getStatus();
    expect(status).toEqual({ configured: true });
    expect(JSON.stringify(status)).not.toContain("zgb_issued-by-gateway");
  });

  it("拒绝空凭证与非 backend 前缀的凭证（zgd_、admin token）", async () => {
    const { credentials, store } = createHarness();

    for (const credential of ["", "   ", "zgd_device-token", "admin-token", "garbage"]) {
      await expect(store.save(credential)).rejects.toThrow(/zgb_ or zga_/);
    }
    expect(credentials[REMOTE_ACCESS_GATEWAY_BACKEND_CREDENTIAL_KEY]).toBeUndefined();

    // zga_ 是 zgb_ 换票后的短期凭证，SDK 同样接受。
    await expect(store.save("zga_short-lived")).resolves.toBeUndefined();
  });

  it("日志里不出现凭证内容", async () => {
    const { logger, store } = createHarness();

    await store.save("zgb_secret-value");
    await store.clear();
    await expect(store.save("zgd_wrong-token")).rejects.toThrow();

    const loggedText = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls]);
    expect(loggedText).not.toContain("zgb_secret-value");
    expect(loggedText).not.toContain("zgd_wrong-token");
    expect(loggedText).toContain("invalid-format");
  });
});
