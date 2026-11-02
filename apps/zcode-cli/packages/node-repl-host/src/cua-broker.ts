import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeReplRequestMeta } from "@zcode/core/repl";
import type { Logger } from "@zcode/contracts";
import type { ComputerUseRuntime, ComputerUseRuntimeContext } from "@zcode/zcode-cua";
import { z } from "zod";
import type { NodeReplCuaBrokerConnection } from "./cua-bridge.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DESKTOP_CONTINUOUS = "desktop-continuous";

const brokerRequestSchema = z
  .object({
    id: z.string().min(1),
    token: z.string().min(1),
    invocationId: z.string().min(1).max(200),
    method: z.string().min(1),
    input: z.unknown().optional(),
  })
  .strict();

type BrokerRequest = z.infer<typeof brokerRequestSchema>;

interface Capability {
  invocationId: string;
  token: string;
  context: ComputerUseRuntimeContext;
  revoked: boolean;
  revokePromise?: Promise<void>;
  sockets: Set<Socket>;
  controllers: Set<AbortController>;
  pending: Set<Promise<unknown>>;
}

export interface NodeReplCuaBroker {
  ready: Promise<void>;
  mint(input: {
    invocationId: string;
    context: ComputerUseRuntimeContext;
  }): Promise<NodeReplCuaBrokerConnection>;
  revoke(invocationId: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * 只为 CUA bridge 绑定收紧 scope。`com.zcode/request-context` 是宿主写入的关联元数据，
 * 不是经认证的 sideband，也不是 live submission authority；这里不签发原生输入资格。
 */
export function resolveTrustedCuaContext(
  meta: NodeReplRequestMeta,
): ComputerUseRuntimeContext | undefined {
  if (meta.runtime_scope !== "main") return undefined;
  if (meta.client_mode !== DESKTOP_CONTINUOUS) return undefined;
  if (meta.delivery_kind !== DESKTOP_CONTINUOUS) return undefined;

  const stringMeta = (key: string): string | undefined => {
    const value = meta[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  if (stringMeta("remote_session_id")) return undefined;

  const sessionId = stringMeta("session_id");
  const workspacePath = stringMeta("workspace_path");
  const workspaceIdentity = stringMeta("workspace_identity");
  // 身份 key 先取真实 identity/path；只有两者都缺失时才接受宿主给出的 workspace_key。
  const workspaceKey = workspaceIdentity || workspacePath || stringMeta("workspace_key");
  if (!sessionId || !workspaceKey) return undefined;

  const turnId = stringMeta("turn_id");
  const traceId = stringMeta("trace_id");
  return {
    sessionId,
    runtimeScope: "main",
    workspaceKey,
    ...(workspacePath ? { workspacePath } : {}),
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(turnId ? { turnId } : {}),
    clientMode: DESKTOP_CONTINUOUS,
    deliveryKind: DESKTOP_CONTINUOUS,
    ...(traceId
      ? {
          trace: {
            traceId,
            ...(stringMeta("span_id") ? { spanId: stringMeta("span_id") } : {}),
            ...(stringMeta("parent_span_id") ? { parentSpanId: stringMeta("parent_span_id") } : {}),
          },
        }
      : {}),
  };
}

export function createNodeReplCuaBroker(input: {
  runtime: ComputerUseRuntime;
  logger?: Logger;
  platform?: NodeJS.Platform | string;
}): NodeReplCuaBroker {
  const platform = input.platform ?? process.platform;
  const socketPath = createCuaBrokerSocketPath(platform);
  const byInvocation = new Map<string, Capability>();
  // revoke 可能先删除 byInvocation，再被 close 重复等待；保留 drain 直到真正结算。
  const invocationDrains = new Set<Promise<void>>();
  const sockets = new Set<Socket>();
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    void handleSocket(socket, input.runtime, authorize, input.logger).catch((error) => {
      input.logger?.warn("Node REPL CUA broker request failed", {
        event: "node_repl.cua_broker.request.failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  server.on("error", (error) => {
    input.logger?.error("Node REPL CUA broker failed", error, {
      event: "node_repl.cua_broker.failed",
    });
  });
  server.listen(socketPath);
  server.unref();
  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  function authorize(token: string, invocationId: string): Capability {
    const capability = byInvocation.get(invocationId);
    if (!capability || capability.revoked) {
      throw new Error("Computer Use broker request is not authorized");
    }
    assertToken(token, capability.token);
    return capability;
  }

  async function mint(session: {
    invocationId: string;
    context: ComputerUseRuntimeContext;
  }): Promise<NodeReplCuaBrokerConnection> {
    await ready;
    if (closed) throw new Error("Computer Use broker is closed");
    if (byInvocation.has(session.invocationId)) {
      throw new Error("Computer Use broker invocation already has a capability");
    }
    const capability: Capability = {
      invocationId: session.invocationId,
      token: randomBytes(32).toString("hex"),
      // 保存冻结副本，避免 runtime.execute 改写 context 后影响同一 capability 的下一次请求。
      context: copyContext(session.context),
      revoked: false,
      sockets: new Set(),
      controllers: new Set(),
      pending: new Set(),
    };
    byInvocation.set(capability.invocationId, capability);
    return { socketPath, token: capability.token, invocationId: capability.invocationId };
  }

  function revoke(invocationId: string): Promise<void> {
    const capability = byInvocation.get(invocationId);
    if (!capability) return Promise.resolve();
    if (capability.revokePromise) return capability.revokePromise;
    // 先同步封闭准入，但不删除 entry：重入 revoke/close 必须 await 同一个 drain。
    capability.revoked = true;
    const drain = (async () => {
      for (const socket of capability.sockets) socket.destroy();
      for (const controller of capability.controllers) controller.abort();
      await Promise.allSettled(capability.pending);
      if (byInvocation.get(invocationId) === capability) byInvocation.delete(invocationId);
    })();
    capability.revokePromise = drain;
    invocationDrains.add(drain);
    void drain.then(
      () => invocationDrains.delete(drain),
      () => invocationDrains.delete(drain),
    );
    return drain;
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closed = true;
      // 先同步启动所有 revoke；drain 集合同时覆盖已经被前一次 revoke 接管、但尚未结算的
      // invocation，避免 close 在 byInvocation 删除后漏等。
      const revokes = [...byInvocation.keys()].map((invocationId) => revoke(invocationId));
      await Promise.allSettled(new Set([...invocationDrains, ...revokes]));
      for (const socket of sockets) socket.destroy();
      await ready.catch(() => undefined);
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      if (platform !== "win32") await rm(socketPath, { force: true });
    })();
    return closePromise;
  }

  return { ready, mint, revoke, close };
}

async function handleSocket(
  socket: Socket,
  runtime: ComputerUseRuntime,
  authorize: (token: string, invocationId: string) => Capability,
  logger: Logger | undefined,
): Promise<void> {
  let completed = false;
  let requestId: string | undefined;
  let controller: AbortController | undefined;
  socket.on("error", () => {
    if (!completed) controller?.abort();
  });
  socket.once("close", () => {
    if (!completed) controller?.abort();
  });
  try {
    const raw = await readLine(socket);
    const payload = parseJson(raw);
    if (isRecord(payload) && typeof payload.id === "string") requestId = payload.id;
    const request: BrokerRequest = brokerRequestSchema.parse(payload);
    const capability = authorize(request.token, request.invocationId);
    controller = new AbortController();
    capability.sockets.add(socket);
    capability.controllers.add(controller);
    socket.once("close", () => controller?.abort());

    const execution = runtime.execute({
      toolName: request.method as never,
      arguments: request.input,
      // context 只来自 main mint 时绑定的可信副本；cell 请求里的同名字段会被 strict schema 拒绝。
      context: copyContext(capability.context),
      signal: controller.signal,
    });
    capability.pending.add(execution);
    try {
      const result = await execution;
      completed = true;
      respond(socket, { id: request.id, ok: true, result });
    } finally {
      capability.pending.delete(execution);
      capability.controllers.delete(controller);
      capability.sockets.delete(socket);
    }
  } catch (error) {
    completed = true;
    logger?.debug("Node REPL CUA broker request rejected", {
      event: "node_repl.cua_broker.request.rejected",
      error: error instanceof Error ? error.message : String(error),
    });
    respond(socket, {
      id: requestId ?? null,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function createCuaBrokerSocketPath(
  platform: NodeJS.Platform | string,
  id = randomUUID(),
): string {
  return platform === "win32"
    ? `\\\\.\\pipe\\zody-node-repl-cua-${id}`
    : join(tmpdir(), `znrc-${id}.sock`);
}

function copyContext(context: ComputerUseRuntimeContext): ComputerUseRuntimeContext {
  const copy = structuredClone(context);
  if (copy.trace) Object.freeze(copy.trace);
  return Object.freeze(copy);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Computer Use broker request is not valid JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertToken(actualValue: unknown, expectedValue: string): void {
  if (typeof actualValue !== "string") {
    throw new Error("Computer Use broker request is not authorized");
  }
  const actual = Buffer.from(actualValue);
  const expected = Buffer.from(expectedValue);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Computer Use broker request is not authorized");
  }
}

function respond(socket: Socket, response: unknown): void {
  if (!socket.writable) return;
  const line = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(line) > MAX_RESPONSE_BYTES) {
    const id = isRecord(response) && typeof response.id === "string" ? response.id : null;
    socket.end(
      `${JSON.stringify({
        id,
        ok: false,
        error: `Computer Use broker response exceeded ${MAX_RESPONSE_BYTES} bytes`,
      })}\n`,
    );
    return;
  }
  socket.end(line);
}

async function readLine(socket: Socket): Promise<string> {
  return await new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        cleanup();
        reject(new Error("Computer Use broker request exceeded 1 MiB"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(buffer.slice(0, newline));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Computer Use broker request socket closed"));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}
