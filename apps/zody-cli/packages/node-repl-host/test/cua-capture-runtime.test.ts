import { createConnection } from "node:net";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import type { ComputerUseRuntimeContext } from "@zody/zody-cua";
import {
  createNodeReplCuaBroker,
  resolveTrustedCuaContext,
  type NodeReplCuaBroker,
} from "../src/cua-broker.js";
import {
  createCuaCaptureComputerUseRuntime,
  type CuaCaptureExpectation,
  type CuaCaptureTarget,
} from "../src/cua-capture-runtime.js";
import { createNodeReplMcpRuntime, type NodeReplMcpRuntime } from "../src/node-repl-mcp-runtime.js";
import { createInProcessNodeReplExecutor } from "../src/node-repl-session-executor.js";

const IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lY1J3QAAAABJRU5ErkJggg==";
const CONTEXT: ComputerUseRuntimeContext = {
  runtimeScope: "main",
  sessionId: "session-1",
  workspaceKey: "workspace-1",
  workspacePath: "/workspace",
  workspaceIdentity: "workspace-1",
  turnId: "turn-1",
  clientMode: "desktop-continuous",
  deliveryKind: "desktop-continuous",
};

interface BrokerReply {
  ok?: boolean;
  error?: string;
  result?: {
    content?: Array<Record<string, unknown>>;
    isError?: boolean;
  };
}

function send(socketPath: string, payload: Record<string, unknown>): Promise<BrokerReply> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error?: unknown, value?: BrokerReply) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error("broker socket closed without a reply"));
    };
    socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(undefined, JSON.parse(buffer.slice(0, newline)) as BrokerReply);
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", finish);
    socket.once("close", () => finish());
  });
}

function imageResult(mimeType = "image/png") {
  return {
    content: [{ type: "image", data: IMAGE_BASE64, mimeType }],
  };
}

describe("CuaCaptureComputerUseRuntime direct candidate", () => {
  it("maps the explicit screenshot method to captureOnce with trusted turn binding", async () => {
    const calls: Array<{ target: CuaCaptureTarget; expected: CuaCaptureExpectation }> = [];
    const runtime = createCuaCaptureComputerUseRuntime({
      async captureOnce(target, options) {
        calls.push({ target, expected: options.expected });
        return imageResult("image/jpeg");
      },
    });

    await expect(
      runtime.execute({
        toolName: "screenshot",
        arguments: { target: { pid: 42, windowId: 99 } },
        context: CONTEXT,
      }),
    ).resolves.toMatchObject({ content: [{ type: "image", mimeType: "image/jpeg" }] });
    expect(calls).toEqual([
      {
        target: { pid: 42, windowId: 99 },
        expected: { sessionId: "session-1", workspaceKey: "workspace-1", turnId: "turn-1" },
      },
    ]);
  });

  it("rejects reentrant captures instead of queueing a stale scope", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let captures = 0;
    const runtime = createCuaCaptureComputerUseRuntime({
      async captureOnce() {
        captures += 1;
        await gate;
        return imageResult();
      },
    });
    const first = runtime.execute({
      toolName: "screenshot",
      arguments: { target: { pid: 42, windowId: 99 } },
      context: CONTEXT,
    });
    await expect.poll(() => captures).toBe(1);
    await expect(
      runtime.execute({
        toolName: "screenshot",
        arguments: { target: { pid: 43, windowId: 100 } },
        context: CONTEXT,
      }),
    ).rejects.toThrow("cua_capture_busy");
    release();
    await expect(first).resolves.toMatchObject({ content: [{ type: "image" }] });
    expect(captures).toBe(1);
  });

  it("rejects context/target forgery and leaves other tools unavailable", async () => {
    let captures = 0;
    const runtime = createCuaCaptureComputerUseRuntime({
      async captureOnce() {
        captures += 1;
        return imageResult();
      },
    });

    await expect(
      runtime.execute({
        toolName: "screenshot",
        arguments: { target: { pid: 1, windowId: 2 } },
        context: { ...CONTEXT, turnId: undefined },
      }),
    ).rejects.toThrow("untrusted_context");
    await expect(
      runtime.execute({
        toolName: "screenshot",
        arguments: { target: { pid: 1, windowId: 2 }, sessionId: "forged" },
        context: CONTEXT,
      }),
    ).rejects.toThrow("target_required");
    await expect(
      runtime.execute({ toolName: "get_app_state", context: CONTEXT }),
    ).resolves.toMatchObject({ isError: true, content: [{ type: "text" }] });
    expect(captures).toBe(0);

    await runtime.dispose();
    await expect(
      runtime.execute({
        toolName: "screenshot",
        arguments: { target: { pid: 1, windowId: 2 } },
        context: CONTEXT,
      }),
    ).rejects.toThrow("disposed");
  });

  it("accepts web-remote-replayable context with a remote session id, keeping id checks", async () => {
    // mobile-origin 授权轮次（2026-11-10）：授权事实由 admission→candidate→turn scope 链
    // 承载，本层只做结构可信检查；web-remote-replayable + remoteSessionId 不再无条件拒绝。
    const calls: Array<{ target: CuaCaptureTarget; expected: CuaCaptureExpectation }> = [];
    const runtime = createCuaCaptureComputerUseRuntime({
      async captureOnce(target, options) {
        calls.push({ target, expected: options.expected });
        return imageResult();
      },
    });
    const remoteContext: ComputerUseRuntimeContext = {
      ...CONTEXT,
      clientMode: "web-remote-replayable",
      deliveryKind: "web-remote-replayable",
      remoteSessionId: "remote-session-1",
    };

    await expect(
      runtime.execute({
        toolName: "screenshot",
        arguments: { target: { pid: 42, windowId: 99 } },
        context: remoteContext,
      }),
    ).resolves.toMatchObject({ content: [{ type: "image" }] });
    expect(calls).toEqual([
      {
        target: { pid: 42, windowId: 99 },
        expected: { sessionId: "session-1", workspaceKey: "workspace-1", turnId: "turn-1" },
      },
    ]);

    // clientMode 与 deliveryKind 不一致、subagent scope 仍拒绝。
    await expect(
      runtime.execute({
        toolName: "screenshot",
        arguments: { target: { pid: 42, windowId: 99 } },
        context: { ...remoteContext, deliveryKind: "desktop-continuous" },
      }),
    ).rejects.toThrow("untrusted_context");
    await expect(
      runtime.execute({
        toolName: "screenshot",
        arguments: { target: { pid: 42, windowId: 99 } },
        context: { ...remoteContext, runtimeScope: "subagent" },
      }),
    ).rejects.toThrow("untrusted_context");
  });
});

describe("createCuaCaptureComputerUseRuntime", () => {
  let broker: NodeReplCuaBroker | undefined;
  let runtime: NodeReplMcpRuntime | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
    await runtime?.dispose();
    runtime = undefined;
  });

  it("returns the real image CallToolResult through the existing broker capability", async () => {
    const calls: Array<{ target: CuaCaptureTarget; expected: CuaCaptureExpectation }> = [];
    broker = createNodeReplCuaBroker({
      runtime: createCuaCaptureComputerUseRuntime({
        async captureOnce(target, options) {
          calls.push({ target, expected: options.expected });
          return imageResult();
        },
      }),
      platform: process.platform,
    });
    await broker.ready;
    const capability = await broker.mint({ invocationId: "inv-1", context: CONTEXT });

    const reply = await send(capability.socketPath, {
      id: "capture-1",
      token: capability.token,
      invocationId: "inv-1",
      method: "screenshot",
      input: { target: { pid: 42, windowId: 99 } },
    });

    expect(reply).toMatchObject({
      ok: true,
      result: {
        content: [{ type: "image", data: IMAGE_BASE64, mimeType: "image/png" }],
      },
    });
    expect(calls).toEqual([
      {
        target: { pid: 42, windowId: 99 },
        expected: { sessionId: "session-1", workspaceKey: "workspace-1", turnId: "turn-1" },
      },
    ]);
  });

  it("resolves trusted meta for web-remote-replayable main requests and rejects mismatches", () => {
    // mobile-origin 授权轮次（2026-11-10）：broker 侧结构检查同样接受
    // web-remote-replayable + remote_session_id，clientMode/deliveryKind 透传实际值。
    const remoteMeta = {
      runtime_scope: "main",
      client_mode: "web-remote-replayable",
      delivery_kind: "web-remote-replayable",
      remote_session_id: "remote-session-1",
      session_id: "session-1",
      workspace_identity: "workspace-1",
      turn_id: "turn-1",
    };
    expect(resolveTrustedCuaContext(remoteMeta)).toMatchObject({
      runtimeScope: "main",
      clientMode: "web-remote-replayable",
      deliveryKind: "web-remote-replayable",
      remoteSessionId: "remote-session-1",
      sessionId: "session-1",
      workspaceKey: "workspace-1",
    });

    expect(
      resolveTrustedCuaContext({
        ...remoteMeta,
        delivery_kind: "desktop-continuous",
      }),
    ).toBeUndefined();
    expect(resolveTrustedCuaContext({ ...remoteMeta, runtime_scope: "subagent" })).toBeUndefined();
    expect(resolveTrustedCuaContext({ ...remoteMeta, session_id: "" })).toBeUndefined();
  });

  it("returns the real image through a web-remote-replayable broker capability", async () => {
    const calls: Array<{ target: CuaCaptureTarget; expected: CuaCaptureExpectation }> = [];
    broker = createNodeReplCuaBroker({
      runtime: createCuaCaptureComputerUseRuntime({
        async captureOnce(target, options) {
          calls.push({ target, expected: options.expected });
          return imageResult();
        },
      }),
      platform: process.platform,
    });
    await broker.ready;
    const capability = await broker.mint({
      invocationId: "inv-remote-1",
      context: {
        ...CONTEXT,
        clientMode: "web-remote-replayable",
        deliveryKind: "web-remote-replayable",
        remoteSessionId: "remote-session-1",
      },
    });

    const reply = await send(capability.socketPath, {
      id: "capture-remote-1",
      token: capability.token,
      invocationId: "inv-remote-1",
      method: "screenshot",
      input: { target: { pid: 42, windowId: 99 } },
    });

    expect(reply).toMatchObject({ ok: true, result: { content: [{ type: "image" }] } });
    expect(calls).toEqual([
      {
        target: { pid: 42, windowId: 99 },
        expected: { sessionId: "session-1", workspaceKey: "workspace-1", turnId: "turn-1" },
      },
    ]);
  });

  it("fails closed for forged context, target or unsupported tools", async () => {    let captures = 0;
    const captureRuntime = createCuaCaptureComputerUseRuntime({
      async captureOnce() {
        captures += 1;
        return imageResult();
      },
    });
    broker = createNodeReplCuaBroker({ runtime: captureRuntime, platform: process.platform });
    await broker.ready;

    const forged = await broker.mint({
      invocationId: "inv-forged",
      context: { ...CONTEXT, runtimeScope: "subagent" },
    });
    const forgedReply = await send(forged.socketPath, {
      id: "capture-forged",
      token: forged.token,
      invocationId: "inv-forged",
      method: "screenshot",
      input: { target: { pid: 1, windowId: 2 } },
    });
    expect(forgedReply).toMatchObject({ ok: false, error: expect.stringContaining("untrusted_context") });

    const missingTurn = await broker.mint({
      invocationId: "inv-missing-turn",
      context: { ...CONTEXT, turnId: undefined },
    });
    const missingTurnReply = await send(missingTurn.socketPath, {
      id: "capture-missing-turn",
      token: missingTurn.token,
      invocationId: "inv-missing-turn",
      method: "screenshot",
      input: { target: { pid: 1, windowId: 2 } },
    });
    expect(missingTurnReply).toMatchObject({
      ok: false,
      error: expect.stringContaining("untrusted_context"),
    });

    const valid = await broker.mint({ invocationId: "inv-valid", context: CONTEXT });
    const missingTarget = await send(valid.socketPath, {
      id: "capture-missing-target",
      token: valid.token,
      invocationId: "inv-valid",
      method: "screenshot",
      input: {},
    });
    expect(missingTarget).toMatchObject({
      ok: false,
      error: expect.stringContaining("target_required"),
    });

    const extras = await send(valid.socketPath, {
      id: "capture-extras",
      token: valid.token,
      invocationId: "inv-valid",
      method: "screenshot",
      input: { target: { pid: 1, windowId: 2 }, sessionId: "forged" },
    });
    expect(extras).toMatchObject({ ok: false, error: expect.stringContaining("target_required") });

    const unavailable = await send(valid.socketPath, {
      id: "left-click",
      token: valid.token,
      invocationId: "inv-valid",
      method: "left_click",
      input: {},
    });
    expect(unavailable).toMatchObject({
      ok: true,
      result: { isError: true, content: [{ type: "text" }] },
    });
    expect(captures).toBe(0);
  });

  it("aborts and drains an in-flight capture through the existing broker revoke path", async () => {
    let started = false;
    let aborted = false;
    broker = createNodeReplCuaBroker({
      runtime: createCuaCaptureComputerUseRuntime({
        async captureOnce(_target, options) {
          started = true;
          return await new Promise((_, reject) => {
            const onAbort = () => {
              aborted = true;
              reject(new DOMException("The operation was aborted", "AbortError"));
            };
            if (options.signal?.aborted) onAbort();
            else options.signal?.addEventListener("abort", onAbort, { once: true });
          });
        },
      }),
      platform: process.platform,
    });
    await broker.ready;
    const capability = await broker.mint({ invocationId: "inv-abort", context: CONTEXT });
    const pending = send(capability.socketPath, {
      id: "capture-abort",
      token: capability.token,
      invocationId: "inv-abort",
      method: "screenshot",
      input: { target: { pid: 1, windowId: 2 } },
    }).catch((error: unknown) => error);

    await expect.poll(() => started).toBe(true);
    await broker.revoke("inv-abort");
    await pending;
    expect(aborted).toBe(true);
  });

  it("returns the captured image through a real node_repl js tool call", async () => {
    const calls: Array<{ target: CuaCaptureTarget; expected: CuaCaptureExpectation }> = [];
    const cuaRuntime = createCuaCaptureComputerUseRuntime({
      async captureOnce(target, options) {
        calls.push({ target, expected: options.expected });
        return imageResult();
      },
    });
    runtime = createNodeReplMcpRuntime({
      executeJs: createInProcessNodeReplExecutor(),
      cuaRuntime,
      cuaRuntimeOwnership: "borrowed",
    });
    const client = new Client({ name: "cua-capture-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await runtime.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "js",
        arguments: {
          code:
            "const bridge = globalThis[Symbol.for('zcode.node-repl.computer-use-bridge')];\n" +
            "const captured = await bridge.call('screenshot', { target: { pid: 42, windowId: 99 } });\n" +
            "captured;",
          title: "读取可信桌面截图",
        },
        _meta: {
          "com.zcode/request-context": {
            runtime_scope: "main",
            session_id: "session-1",
            workspace_path: "/workspace",
            workspace_identity: "workspace-1",
            turn_id: "turn-1",
            client_mode: "desktop-continuous",
            delivery_kind: "desktop-continuous",
          },
        },
      });
      expect(result.content).toContainEqual(
        expect.objectContaining({ type: "image", data: IMAGE_BASE64, mimeType: "image/png" }),
      );
      expect(calls).toEqual([
        {
          target: { pid: 42, windowId: 99 },
          expected: { sessionId: "session-1", workspaceKey: "workspace-1", turnId: "turn-1" },
        },
      ]);
    } finally {
      await client.close();
    }
  });
});
