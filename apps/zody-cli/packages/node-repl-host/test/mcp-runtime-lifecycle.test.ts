import { createConnection } from "node:net";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerUseRuntime } from "@zody/zody-cua";
import { createNodeReplMcpRuntime, type NodeReplMcpRuntime } from "../src/node-repl-mcp-runtime.js";

const requestMeta = {
  "com.zcode/request-context": {
    runtime_scope: "main",
    session_id: "session-1",
    workspace_path: "/workspace",
    turn_id: "turn-1",
    client_mode: "desktop-continuous",
    delivery_kind: "desktop-continuous",
  },
};

function runtimeWithExecute(execute: ComputerUseRuntime["execute"]): ComputerUseRuntime {
  return {
    execute,
    closeSession: async () => undefined,
    dispose: vi.fn(async () => undefined),
  };
}

async function connect(runtime: NodeReplMcpRuntime): Promise<Client> {
  const client = new Client({ name: "node-repl-lifecycle", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await runtime.server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function brokerCall(connection: {
  socketPath: string;
  token: string;
  invocationId: string;
}): Promise<CallToolResult> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(connection.socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error?: unknown, value?: CallToolResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error("broker closed without a response"));
    };
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          id: "lifecycle-request",
          token: connection.token,
          invocationId: connection.invocationId,
          method: "screenshot",
          input: {},
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const payload = JSON.parse(buffer.slice(0, newline)) as {
        ok?: boolean;
        error?: string;
        result?: CallToolResult;
      };
      if (payload.ok && payload.result) finish(undefined, payload.result);
      else finish(new Error(payload.error ?? "broker failed"));
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => finish());
  });
}

describe("node_repl runtime lifecycle", () => {
  let runtime: NodeReplMcpRuntime | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await runtime?.dispose().catch(() => undefined);
    client = undefined;
    runtime = undefined;
  });

  it("awaits an owned producer exactly once and never disposes a borrowed producer", async () => {
    const owned = runtimeWithExecute(async () => ({
      content: [{ type: "text", text: "owned" }],
    }));
    runtime = createNodeReplMcpRuntime({
      cuaRuntime: owned,
      cuaRuntimeOwnership: "owned",
      executeJs: async () => ({ logs: "", result: "ok" }),
    });
    client = await connect(runtime);
    await client.callTool({ name: "js", arguments: { code: "1" }, _meta: requestMeta });
    const firstDispose = runtime.dispose();
    expect(runtime.dispose()).toBe(firstDispose);
    await firstDispose;
    expect(owned.dispose).toHaveBeenCalledOnce();

    const borrowed = runtimeWithExecute(async () => ({
      content: [{ type: "text", text: "borrowed" }],
    }));
    runtime = createNodeReplMcpRuntime({
      cuaRuntime: borrowed,
      cuaRuntimeOwnership: "borrowed",
      executeJs: async () => ({ logs: "", result: "ok" }),
    });
    client = await connect(runtime);
    await client.callTool({ name: "js", arguments: { code: "1" }, _meta: requestMeta });
    await runtime.dispose();
    expect(borrowed.dispose).not.toHaveBeenCalled();
  });

  it("starts broker revoke in parallel with dispose while the cell executor is still blocked", async () => {
    let signalBrokerStarted: () => void = () => undefined;
    const brokerStarted = new Promise<void>((resolve) => {
      signalBrokerStarted = resolve;
    });
    let signalBrokerAborted: () => void = () => undefined;
    const brokerAborted = new Promise<void>((resolve) => {
      signalBrokerAborted = resolve;
    });
    const cuaRuntime = runtimeWithExecute(
      async (input) =>
        await new Promise<CallToolResult>((_resolve, reject) => {
          signalBrokerStarted();
          input.signal.addEventListener(
            "abort",
            () => {
              signalBrokerAborted();
              reject(input.signal.reason);
            },
            { once: true },
          );
        }),
    );

    let signalExecuteStarted: () => void = () => undefined;
    const executeStarted = new Promise<void>((resolve) => {
      signalExecuteStarted = resolve;
    });
    let releaseExecute: () => void = () => undefined;
    const executeGate = new Promise<void>((resolve) => {
      releaseExecute = resolve;
    });
    let executeFinished = false;
    let brokerRequestSettled = false;

    runtime = createNodeReplMcpRuntime({
      cuaRuntime,
      cuaRuntimeOwnership: "owned",
      executeJs: async (input) => {
        signalExecuteStarted();
        if (input.cuaBroker) {
          void brokerCall(input.cuaBroker)
            .catch(() => undefined)
            .finally(() => {
              brokerRequestSettled = true;
            });
        }
        await executeGate;
        executeFinished = true;
        return { logs: "", result: "late" };
      },
    });
    client = await connect(runtime);
    const call = client
      .callTool({ name: "js", arguments: { code: "1" }, _meta: requestMeta })
      .catch((error: unknown) => error);

    await executeStarted;
    await brokerStarted;
    const dispose = runtime.dispose();
    await brokerAborted;
    await waitFor(() => brokerRequestSettled);
    expect(executeFinished).toBe(false);

    let disposeResolved = false;
    void dispose.then(() => {
      disposeResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disposeResolved).toBe(false);

    releaseExecute();
    await call;
    await dispose;
    expect(disposeResolved).toBe(true);
    expect(cuaRuntime.dispose).toHaveBeenCalledOnce();
  });

  it("does not wait for serialized calls that have not started", async () => {
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let started = 0;
    let signalFirstStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    runtime = createNodeReplMcpRuntime({
      executeJs: async () => {
        started += 1;
        if (started === 1) {
          signalFirstStarted();
          await firstGate;
        }
        return { logs: "", result: "ok" };
      },
    });
    client = await connect(runtime);
    const first = client
      .callTool({ name: "js", arguments: { code: "1" }, _meta: requestMeta })
      .catch((error: unknown) => error);
    const second = client
      .callTool({ name: "js", arguments: { code: "2" }, _meta: requestMeta })
      .catch((error: unknown) => error);
    await firstStarted;
    const dispose = runtime.dispose();
    releaseFirst();
    await Promise.all([first, second, dispose]);
    expect(started).toBe(1);
  });
});
