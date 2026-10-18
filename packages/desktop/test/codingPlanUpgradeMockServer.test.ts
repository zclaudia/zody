import { afterEach, describe, expect, it, vi } from "vitest";
// fork（F4.4）：营销触达 / Rewards fixture 用例（含 createHash 资产校验）已随营销链路删除。

import {
  resetCodingPlanUpgradeMockServer,
  shouldPrepareCodingPlanUpgradeMockForBuild,
  startCodingPlanUpgradeMockServer,
  type CodingPlanUpgradeMockServer,
} from "./e2e/helpers/coding-plan-upgrade-mock-server.js";

describe("Coding Plan upgrade E2E mock server", () => {
  let server: CodingPlanUpgradeMockServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it("controls real upgrade HTML readiness and network failure", async () => {
    server = await startCodingPlanUpgradeMockServer("webview-refresh-provider");
    const base = server.baseUrl;
    const mode = (mode: string) =>
      fetch(`${base}/__e2e/coding-plan/webview-mode`, {
        method: "POST",
        body: JSON.stringify({ mode }),
      });
    await mode("hold");
    const response = fetch(`${base}/coding-plan`);
    await vi.waitFor(async () =>
      expect(await fetchJson(`${base}/__e2e/coding-plan/webview-state`)).toEqual({ pending: 1 }),
    );
    await mode("ready");
    expect(await (await response).text()).toContain("coding-plan-webview-fixture");
    await mode("fail");
    await expect(fetch(`${base}/coding-plan`)).rejects.toThrow();
    await mode("ready");
  });

  it("webview inventory starts with a resolvable existing personal connection before purchase", async () => {
    server = await startCodingPlanUpgradeMockServer("webview-refresh-provider");
    const customer = await fetchJson<{ data: { organizations: unknown[] } }>(
      `${server.baseUrl}/api/biz/customer/getCustomerInfo`,
    );
    expect(customer.data.organizations).toEqual([
      { organizationId: "org-e2e", projects: [{ projectId: "proj-e2e", projectType: 0 }] },
    ]);
  });

  it("prepares the build-time origin for the default full-suite glob", () => {
    expect(shouldPrepareCodingPlanUpgradeMockForBuild(["./test/e2e/**/*.test.ts"])).toBe(true);
    expect(
      shouldPrepareCodingPlanUpgradeMockForBuild(["./test/e2e/conversation-session/*.test.ts"]),
    ).toBe(false);
  });

  it("resets scenario, purchase state, and request ledger between workers", async () => {
    server = await startCodingPlanUpgradeMockServer("personal-sold-out");

    expect(await fetchText(`${server.baseUrl}/coding-plan`)).toContain("Sold out");
    await resetCodingPlanUpgradeMockServer(server.baseUrl, "personal-system-busy");
    expect(server.scenario).toBe("personal-system-busy");

    const resetRequests = await fetchJson<{ requests: unknown[] }>(
      `${server.baseUrl}/__e2e/coding-plan/requests`,
    );
    expect(resetRequests.requests).toEqual([]);
    expect(await fetchText(`${server.baseUrl}/coding-plan`)).toContain("System busy");

    const preview = await fetchJson<{ code: number }>(
      `${server.baseUrl}/api/biz/pay/batch-preview`,
      { method: "POST" },
    );
    expect(preview.code).toBe(503);
  });

  it("returns the copied Z.ai secret after a webview purchase completes", async () => {
    server = await startCodingPlanUpgradeMockServer("webview-refresh-provider");

    await fetchJson(`${server.baseUrl}/__e2e/coding-plan/purchase-complete`, {
      method: "POST",
    });
    const copiedKey = await fetchJson<{ data: { secretKey?: string } }>(
      `${server.baseUrl}/api/biz/v1/organization/org-e2e/projects/proj-e2e/api_keys/copy/bigmodel-webview-refreshed-key`,
      { headers: { authorization: "Bearer zai-webview-oauth-token" } },
    );

    // Z.ai provider 拒绝裸 apiKey；fixture 必须覆盖 copy 接口的完整 key 合同。
    expect(copiedKey.data.secretKey).toBe("zai-webview-refreshed-secret");
  });

  it("does not append the Z.ai secret to a BigModel copied API key", async () => {
    server = await startCodingPlanUpgradeMockServer("webview-refresh-provider");

    await fetchJson(`${server.baseUrl}/__e2e/coding-plan/purchase-complete`, {
      method: "POST",
    });
    const copiedKey = await fetchJson<{ data: { secretKey?: string } }>(
      `${server.baseUrl}/api/biz/v1/organization/org-e2e/projects/proj-e2e/api_keys/copy/bigmodel-webview-refreshed-key`,
      { headers: { authorization: "e2e-bigmodel-oauth-token" } },
    );

    expect(copiedKey.data.secretKey).toBe("");
  });
});

async function fetchText(url: string) {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return await response.text();
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
}
