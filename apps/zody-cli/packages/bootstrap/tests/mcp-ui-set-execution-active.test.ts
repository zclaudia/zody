import { describe, expect, it, vi } from "vitest";
import {
  zodyMcpUiSetExecutionActiveParamsSchema,
  zodyProtocolMethods,
  zodyProtocolSessionMethodContracts,
} from "@zody/shared";
import { mcpUiInstances } from "../src/zody-protocol/mcp-ui/instances.js";
import {
  closeMcpUiInstance,
  openMcpUiInstance,
  setMcpUiExecutionActive,
} from "../src/zody-protocol/mcp-ui/protocol.js";
import type { ZodyProtocolAgentServerContext } from "../src/zody-protocol/server-types.js";

// F18 通道切片（上游 a60ba6a7 pluginUiBackgroundRetention）：沙箱执行忙闲信号
// mcp/uiSetExecutionActive 必须进入 Agent 端实例 owner，并参与 mcp/uiCloseInstance
// 的 onlyIfIdle 原子裁决；契约见 docs/plugin-ui-background-execution.md §11。
const source = { identity: "source", generation: 1 };

let sequence = 0;
function createPage() {
  sequence += 1;
  const params = {
    workspace: {
      workspaceKey: `/execution-${sequence}`,
      workspacePath: `/execution-${sequence}`,
    },
    sessionId: `execution-session-${sequence}`,
    pluginId: `plugin-${sequence}`,
    serverName: `server-${sequence}`,
    scopeId: `scope-${sequence}`,
    resourceUri: `ui://app-${sequence}`,
    ownerWebContentsId: 1,
  };
  const app = {
    getMcpAppConnectionSnapshot: () => source,
    connectMcpServer: vi.fn(),
    waitForMcpAppConnection: vi.fn(async () => source),
    onMcpAppConnectionInvalidated: vi.fn(() => () => {}),
    unsubscribeMcpResourcesForUi: vi.fn(async () => 0),
  };
  const sessions = new Map([[params.sessionId, { app }]]);
  const context = { deps: {}, sessions } as unknown as ZodyProtocolAgentServerContext;
  const scope = (extra: Record<string, unknown> = {}) => ({
    workspace: params.workspace,
    sessionId: params.sessionId,
    pluginId: params.pluginId,
    serverName: params.serverName,
    ...extra,
  });
  return { app, context, params, scope };
}

describe("mcp/uiSetExecutionActive protocol contract", () => {
  it("registers the method and its params/result contract", () => {
    expect(zodyProtocolMethods.mcpUiSetExecutionActive).toBe("mcp/uiSetExecutionActive");
    const contract = zodyProtocolSessionMethodContracts[zodyProtocolMethods.mcpUiSetExecutionActive];
    expect(contract).toBeDefined();
    expect(contract.params).toBe(zodyMcpUiSetExecutionActiveParamsSchema);
  });

  it("accepts an instance scope with a boolean active flag", () => {
    const page = createPage();
    const lease = { runtimeId: "r", generation: 1, appIdentity: "a".repeat(64), token: "t" };
    expect(
      zodyMcpUiSetExecutionActiveParamsSchema.parse({ ...page.scope(), instance: lease, active: true }),
    ).toMatchObject({ active: true });
  });

  it("rejects a missing, non-boolean active flag and unknown keys", () => {
    const page = createPage();
    const lease = { runtimeId: "r", generation: 1, appIdentity: "a".repeat(64), token: "t" };
    const valid = { ...page.scope(), instance: lease };
    expect(() => zodyMcpUiSetExecutionActiveParamsSchema.parse(valid)).toThrow();
    expect(() =>
      zodyMcpUiSetExecutionActiveParamsSchema.parse({ ...valid, active: "yes" }),
    ).toThrow();
    expect(() =>
      zodyMcpUiSetExecutionActiveParamsSchema.parse({ ...valid, active: true, extra: 1 }),
    ).toThrow();
  });
});

describe("mcp/uiSetExecutionActive busy arbitration", () => {
  // 反例核心：执行信号在场时 onlyIfIdle 原子裁决必须拒绝回收，撤销后放行。
  it("rejects onlyIfIdle recycle while execution is active and allows it after release", async () => {
    const page = createPage();
    const lease = await openMcpUiInstance(page.context, page.params);

    await setMcpUiExecutionActive(page.context, { ...page.scope(), instance: lease, active: true });
    await expect(
      closeMcpUiInstance(page.context, { ...page.scope(), instance: lease, onlyIfIdle: true }),
    ).resolves.toEqual({ closed: false });
    expect(mcpUiInstances.find(lease.token)).toBeDefined();

    await setMcpUiExecutionActive(page.context, { ...page.scope(), instance: lease, active: false });
    await expect(
      closeMcpUiInstance(page.context, { ...page.scope(), instance: lease, onlyIfIdle: true }),
    ).resolves.toEqual({ closed: true });
    expect(mcpUiInstances.find(lease.token)).toBeUndefined();
  });

  // 反例：伪造 scope 的上报必须 fail closed，且不得把目标实例置忙阻塞后续回收。
  it("rejects a forged scope without flipping the busy state", async () => {
    const page = createPage();
    const lease = await openMcpUiInstance(page.context, page.params);

    await expect(
      setMcpUiExecutionActive(page.context, {
        ...page.scope({ serverName: "forged-server" }),
        instance: lease,
        active: true,
      }),
    ).rejects.toThrow("no longer authorized");
    await expect(
      closeMcpUiInstance(page.context, { ...page.scope(), instance: lease, onlyIfIdle: true }),
    ).resolves.toEqual({ closed: true });
  });

  // 反例：未知/已关闭实例的上、下置都必须抛错，不静默成功。
  it("rejects unknown and already-closed instance credentials", async () => {
    const page = createPage();
    const lease = await openMcpUiInstance(page.context, page.params);
    const unknown = { runtimeId: "r", generation: 1, appIdentity: "a".repeat(64), token: "missing" };
    await expect(
      setMcpUiExecutionActive(page.context, { ...page.scope(), instance: unknown, active: true }),
    ).rejects.toThrow("no longer authorized");

    mcpUiInstances.close(lease);
    await expect(
      setMcpUiExecutionActive(page.context, { ...page.scope(), instance: lease, active: false }),
    ).rejects.toThrow("no longer authorized");
  });

  // 既有语义回归：工具 pins（未上报沙箱执行）仍然是 busy，onlyIfIdle 同样拒绝。
  it("keeps tool-call pins busy semantics unchanged", async () => {
    const page = createPage();
    const lease = await openMcpUiInstance(page.context, page.params);
    const pin = mcpUiInstances.retain(lease.token, "call-1");
    await expect(
      closeMcpUiInstance(page.context, { ...page.scope(), instance: lease, onlyIfIdle: true }),
    ).resolves.toEqual({ closed: false });
    pin.release();
    await expect(
      closeMcpUiInstance(page.context, { ...page.scope(), instance: lease, onlyIfIdle: true }),
    ).resolves.toEqual({ closed: true });
  });
});
