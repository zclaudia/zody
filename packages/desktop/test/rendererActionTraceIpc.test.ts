import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DISABLED_RENDERER_ACTION_TRACE_CONFIG,
  PlatformChannels,
  type RendererActionTraceConfigV1,
} from "@zcode/shared";

const ipcListeners = new Map<string, (event: unknown, payload: unknown) => void>();
const ipcHandlers = new Map<string, unknown>();

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) => {
      ipcHandlers.set(channel, handler);
    }),
    on: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
      ipcListeners.set(channel, listener);
    }),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn(),
  },
}));

import { registerRendererActionTraceIpc } from "../src/main/rendererActionTraceIpc.js";

const config: RendererActionTraceConfigV1 = {
  enabled: true,
  sampleRatio: 1,
  enabledGroups: ["core", "settings"],
  configVersion: "test",
};

class FakeWebContents extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
}

function createBatch(rendererInstanceId: string) {
  return {
    version: 1,
    rendererInstanceId,
    sequence: 1,
    droppedSinceLastFlush: 0,
    resource: {
      serviceName: "zcode-desktop-renderer",
      serviceVersion: "test",
      deploymentEnvironment: "test",
      rendererInstanceId,
    },
    spans: [],
  };
}

describe("renderer action trace IPC", () => {
  beforeEach(() => {
    ipcListeners.clear();
    ipcHandlers.clear();
  });

  it("rebinds a sender after renderer lifecycle reset while rejecting stale instances", () => {
    const sender = new FakeWebContents(7);
    const enqueue = vi.fn(() => true);
    const warn = vi.fn();
    const dispose = registerRendererActionTraceIpc({
      rollout: {
        getSnapshot: () => config,
        refresh: async () => config,
      },
      broker: { enqueue, flush: vi.fn(), shutdown: vi.fn() },
      logger: { debug: vi.fn(), warn },
    });
    const listener = ipcListeners.get(PlatformChannels.ReportRendererActionTraceBatch);
    if (!listener) throw new Error("IPC listener was not registered");

    listener({ sender }, createBatch("renderer-a"));
    sender.emit("did-start-loading");
    listener({ sender }, createBatch("renderer-a"));
    listener({ sender }, createBatch("renderer-b"));
    sender.emit("did-navigate");
    listener({ sender }, createBatch("renderer-b"));

    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({ rendererInstanceId: "renderer-a" });
    expect(enqueue.mock.calls[1]?.[0]).toMatchObject({ rendererInstanceId: "renderer-b" });
    expect(enqueue.mock.calls[2]?.[0]).toMatchObject({ rendererInstanceId: "renderer-b" });
    expect(warn).toHaveBeenCalledWith(
      "[renderer-action-trace] stale renderer instance for sender",
      expect.objectContaining({ senderId: 7 }),
    );

    dispose();
  });

  it("装配本地恒定禁用 rollout（F2.6a / D1b）时，渲染端查询到的动作追踪配置恒为禁用", async () => {
    // fork（F2.6a）：Main 侧动作追踪不再经 singleFeatureRollout 读远端，装配的是
    // 与 index.ts 相同形状的恒定 DISABLED rollout；refresh 是纯本地取值，无 fetchConfig。
    let refreshCalls = 0;
    const disabledRollout = {
      getSnapshot: (): RendererActionTraceConfigV1 => ({ ...DISABLED_RENDERER_ACTION_TRACE_CONFIG }),
      refresh: async (): Promise<RendererActionTraceConfigV1> => {
        refreshCalls += 1;
        return { ...DISABLED_RENDERER_ACTION_TRACE_CONFIG };
      },
      awaitFirstDecision: async (): Promise<RendererActionTraceConfigV1> => ({
        ...DISABLED_RENDERER_ACTION_TRACE_CONFIG,
      }),
    };
    const dispose = registerRendererActionTraceIpc({
      rollout: disabledRollout,
      broker: { enqueue: vi.fn(), flush: vi.fn(), shutdown: vi.fn() },
      // env 为空：排除 ZCODE_RENDERER_ACTION_TRACE_ENABLED / ZCODE_LOCAL_TTFT_ENABLED 调试覆盖。
      env: {},
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    try {
      const handler = ipcHandlers.get(PlatformChannels.GetRendererActionTraceConfig) as
        | (() => Promise<RendererActionTraceConfigV1>)
        | undefined;
      if (!handler) throw new Error("GetRendererActionTraceConfig handler was not registered");

      await expect(handler()).resolves.toEqual(DISABLED_RENDERER_ACTION_TRACE_CONFIG);
      // 60s 周期 refresh 走的也是同一条纯本地路径，不会触达远端配置。
      expect(refreshCalls).toBe(1);
    } finally {
      dispose();
    }
  });
});
