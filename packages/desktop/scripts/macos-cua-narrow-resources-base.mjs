// 窄 CUA 资源装配的公共错误与摘要工具。
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export class NarrowResourceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "NarrowResourceError";
    this.code = code;
    this.details = details;
  }
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha1Bytes(bytes) {
  return createHash("sha1").update(bytes).digest("hex");
}

export function sha256Text(text) {
  return sha256Bytes(Buffer.from(text, "utf8"));
}

export async function sha256File(path) {
  return sha256Bytes(await readFile(path));
}
