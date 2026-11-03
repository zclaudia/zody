import { describe, it, expect, vi } from "vitest";
import {
  ChannelServer,
  ChannelClient,
  IServerChannel,
  getDelayedChannel,
} from "../src/channels.js";
import { createQueuePair, SocketProtocol, type ISocket } from "../src/protocol.js";
import type { IMessagePassingProtocol } from "../src/protocol.js";
import { Emitter, Event, DisposableStore } from "../src/foundation.js";
import { VSBuffer } from "../src/buffer.js";
import { BufferReader, BufferWriter, serialize, deserialize } from "../src/serialization.js";

function createPair(ctx = "test-ctx") {
  const [serverProtocol, clientProtocol] = createQueuePair();
  const server = new ChannelServer(serverProtocol, ctx);
  const client = new ChannelClient(clientProtocol);
  return {
    server,
    client,
    dispose: () => {
      server.dispose();
      client.dispose();
    },
  };
}

function createFragmentedSocketPair(fragmentSize = 7): [ISocket, ISocket] {
  const emitterA = new Emitter<VSBuffer>();
  const emitterB = new Emitter<VSBuffer>();
  const closeA = new Emitter<void>();
  const closeB = new Emitter<void>();
  const endA = new Emitter<void>();
  const endB = new Emitter<void>();

  function splitBuffer(buffer: VSBuffer): VSBuffer[] {
    const chunks: VSBuffer[] = [];
    for (let offset = 0; offset < buffer.byteLength; offset += fragmentSize) {
      chunks.push(buffer.slice(offset, Math.min(offset + fragmentSize, buffer.byteLength)));
    }
    return chunks;
  }

  const socketA: ISocket = {
    onData: emitterA.event,
    onClose: closeA.event,
    onEnd: endA.event,
    write(buffer) {
      for (const chunk of splitBuffer(buffer)) {
        setTimeout(() => emitterB.fire(chunk), 0);
      }
    },
    end() {
      closeA.fire();
      endA.fire();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      closeA.fire();
      endA.fire();
    },
  };

  const socketB: ISocket = {
    onData: emitterB.event,
    onClose: closeB.event,
    onEnd: endB.event,
    write(buffer) {
      for (const chunk of splitBuffer(buffer)) {
        setTimeout(() => emitterA.fire(chunk), 0);
      }
    },
    end() {
      closeB.fire();
      endB.fire();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      closeB.fire();
      endB.fire();
    },
  };

  return [socketA, socketB];
}

describe("ChannelServer + ChannelClient", () => {
  it("should call a method on a registered channel", async () => {
    const { server, client, dispose } = createPair();

    const channel: IServerChannel = {
      call(_ctx, command, arg) {
        if (command === "add") return Promise.resolve(arg[0] + arg[1]);
        return Promise.reject(new Error("Unknown command"));
      },
      listen() {
        return Event.None;
      },
    };

    server.registerChannel("math", channel);
    const ch = client.getChannel("math");
    const result = await ch.call("add", [3, 4]);
    expect(result).toBe(7);
    dispose();
  });

  it("should propagate errors", async () => {
    const { server, client, dispose } = createPair();

    const channel: IServerChannel = {
      call() {
        return Promise.reject(new Error("boom"));
      },
      listen() {
        return Event.None;
      },
    };

    server.registerChannel("fail", channel);
    const ch = client.getChannel("fail");
    await expect(ch.call("anything")).rejects.toThrow("boom");
    dispose();
  });

  it("should reject in-flight calls when the client is disposed", async () => {
    const { server, client } = createPair();
    const call = vi.fn(() => new Promise(() => {}));
    server.registerChannel("hang", {
      call,
      listen() {
        return Event.None;
      },
    });

    const resultPromise = client.getChannel("hang").call("wait");
    await vi.waitFor(() => {
      expect(call).toHaveBeenCalledTimes(1);
    });

    const reason = Object.assign(new Error("remote connection closed"), {
      code: "ZCODE_REMOTE_WORKSPACE_DISCONNECTED",
    });
    client.dispose(reason);

    await expect(resultPromise).rejects.toBe(reason);
    server.dispose();
  });

  it("should reject requests queued before Initialize when the client is disposed", async () => {
    const [serverProtocol, clientProtocol] = createQueuePair();
    const server = new ChannelServer(serverProtocol, "test-ctx", 1000, true);
    const client = new ChannelClient(clientProtocol);
    const resultPromise = client.getChannel("lazy").call("wait");
    const reason = new Error("initialization connection closed");

    client.dispose(reason);

    await expect(resultPromise).rejects.toBe(reason);
    server.dispose();
  });

  it("should keep event subscriptions outside pending promise rejection", async () => {
    const { server, client } = createPair();
    const source = new Emitter<string>();
    const listen = vi.fn(() => source.event);
    server.registerChannel("events-dispose", {
      call() {
        return Promise.resolve();
      },
      listen,
    });

    const listener = vi.fn();
    const subscription = client.getChannel("events-dispose").listen("onData")(listener);
    await vi.waitFor(() => {
      expect(listen).toHaveBeenCalledTimes(1);
    });

    client.dispose();
    source.fire("after-dispose");

    expect(listener).not.toHaveBeenCalled();
    subscription.dispose();
    server.dispose();
  });

  it("should preserve structured error fields on Error instances", async () => {
    const { server, client, dispose } = createPair();

    const channel: IServerChannel = {
      call() {
        const error = new Error("Internal error") as Error & {
          code?: number;
          data?: { details: string };
          details?: { requestId: string; issues: Array<{ code: string; scope: string }> };
          kind?: string;
          status?: number;
        };
        error.name = "RequestError";
        error.code = -32603;
        error.kind = "artifact_not_allowed";
        error.status = 422;
        error.data = {
          details: "Cannot set permission mode to auto: auto mode unavailable for this model",
        };
        error.details = {
          requestId: "server-request-123",
          issues: [{ code: "artifact_type_not_allowed", scope: "artifact" }],
        };
        return Promise.reject(error);
      },
      listen() {
        return Event.None;
      },
    };

    server.registerChannel("fail-structured", channel);
    const ch = client.getChannel("fail-structured");

    try {
      await ch.call("anything");
      throw new Error("expected failure");
    } catch (error) {
      const typedError = error as Error & {
        code?: number;
        data?: { details?: string };
        details?: { requestId?: string; issues?: Array<{ code: string; scope: string }> };
        kind?: string;
        status?: number;
      };
      expect(typedError.message).toBe("Internal error");
      expect(typedError.name).toBe("RequestError");
      expect(typedError.code).toBe(-32603);
      expect(typedError.kind).toBe("artifact_not_allowed");
      expect(typedError.status).toBe(422);
      expect(typedError.data?.details).toBe(
        "Cannot set permission mode to auto: auto mode unavailable for this model",
      );
      expect(typedError.details).toEqual({
        requestId: "server-request-123",
        issues: [{ code: "artifact_type_not_allowed", scope: "artifact" }],
      });
    } finally {
      dispose();
    }
  });

  it("should listen to events", async () => {
    const { server, client, dispose } = createPair();

    const emitter = new Emitter<string>();
    const channel: IServerChannel = {
      call() {
        return Promise.resolve();
      },
      listen(_ctx, event) {
        if (event === "onData") return emitter.event;
        return Event.None;
      },
    };

    server.registerChannel("events", channel);
    const ch = client.getChannel("events");

    const values: string[] = [];
    const received = new Promise<void>((resolve) => {
      ch.listen<string>("onData")((v) => {
        values.push(v);
        if (values.length === 2) resolve();
      });
    });

    // Wait for the client to be initialized and event subscription to be registered
    await new Promise((r) => setTimeout(r, 50));
    emitter.fire("first");
    emitter.fire("second");

    await received;
    expect(values).toEqual(["first", "second"]);
    dispose();
  });

  it("should queue requests for channels registered later", async () => {
    const { server, client, dispose } = createPair();

    const ch = client.getChannel("lazy");
    const resultPromise = ch.call<number>("getValue");

    // Register the channel after the call
    await new Promise((r) => setTimeout(r, 50));
    const channel: IServerChannel = {
      call(_ctx, command) {
        if (command === "getValue") return Promise.resolve(42);
        return Promise.reject(new Error("Unknown"));
      },
      listen() {
        return Event.None;
      },
    };
    server.registerChannel("lazy", channel);

    const result = await resultPromise;
    expect(result).toBe(42);
    dispose();
  });

  it("should pass ctx to server channel", async () => {
    const { server, client, dispose } = createPair("my-client");

    let receivedCtx: string | undefined;
    const channel: IServerChannel<string> = {
      call(ctx) {
        receivedCtx = ctx;
        return Promise.resolve("ok");
      },
      listen() {
        return Event.None;
      },
    };

    server.registerChannel("ctx-test", channel);
    const ch = client.getChannel("ctx-test");
    await ch.call("test");
    expect(receivedCtx).toBe("my-client");
    dispose();
  });

  it("should handle multiple concurrent RPC calls over fragmented socket frames", async () => {
    const [serverSocket, clientSocket] = createFragmentedSocketPair(5);
    const serverProtocol = new SocketProtocol(serverSocket);
    const clientProtocol = new SocketProtocol(clientSocket);
    const server = new ChannelServer(serverProtocol, "fragmented");
    const client = new ChannelClient(clientProtocol);
    const disposables = new DisposableStore();

    const channel: IServerChannel = {
      call(_ctx, command, arg) {
        switch (command) {
          case "listTasks":
            return Promise.resolve([{ workspacePath: arg.workspacePath }]);
          case "getWorkspaceProviderConfigFile":
            return Promise.resolve({
              provider: arg.provider,
              path: `${arg.workspacePath}/config.json`,
              exists: true,
            });
          case "prepareWorkspace":
            return Promise.resolve({
              workspacePath: arg.workspacePath,
              provider: arg.provider,
              preparedSessionId: "prepared-session",
              version: "0.0.0-test",
              configOptions: [],
              slashCommands: [],
            });
          default:
            return Promise.reject(new Error(`Unknown command: ${command}`));
        }
      },
      listen() {
        return Event.None;
      },
    };

    server.registerChannel("acp", channel);
    const acp = client.getChannel("acp");

    const [listResult, configResult, prepareResult] = await Promise.all([
      acp.call("listTasks", { workspacePath: "/root" }),
      acp.call("getWorkspaceProviderConfigFile", {
        workspacePath: "/root",
        provider: "claude",
      }),
      acp.call("prepareWorkspace", {
        workspacePath: "/root",
        provider: "claude",
      }),
    ]);

    expect(listResult).toEqual([{ workspacePath: "/root" }]);
    expect(configResult).toEqual({
      provider: "claude",
      path: "/root/config.json",
      exists: true,
    });
    expect(prepareResult).toEqual({
      workspacePath: "/root",
      provider: "claude",
      preparedSessionId: "prepared-session",
      version: "0.0.0-test",
      configOptions: [],
      slashCommands: [],
    });

    disposables.dispose();
    server.dispose();
    client.dispose();
    serverProtocol.dispose();
    clientProtocol.dispose();
  });
});

describe("getDelayedChannel", () => {
  it("should delay call until promise resolves", async () => {
    const emitter = new Emitter<void>();
    let resolved = false;

    const channelPromise = new Promise<any>((resolve) => {
      emitter.event(() => {
        resolved = true;
        resolve({
          call: () => Promise.resolve("delayed-result"),
          listen: () => Event.None,
        });
      });
    });

    const delayed = getDelayedChannel(channelPromise);
    const resultPromise = delayed.call("test");

    expect(resolved).toBe(false);
    emitter.fire();

    const result = await resultPromise;
    expect(result).toBe("delayed-result");
  });
});

// ============================================================================
// 事件订阅错误回传（ResponseType.EventError = 205，上游 a60ba6a7）
// ============================================================================
//
// 反例用 wire 级数字帧构造（200/204/205/102），在枚举引入前后都能编译运行：
// 修复前 205 帧在 onBuffer 的 switch 中无分支，被静默丢弃，订阅泄漏且错误不可达。

describe("event subscription error delivery (ResponseType.EventError)", () => {
  const WIRE_INITIALIZE = 200;
  const WIRE_EVENT_FIRE = 204;
  const WIRE_EVENT_ERROR = 205;
  const WIRE_REQUEST_EVENT_LISTEN = 102;

  function createManualPeerClient() {
    const peerMessages = new Emitter<VSBuffer>();
    const sentFrames: VSBuffer[] = [];
    const protocol: IMessagePassingProtocol = {
      onMessage: peerMessages.event,
      send(buffer: VSBuffer) {
        sentFrames.push(buffer);
      },
    };
    const client = new ChannelClient(protocol);

    const sendResponse = (header: unknown[], body?: unknown) => {
      const writer = new BufferWriter();
      serialize(writer, header);
      serialize(writer, body);
      peerMessages.fire(writer.buffer);
    };
    const parseSentHeader = (frame: VSBuffer) => deserialize(new BufferReader(frame)) as unknown[];

    return { client, sentFrames, sendResponse, parseSentHeader };
  }

  it("terminates the subscription and surfaces the error when an EventError frame arrives", async () => {
    const { client, sentFrames, sendResponse, parseSentHeader } = createManualPeerClient();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const listener = vi.fn();
    const subscription = client.getChannel("events").listen<string>("onData")(listener);
    sendResponse([WIRE_INITIALIZE], undefined);
    await vi.waitFor(() => expect(sentFrames.length).toBe(1));

    const requestHeader = parseSentHeader(sentFrames[0]);
    expect(requestHeader[0]).toBe(WIRE_REQUEST_EVENT_LISTEN);
    const subscriptionId = requestHeader[1] as number;

    // 对端回传订阅失败帧
    sendResponse([WIRE_EVENT_ERROR, subscriptionId], {
      name: "TerminalClosedError",
      message: "terminal already closed",
      stack: ["at channelServer:1"],
    });

    // 错误必须可达：以独立错误日志呈现，而不是被静默丢弃
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain("RPC event subscription failed");

    // 订阅必须终止：同一 id 的后续 EventFire 不再投递给监听器
    sendResponse([WIRE_EVENT_FIRE, subscriptionId], "late-event");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listener).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    subscription.dispose();
    client.dispose();
  });

  it("keeps later subscriptions on the same channel working after an EventError", async () => {
    const { client, sentFrames, sendResponse, parseSentHeader } = createManualPeerClient();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const firstListener = vi.fn();
    const firstSubscription = client.getChannel("events").listen<string>("onData")(firstListener);
    sendResponse([WIRE_INITIALIZE], undefined);
    await vi.waitFor(() => expect(sentFrames.length).toBe(1));
    const firstId = parseSentHeader(sentFrames[0])[1] as number;

    sendResponse([WIRE_EVENT_ERROR, firstId], { name: "Error", message: "rejected" });

    const secondListener = vi.fn();
    const secondSubscription = client.getChannel("events").listen<string>("onData")(secondListener);
    await vi.waitFor(() => expect(sentFrames.length).toBe(2));
    const secondId = parseSentHeader(sentFrames[1])[1] as number;
    expect(secondId).not.toBe(firstId);

    sendResponse([WIRE_EVENT_FIRE, secondId], "still-ok");
    await vi.waitFor(() => expect(secondListener).toHaveBeenCalledWith("still-ok"));
    expect(firstListener).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    secondSubscription.dispose();
    firstSubscription.dispose();
    client.dispose();
  });
});
