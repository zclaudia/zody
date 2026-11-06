import { z } from "zod";
import type { NodeReplRunResult } from "@zody/core/repl";

// 候选协议只服务本包的 cell 子进程；版本变化必须显式拒绝，不能靠字段存在性猜测。
export const CELL_PROTOCOL_VERSION = 1;
export const CELL_RUN_FLAG = "--zcode-node-repl-cell";
export const CELL_REQUEST_MAX_BYTES = 1024 * 1024;
export const CELL_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;
export const CELL_DIAGNOSTIC_MAX_BYTES = 64 * 1024;

export interface CellBrokerCapability {
  socketPath: string;
  token: string;
}

export interface CellCuaCapability extends CellBrokerCapability {
  invocationId: string;
}

export interface CellDocumentationRoots {
  browser: string;
  cua: string;
}

export type CellRequest = {
  version: typeof CELL_PROTOCOL_VERSION;
  invocationId: string;
  code: string;
  requestMeta: Record<string, unknown>;
  syncTimeoutMs: number;
  cuaCapability?: CellCuaCapability;
  browserCapability?: CellBrokerCapability;
  documentationRoots: CellDocumentationRoots;
};

const capabilitySchema = z
  .object({ socketPath: z.string().min(1), token: z.string().min(1) })
  .strict();
const cuaCapabilitySchema = capabilitySchema
  .extend({ invocationId: z.string().min(1).max(200) })
  .strict();
const documentationRootsSchema = z
  .object({ browser: z.string().min(1), cua: z.string().min(1) })
  .strict();

export const cellRequestSchema = z
  .object({
    version: z.literal(CELL_PROTOCOL_VERSION),
    invocationId: z.string().min(1).max(200),
    code: z.string(),
    requestMeta: z.record(z.string(), z.unknown()),
    syncTimeoutMs: z.number().int().min(1).max(120_000),
    cuaCapability: cuaCapabilitySchema.optional(),
    browserCapability: capabilitySchema.optional(),
    documentationRoots: documentationRootsSchema,
  })
  .strict();

const structuredResultSchema = z
  .object({
    content: z.array(z.object({ type: z.string() }).catchall(z.unknown())),
    isError: z.boolean().optional(),
    structuredContent: z.record(z.string(), z.unknown()).optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const runResultSchema = z
  .object({
    result: z.string().optional(),
    logs: z.string(),
    error: z
      .object({
        name: z.string(),
        message: z.string(),
        stack: z.string().optional(),
      })
      .strict()
      .optional(),
    images: z.array(z.object({ base64: z.string(), mimeType: z.string() }).strict()).optional(),
    browserScreenshotImageIndices: z.array(z.number().int()).optional(),
    structuredResults: z.array(structuredResultSchema).optional(),
    responseMeta: z.record(z.string(), z.unknown()).optional(),
    cuaApp: z
      .object({ appKey: z.string(), displayName: z.string().optional() })
      .strict()
      .optional(),
  })
  .strict();

const protocolErrorSchema = z
  .object({
    name: z.string(),
    message: z.string(),
    stack: z.string().optional(),
  })
  .strict();

export const cellResponseSchema = z.union([
  z
    .object({
      version: z.literal(CELL_PROTOCOL_VERSION),
      invocationId: z.string().min(1).max(200),
      ok: z.literal(true),
      result: runResultSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(CELL_PROTOCOL_VERSION),
      invocationId: z.string().min(1).max(200).nullable(),
      ok: z.literal(false),
      error: protocolErrorSchema,
    })
    .strict(),
]);

export type CellResponse = z.infer<typeof cellResponseSchema>;

export class CellProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CellProtocolError";
  }
}

export function encodeCellRequest(request: CellRequest, maxBytes = CELL_REQUEST_MAX_BYTES): string {
  const parsed = cellRequestSchema.parse(request);
  const line = `${JSON.stringify(parsed)}\n`;
  if (Buffer.byteLength(line) > maxBytes) {
    throw new CellProtocolError(`node_repl cell request exceeded ${maxBytes} bytes`);
  }
  return line;
}

export function parseCellRequest(raw: string, maxBytes = CELL_REQUEST_MAX_BYTES): CellRequest {
  if (Buffer.byteLength(raw) > maxBytes) {
    throw new CellProtocolError(`node_repl cell request exceeded ${maxBytes} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CellProtocolError("node_repl cell request is not valid JSON");
  }
  const parsed = cellRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new CellProtocolError(
      `node_repl cell request is invalid: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
    );
  }
  return parsed.data;
}

export function encodeCellResponse(
  response: CellResponse,
  maxBytes = CELL_RESPONSE_MAX_BYTES,
): string {
  const parsed = cellResponseSchema.parse(response);
  const line = `${JSON.stringify(parsed)}\n`;
  if (Buffer.byteLength(line) > maxBytes) {
    throw new CellProtocolError(`node_repl cell response exceeded ${maxBytes} bytes`);
  }
  return line;
}

export function parseCellResponse(raw: string, maxBytes = CELL_RESPONSE_MAX_BYTES): CellResponse {
  if (Buffer.byteLength(raw) > maxBytes) {
    throw new CellProtocolError(`node_repl cell response exceeded ${maxBytes} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CellProtocolError("node_repl cell response is not valid JSON");
  }
  const parsed = cellResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new CellProtocolError(
      `node_repl cell response is invalid: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
    );
  }
  return parsed.data;
}

export function cellErrorResponse(invocationId: string | undefined, error: unknown): CellResponse {
  const value = error instanceof Error ? error : new Error(String(error));
  return {
    version: CELL_PROTOCOL_VERSION,
    invocationId: invocationId ?? null,
    ok: false,
    error: {
      name: value.name || "CellProtocolError",
      message: value.message || "node_repl cell execution failed",
    },
  };
}

export function cellResultResponse(invocationId: string, result: NodeReplRunResult): CellResponse {
  return {
    version: CELL_PROTOCOL_VERSION,
    invocationId,
    ok: true,
    result,
  };
}
