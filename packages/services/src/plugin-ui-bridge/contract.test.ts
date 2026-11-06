import { ServiceChannels, hostPluginSandboxRegisterResultMessageSchema } from "@zody/shared";
import type { PluginSandboxHandle, PluginSandboxRegisterInput } from "@zody/shared/mcp-apps";
import { describe, expect, it, vi } from "vitest";
import { examplePrepareAndMount, exampleReadBlob } from "./contract.example.js";
import { IPluginUiBridgeService } from "./contract.js";
import { PluginUiBridgeError, createPluginUiBridgeService } from "./pluginUiBridgeService.js";

describe("plugin-ui-bridge contract", () => {
  it("描述符绑定 plugin-ui-bridge 频道", () => {
    expect(IPluginUiBridgeService.channelName).toBe(ServiceChannels.PluginUiBridge);
    expect(ServiceChannels.PluginUiBridge).toBe("plugin-ui-bridge");
  });

  it("句柄能带的全部资源级字段都过 main → host 的 strict 回包 schema", () => {
    // 回包 schema 是 strict 的：PluginSandboxHandle.resourceMeta 新增字段没同步到 validation.ts，
    // 整条回包会被 host 拒收，桥永远等不到句柄，卡片卡在 preparing（2026-09-20 permissions 复现）。
    const handle: PluginSandboxHandle = {
      instance: {
        runtimeId: "test-agent",
        generation: 1,
        token: "test-token",
        appIdentity: "a".repeat(64),
      },
      sandboxId: "sb-01",
      initId: 1,
      shellUrl: "zcode-sandbox://shell-sb-01/",
      partition: "persist:plugin-sandbox-v1-0123456789abcdef",
      resourceMeta: {
        prefersBorder: true,
        heightHint: 320,
        minFrameHeight: 120,
        showInline: false,
        permissions: ["clipboardWrite"],
      },
    };
    expect(
      hostPluginSandboxRegisterResultMessageSchema.safeParse({
        type: "plugin-sandbox-register-result",
        requestId: "req-1",
        ok: true,
        ...handle,
      }).success,
    ).toBe(true);
  });

  it("示例只依赖契约方法", async () => {
    const bridge: IPluginUiBridgeService = {
      recycleInstance: async () => true,
      validateInstance: async () => undefined,
      closeInstance: async () => undefined,
      prepareSandbox: async (params) => ({
        instance: {
          runtimeId: "test-agent",
          generation: 1,
          token: "test-token",
          appIdentity: "a".repeat(64),
        },
        sandboxId: `sb-${params.scopeId}`,
        initId: 1,
        shellUrl: `zcode-sandbox://shell-sb-${params.scopeId}/`,
        partition: `plugin-sandbox:sb-${params.scopeId}`,
      }),
      callTool: async () => ({ content: [] }),
      cancelToolCall: async () => ({ cancelled: false }),
      readResource: async (params) => ({
        contents: [{ uri: params.uri, mimeType: "model/gltf-binary", blob: "AAAA" }],
      }),
      // 资源订阅接口扩展后，契约示例的替身也必须完整实现，避免类型检查被旧样例阻断。
      listResources: async () => ({ resources: [] }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
      subscribeResource: async () => undefined,
      unsubscribeResource: async () => undefined,
      listSurfaces: async () => [],
    };
    await expect(examplePrepareAndMount(bridge)).resolves.toEqual({
      src: "zcode-sandbox://shell-sb-tool:call_1/",
      partition: "plugin-sandbox:sb-tool:call_1",
      initId: 1,
    });
    await expect(exampleReadBlob(bridge)).resolves.toBe("AAAA");
  });
});

// R52：不能只测 contract 函数——下面全部经真实入站边界 `prepareSandbox` 验证
// （R50 规则 + 可见错误 + 不放宽），与 `resources/read` / `resources/list` 两条来源路径。
const instance = {
  runtimeId: "agent",
  generation: 1,
  token: "token",
  appIdentity: "a".repeat(64),
};
const prepareParams = {
  workspacePath: "/w",
  sessionId: "s",
  pluginId: "p",
  serverName: "m",
  scopeId: "surface:panel",
  resourceUri: "ui://app",
  ownerWebContentsId: 1,
};
type ResourceContent = {
  uri: string;
  mimeType?: string;
  text?: string;
  _meta?: Record<string, unknown>;
};
type ListedResource = { uri: string; _meta?: Record<string, unknown> };

function boundaryBridge(
  contents: ResourceContent[],
  list?: (cursor?: string) => Promise<{ resources: ListedResource[]; nextCursor?: string }>,
) {
  const registerSandbox = vi.fn(
    async (input: PluginSandboxRegisterInput): Promise<PluginSandboxHandle> => ({
      instance: input.instance,
      sandboxId: "sb-1",
      initId: 1,
      shellUrl: "zcode-sandbox://shell-sb-1/",
      partition: "persist:plugin-sandbox-v1-0123456789abcdef",
    }),
  );
  const closeInstance = vi.fn(async () => {});
  const bridge = createPluginUiBridgeService({
    openInstance: async () => instance,
    closeInstance,
    readMcpResource: async () => ({ contents }),
    registerSandbox,
    ...(list
      ? {
          listMcpResourcesForUi: async (params) => {
            const page = await list(params.cursor);
            return {
              resources: page.resources,
              ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
            };
          },
        }
      : {}),
  });
  return { bridge, registerSandbox, closeInstance };
}

const htmlWith = (meta: Record<string, unknown> | undefined): ResourceContent[] => [
  {
    uri: prepareParams.resourceUri,
    mimeType: "text/html;profile=mcp-app",
    text: "<p>x</p>",
    ...(meta ? { _meta: meta } : {}),
  },
];

describe("plugin-ui-bridge 资源 _meta 双键入站（R52）", () => {
  it.each([
    ["legacy zcode/csp", { "zcode/csp": { unsafeEval: true } }],
    ["canonical zody/csp", { "zody/csp": { unsafeEval: true } }],
    ["双键等值", { "zody/csp": { unsafeEval: true }, "zcode/csp": { unsafeEval: true } }],
  ])("%s 归一化后接受，放宽只来自该声明", async (_name, meta) => {
    const { bridge, registerSandbox } = boundaryBridge(htmlWith(meta));
    await bridge.prepareSandbox(prepareParams);
    expect(registerSandbox).toHaveBeenCalledTimes(1);
    expect(registerSandbox.mock.calls[0]![0].cspRelaxations).toEqual({ unsafeEval: true });
  });

  it("双键冲突呈现可见错误并拒绝整个声明，不登记沙箱（零放宽）", async () => {
    const { bridge, registerSandbox, closeInstance } = boundaryBridge(
      htmlWith({ "zody/csp": { unsafeEval: true }, "zcode/csp": { wasmUnsafeEval: true } }),
    );
    const error = await bridge.prepareSandbox(prepareParams).catch((reason) => reason);
    expect(error).toBeInstanceOf(PluginUiBridgeError);
    expect((error as PluginUiBridgeError).code).toBe("resource_meta_conflict");
    expect((error as PluginUiBridgeError).message).toContain("zody/csp");
    expect((error as PluginUiBridgeError).message).toContain("zcode/csp");
    // 不放宽：冲突声明不产生任何登记（连沙箱都不登记，更不会带 cspRelaxations）。
    expect(registerSandbox).not.toHaveBeenCalled();
    // 失败路径仍撤销已签发的实例 lease，不留半登记状态。
    expect(closeInstance).toHaveBeenCalledTimes(1);
  });

  it("双键任一侧非法按冲突处理，不放行更宽的一侧", async () => {
    const { bridge, registerSandbox } = boundaryBridge(
      htmlWith({ "zody/csp": { unsafeEval: true }, "zcode/csp": "unsafe" }),
    );
    await expect(bridge.prepareSandbox(prepareParams)).rejects.toMatchObject({
      code: "resource_meta_conflict",
    });
    expect(registerSandbox).not.toHaveBeenCalled();
  });

  it("非法单键视作未声明：不报错、不放宽", async () => {
    const { bridge, registerSandbox } = boundaryBridge(
      htmlWith({ "zody/csp": { unsafeEval: "yes" } }),
    );
    await bridge.prepareSandbox(prepareParams);
    expect(registerSandbox).toHaveBeenCalledTimes(1);
    expect(registerSandbox.mock.calls[0]![0].cspRelaxations).toBeUndefined();
    // 权限拒绝：未声明的浏览器权限不授予。
    expect(registerSandbox.mock.calls[0]![0].permissions).toBeUndefined();
  });

  it("resources/list 兜底同样走双键规则：冲突可见且不登记", async () => {
    const { bridge, registerSandbox } = boundaryBridge(htmlWith(undefined), async () => ({
      resources: [
        {
          uri: prepareParams.resourceUri,
          _meta: { "zody/csp": { unsafeEval: true }, "zcode/csp": {} },
        },
      ],
    }));
    await expect(bridge.prepareSandbox(prepareParams)).rejects.toMatchObject({
      code: "resource_meta_conflict",
    });
    expect(registerSandbox).not.toHaveBeenCalled();
  });

  it("resources/list 兜底等值双键接受，权限只按声明授予", async () => {
    const { bridge, registerSandbox } = boundaryBridge(htmlWith(undefined), async () => ({
      resources: [
        {
          uri: prepareParams.resourceUri,
          _meta: {
            "zody/csp": { wasmUnsafeEval: true },
            "zcode/csp": { wasmUnsafeEval: true },
            ui: { permissions: { clipboardWrite: {} } },
          },
        },
      ],
    }));
    await bridge.prepareSandbox(prepareParams);
    expect(registerSandbox.mock.calls[0]![0]).toMatchObject({
      cspRelaxations: { wasmUnsafeEval: true },
      permissions: ["clipboardWrite"],
    });
  });
});
