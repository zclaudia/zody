import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCuaBrokerSocketPath,
  createNodeReplCuaBroker,
  resolveTrustedCuaContext,
  type NodeReplCuaBroker,
} from "../src/cua-broker.js";

const context = {
  runtimeScope: "main" as const,
  sessionId: "session-1",
  workspaceKey: "workspace-1",
  workspacePath: "/workspace",
  workspaceIdentity: "workspace-1",
  turnId: "turn-1",
  clientMode: "desktop-continuous" as const,
  deliveryKind: "desktop-continuous" as const,
};

interface BrokerReply {
  ok?: boolean;
  error?: string;
  result?: CallToolResult;
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
    socket.once("error", (error) => finish(error));
    socket.once("close", () => finish());
  });
}

function reply(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("node_repl CUA broker", () => {
  let broker: NodeReplCuaBroker | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  it("uses named pipes on win32 and unix sockets elsewhere", () => {
    expect(createCuaBrokerSocketPath("win32", "abc")).toBe(
      String.raw`\\.\pipe\zody-node-repl-cua-abc`,
    );
    expect(createCuaBrokerSocketPath("darwin", "abc")).toBe(`${tmpdir()}/znrc-abc.sock`);
    expect(createCuaBrokerSocketPath("linux", "abc")).toBe(`${tmpdir()}/znrc-abc.sock`);
  });

  it("mints a token per invocation and rejects old tokens after revoke", async () => {
    const calls: Array<{ context?: unknown }> = [];
    broker = createNodeReplCuaBroker({
      runtime: {
        execute: async (input) => {
          calls.push(input);
          return reply("ok");
        },
        closeSession: async () => undefined,
        dispose: async () => undefined,
      },
      platform: process.platform,
    });
    await broker.ready;
    const capability = await broker.mint({ invocationId: "inv-1", context });

    const allowed = await send(capability.socketPath, {
      id: "request-1",
      token: capability.token,
      invocationId: "inv-1",
      method: "screenshot",
      input: { display_id: 1 },
    });
    expect(allowed.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.context).toMatchObject({
      sessionId: "session-1",
      workspaceKey: "workspace-1",
      clientMode: "desktop-continuous",
      deliveryKind: "desktop-continuous",
    });
    expect(Object.isFrozen(calls[0]?.context)).toBe(true);

    await broker.revoke("inv-1");
    const revoked = await send(capability.socketPath, {
      id: "request-2",
      token: capability.token,
      invocationId: "inv-1",
      method: "screenshot",
      input: {},
    });
    expect(revoked.ok).toBe(false);
    expect(revoked.error).toContain("not authorized");
    expect(calls).toHaveLength(1);
  });

  it("rejects forged context and cross-invocation tokens without executing", async () => {
    let executions = 0;
    broker = createNodeReplCuaBroker({
      runtime: {
        execute: async () => {
          executions += 1;
          return reply("ok");
        },
        closeSession: async () => undefined,
        dispose: async () => undefined,
      },
      platform: process.platform,
    });
    await broker.ready;
    const first = await broker.mint({ invocationId: "inv-1", context });
    const second = await broker.mint({ invocationId: "inv-2", context });

    const forgedContext = await send(first.socketPath, {
      id: "request-forged-context",
      token: first.token,
      invocationId: "inv-1",
      method: "screenshot",
      input: {},
      context: { sessionId: "forged" },
    });
    expect(forgedContext.ok).toBe(false);

    const crossToken = await send(first.socketPath, {
      id: "request-cross-token",
      token: second.token,
      invocationId: "inv-1",
      method: "screenshot",
      input: {},
    });
    expect(crossToken.ok).toBe(false);
    expect(executions).toBe(0);
  });

  it("keeps one revoke drain and awaits it from reentrant revoke/close calls", async () => {
    let resolveExecution: ((value: CallToolResult) => void) | undefined;
    let executionStarted = false;
    broker = createNodeReplCuaBroker({
      runtime: {
        execute: async () =>
          await new Promise<CallToolResult>((resolve) => {
            executionStarted = true;
            resolveExecution = resolve;
          }),
        closeSession: async () => undefined,
        dispose: async () => undefined,
      },
      platform: process.platform,
    });
    await broker.ready;
    const capability = await broker.mint({ invocationId: "inv-1", context });
    const pending = send(capability.socketPath, {
      id: "request-1",
      token: capability.token,
      invocationId: "inv-1",
      method: "screenshot",
      input: {},
    }).catch((error: unknown) => error);
    await waitFor(() => executionStarted);

    const revokeFirst = broker.revoke("inv-1");
    const revokeSecond = broker.revoke("inv-1");
    expect(revokeSecond).toBe(revokeFirst);
    let drained = false;
    void revokeFirst.then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(drained).toBe(false);

    const closeFirst = broker.close();
    const closeSecond = broker.close();
    expect(closeSecond).toBe(closeFirst);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(drained).toBe(false);

    resolveExecution?.(reply("completed"));
    await Promise.allSettled([revokeFirst, closeFirst, pending]);
    expect(drained).toBe(true);
  });

  it("does not let a runtime mutation leak into the next request", async () => {
    const seen: string[] = [];
    broker = createNodeReplCuaBroker({
      runtime: {
        execute: async (input) => {
          seen.push(String(input.context.sessionId));
          try {
            (input.context as { sessionId: string }).sessionId = "mutated-by-runtime";
          } catch {
            // frozen context 会直接抛错；两种结果都不能影响下一次请求。
          }
          return reply("ok");
        },
        closeSession: async () => undefined,
        dispose: async () => undefined,
      },
      platform: process.platform,
    });
    await broker.ready;
    const mutable = { ...context };
    const capability = await broker.mint({ invocationId: "inv-1", context: mutable });
    mutable.sessionId = "mutated-after-mint";

    for (const id of ["request-1", "request-2"]) {
      const response = await send(capability.socketPath, {
        id,
        token: capability.token,
        invocationId: "inv-1",
        method: "screenshot",
        input: {},
      });
      expect(response.ok).toBe(true);
    }
    expect(seen).toEqual(["session-1", "session-1"]);
  });

  it("keeps strict CUA admission fail-closed without inventing desktop/main defaults", () => {
    const meta = {
      runtime_scope: "main" as const,
      session_id: "session-1",
      workspace_path: "/workspace",
      turn_id: "turn-1",
      client_mode: "desktop-continuous",
      delivery_kind: "desktop-continuous",
    };
    expect(resolveTrustedCuaContext(meta)).toBeDefined();
    expect(resolveTrustedCuaContext({ ...meta, remote_session_id: "remote-1" })).toBeUndefined();
    expect(resolveTrustedCuaContext({ ...meta, runtime_scope: undefined })).toBeUndefined();
    expect(resolveTrustedCuaContext({ ...meta, runtime_scope: "unknown" })).toBeUndefined();
    expect(resolveTrustedCuaContext({ ...meta, client_mode: undefined })).toBeUndefined();
    expect(
      resolveTrustedCuaContext({ ...meta, delivery_kind: "web-remote-replayable" }),
    ).toBeUndefined();
    expect(resolveTrustedCuaContext({ ...meta, session_id: undefined })).toBeUndefined();
    expect(
      resolveTrustedCuaContext({
        ...meta,
        workspace_path: undefined,
        workspace_identity: undefined,
      }),
    ).toBeUndefined();
  });
});
