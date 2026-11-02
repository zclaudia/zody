import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Node-only 的 Helper/CLI 传输认证。只通过显式 subpath 导入，不进入 shared
// 主 index，避免 web/renderer 打包到 node:crypto。

export type HelperTransportRole = "cell" | "authority";

export const HELPER_TRANSPORT_PROOF_DOMAIN = "zody.cua.desktop-session.transport.helper-proof";

const PROOF_VERSION = "1";
const HEX64 = /^[0-9a-f]{64}$/u;
const MAX_BOUND_BYTES = 64 * 1024 * 1024;

export interface HelperTransportProofRequest {
  readonly role: HelperTransportRole;
  readonly challenge: string;
  readonly sourceSha256: string;
  readonly requestMaxBytes: number;
  readonly responseMaxBytes: number;
}

export interface HelperProofFrame {
  readonly schemaVersion: 1;
  readonly type: "helper-proof";
  readonly role: HelperTransportRole;
  readonly challenge: string;
  readonly proof: string;
}

export function assertTransportAuthenticationKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || !HEX64.test(value)) {
    throw new Error("cua_helper_transport_key_invalid");
  }
}

export function generateTransportChallenge(): string {
  return randomBytes(32).toString("hex");
}

export function transportProofCanonical(
  role: HelperTransportRole,
  challengeHex: string,
  sourceSha256: string,
  requestMaxBytes: number,
  responseMaxBytes: number,
): string {
  if (role !== "cell" && role !== "authority") {
    throw new Error("cua_helper_transport_role_invalid");
  }
  if (!HEX64.test(challengeHex)) {
    throw new Error("cua_helper_transport_challenge_invalid");
  }
  if (role === "cell") {
    if (!HEX64.test(sourceSha256)) {
      throw new Error("cua_helper_transport_source_invalid");
    }
    if (!positiveBound(requestMaxBytes) || !positiveBound(responseMaxBytes)) {
      throw new Error("cua_helper_transport_bound_invalid");
    }
  } else if (sourceSha256 !== "" || requestMaxBytes !== 0 || responseMaxBytes !== 0) {
    throw new Error("cua_helper_transport_authority_fields_invalid");
  }
  return (
    `${HELPER_TRANSPORT_PROOF_DOMAIN}|${PROOF_VERSION}|${role}|${challengeHex}|` +
    `${sourceSha256}|${requestMaxBytes}|${responseMaxBytes}`
  );
}

export function computeHelperTransportProof(keyHex: string, canonical: string): string {
  assertTransportAuthenticationKey(keyHex);
  return createHmac("sha256", Buffer.from(keyHex, "hex")).update(canonical, "utf8").digest("hex");
}

export function verifyHelperTransportProof(
  keyHex: string,
  canonical: string,
  proofHex: string,
): boolean {
  if (typeof proofHex !== "string" || !HEX64.test(proofHex)) return false;
  try {
    const expected = Buffer.from(computeHelperTransportProof(keyHex, canonical), "hex");
    const actual = Buffer.from(proofHex, "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function serializeHelperProofRequest(request: HelperTransportProofRequest): string {
  transportProofCanonical(
    request.role,
    request.challenge,
    request.sourceSha256,
    request.requestMaxBytes,
    request.responseMaxBytes,
  );
  return `${JSON.stringify({
    schemaVersion: 1,
    type: "helper-proof-request",
    role: request.role,
    challenge: request.challenge,
    sourceSha256: request.sourceSha256,
    requestMaxBytes: request.requestMaxBytes,
    responseMaxBytes: request.responseMaxBytes,
  })}\n`;
}

export function parseHelperProofRequestLine(line: string): HelperTransportProofRequest {
  const value = parseObject(line, "cua_helper_transport_request_invalid");
  exactKeys(value, [
    "schemaVersion",
    "type",
    "role",
    "challenge",
    "sourceSha256",
    "requestMaxBytes",
    "responseMaxBytes",
  ]);
  if (typeof value.schemaVersion !== "number" || value.schemaVersion !== 1) {
    throw new Error("cua_helper_transport_schema_invalid");
  }
  if (value.type !== "helper-proof-request") {
    throw new Error("cua_helper_transport_type_invalid");
  }
  if (value.role !== "cell" && value.role !== "authority") {
    throw new Error("cua_helper_transport_role_invalid");
  }
  if (typeof value.challenge !== "string" || !HEX64.test(value.challenge)) {
    throw new Error("cua_helper_transport_challenge_invalid");
  }
  if (typeof value.sourceSha256 !== "string") {
    throw new Error("cua_helper_transport_source_invalid");
  }
  if (
    !Number.isSafeInteger(value.requestMaxBytes) ||
    !Number.isSafeInteger(value.responseMaxBytes)
  ) {
    throw new Error("cua_helper_transport_bound_invalid");
  }
  const request: HelperTransportProofRequest = {
    role: value.role,
    challenge: value.challenge,
    sourceSha256: value.sourceSha256,
    requestMaxBytes: value.requestMaxBytes as number,
    responseMaxBytes: value.responseMaxBytes as number,
  };
  transportProofCanonical(
    request.role,
    request.challenge,
    request.sourceSha256,
    request.requestMaxBytes,
    request.responseMaxBytes,
  );
  return request;
}

export function serializeHelperProof(
  role: HelperTransportRole,
  challenge: string,
  proof: string,
): string {
  if ((role !== "cell" && role !== "authority") || !HEX64.test(challenge) || !HEX64.test(proof)) {
    throw new Error("cua_helper_transport_proof_invalid");
  }
  return `${JSON.stringify({
    schemaVersion: 1,
    type: "helper-proof",
    role,
    challenge,
    proof,
  })}\n`;
}

export function parseHelperProofLine(line: string): HelperProofFrame {
  const value = parseObject(line, "cua_helper_transport_proof_invalid");
  exactKeys(value, ["schemaVersion", "type", "role", "challenge", "proof"]);
  if (typeof value.schemaVersion !== "number" || value.schemaVersion !== 1) {
    throw new Error("cua_helper_transport_proof_invalid");
  }
  if (value.type !== "helper-proof") {
    throw new Error("cua_helper_transport_proof_invalid");
  }
  if (value.role !== "cell" && value.role !== "authority") {
    throw new Error("cua_helper_transport_proof_invalid");
  }
  if (typeof value.challenge !== "string" || !HEX64.test(value.challenge)) {
    throw new Error("cua_helper_transport_proof_invalid");
  }
  if (typeof value.proof !== "string" || !HEX64.test(value.proof)) {
    throw new Error("cua_helper_transport_proof_invalid");
  }
  return {
    schemaVersion: 1,
    type: "helper-proof",
    role: value.role,
    challenge: value.challenge,
    proof: value.proof,
  };
}

export function parseHelperProofErrorLine(line: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !keys.includes("schemaVersion") ||
    !keys.includes("type") ||
    !keys.includes("reason") ||
    value.schemaVersion !== 1 ||
    value.type !== "helper-proof-error" ||
    typeof value.reason !== "string" ||
    value.reason.length === 0 ||
    value.reason.length > 256 ||
    hasControlCharacters(value.reason)
  ) {
    return undefined;
  }
  return value.reason;
}

function positiveBound(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_BOUND_BYTES
  );
}

function parseObject(line: string, error: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(error);
  }
  if (!isRecord(value)) throw new Error(error);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !(key in value))) {
    throw new Error("cua_helper_transport_frame_invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
