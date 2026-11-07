import { describe, expect, it, vi } from "vitest";
import type { PluginSandboxRegisterInput } from "@zody/shared/mcp-apps";
import { createPluginUiBridgeService } from "../src/plugin-ui-bridge/pluginUiBridgeService.js";
const instance = { runtimeId: "agent", generation: 1, token: "token", appIdentity: "a".repeat(64) };
const params = {
  workspacePath: "/a",
  sessionId: "s",
  pluginId: "p",
  serverName: "m",
  scopeId: "surface:x",
  resourceUri: "ui://x",
  ownerWebContentsId: 1,
};
describe("MCP App preparation", () => {
  it("coalesces identical initialization but isolates server, workspace and resource", async () => {
    const open = vi.fn(async (p: typeof params & { workspaceIdentity?: string }) => ({
      ...instance,
      token: JSON.stringify([p.serverName, p.resourceUri, p.workspaceIdentity ?? p.workspacePath]),
    }));
    const read = vi.fn(async (input: { uri: string; instance: typeof instance }) => ({
      contents: [{ uri: input.uri, mimeType: "text/html", text: "<p>fixture</p>" }],
    }));
    const register = vi.fn(async (input: PluginSandboxRegisterInput) => ({
      instance: input.instance,
      sandboxId: input.instance.token,
      initId: 1,
      shellUrl: "url",
      partition: "partition",
    }));
    const bridge = createPluginUiBridgeService({
      openInstance: open,
      readMcpResource: read,
      registerSandbox: register,
    });
    const a = bridge.prepareSandbox(params),
      b = bridge.prepareSandbox({ ...params });
    const first = await Promise.all([a, b]);
    expect(first[0]).toEqual(first[1]);
    expect(open).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(1);
    const others = await Promise.all([
      bridge.prepareSandbox({ ...params, serverName: "other" }),
      bridge.prepareSandbox({ ...params, resourceUri: "ui://other" }),
      bridge.prepareSandbox({ ...params, workspaceIdentity: "other" }),
    ]);
    expect(open).toHaveBeenCalledTimes(5);
    expect(read).toHaveBeenCalledTimes(4);
    expect(register).toHaveBeenCalledTimes(4);
    expect(new Set([first[0], ...others].map((handle) => handle.sandboxId)).size).toBe(4);
    expect(register.mock.calls.map(([input]) => input.instance.token)).toEqual(
      read.mock.calls.map(([input]) => input.instance.token),
    );
  });
  it("passes resource-level backgroundRetention through the sandbox registration", async () => {
    // F18⑤ 解锁①反例（docs/plugin-ui-background-execution.md §12.4 缺口）：
    // 资源 `_meta.ui.backgroundRetention` 归一化后必须随 registerSandbox payload 透传，
    // 否则真实运行时 handle.resourceMeta.backgroundRetention 恒为 undefined，
    // 已声明页会被当成默认页走隐藏即停回收（上游 a60ba6a7 pluginUiBridgeService.ts:182 同款透传）。
    const register = vi.fn(async (input: PluginSandboxRegisterInput) => ({
      instance: input.instance,
      sandboxId: input.instance.token,
      initId: 1,
      shellUrl: "url",
      partition: "partition",
    }));
    const bridge = createPluginUiBridgeService({
      openInstance: async () => instance,
      readMcpResource: async () => ({
        contents: [
          {
            uri: params.resourceUri,
            mimeType: "text/html",
            text: "<p>fixture</p>",
            // 资源级 _meta（ui 命名空间下的布尔声明，与 showInline 同形）。
            _meta: { ui: { backgroundRetention: true } },
          },
        ],
      }),
      registerSandbox: register,
    });
    await bridge.prepareSandbox(params);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ backgroundRetention: true }));
    // 反例另一侧：未声明时不得伪造缺省值（缺省即不保留），payload 中不应出现该键。
    const registerWithoutMeta = vi.fn(async (input: PluginSandboxRegisterInput) => ({
      instance: input.instance,
      sandboxId: input.instance.token,
      initId: 1,
      shellUrl: "url",
      partition: "partition",
    }));
    const bridgeWithoutMeta = createPluginUiBridgeService({
      openInstance: async () => instance,
      readMcpResource: async () => ({
        contents: [{ uri: params.resourceUri, mimeType: "text/html", text: "<p>fixture</p>" }],
      }),
      registerSandbox: registerWithoutMeta,
    });
    await bridgeWithoutMeta.prepareSandbox(params);
    const payload = registerWithoutMeta.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("backgroundRetention");
  });
  it("revokes the credential when resource validation fails", async () => {
    const close = vi.fn(async () => {});
    const bridge = createPluginUiBridgeService({
      openInstance: async () => instance,
      closeInstance: close,
      readMcpResource: async () => ({ contents: [] }),
      registerSandbox: vi.fn(),
    });
    await expect(bridge.prepareSandbox(params)).rejects.toThrow("no contents");
    expect(close).toHaveBeenCalledWith({ ...params, instance });
  });
  it("revalidates the instance after the resource read and before registering the sandbox", async () => {
    const events: string[] = [];
    const readResult = Promise.withResolvers<{
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    }>();
    const close = vi.fn(async () => {
      events.push("close");
    });
    const read = vi.fn(async () => {
      events.push("read");
      return readResult.promise;
    });
    const validate = vi.fn(async () => {
      events.push("validate");
      throw new Error("MCP App instance is no longer authorized");
    });
    const register = vi.fn(async (input: PluginSandboxRegisterInput) => {
      events.push("register");
      return {
        instance: input.instance,
        sandboxId: input.instance.token,
        initId: 1,
        shellUrl: "url",
        partition: "partition",
      };
    });
    const bridge = createPluginUiBridgeService({
      openInstance: async () => instance,
      validateInstance: validate,
      closeInstance: close,
      readMcpResource: read,
      registerSandbox: register,
    });

    const preparing = bridge.prepareSandbox(params);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    // 读资源期间连接换代/释放：放行后必须重验，旧 lease 不得登记沙箱。
    readResult.resolve({
      contents: [{ uri: params.resourceUri, mimeType: "text/html", text: "<p>fixture</p>" }],
    });

    await expect(preparing).rejects.toThrow("no longer authorized");
    expect(validate).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["read", "validate", "close"]);
    expect(register).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ instance }));
  });
});
