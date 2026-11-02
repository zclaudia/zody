import { createHash } from "node:crypto";

/**
 * Fixed storage resources supplied by the signed Native Host wrapper.
 *
 * The native builder embeds the worker source into host-entry.mjs, so the Host never
 * re-opens a resource path after verification. The native launcher owns packaging and
 * signature verification; this module only proves that the bytes registered here match
 * the pinned SHA-256 before a Worker is created.
 */
export interface HostStorageResourceSnapshot {
  readonly sha256: string;
  readonly source: string;
}

export interface HostStorageResources {
  /** Sealed ESM Worker equivalent to host/tasksStorageWorker.js. */
  readonly tasksStorageWorker: HostStorageResourceSnapshot;
  /** Sealed ESM entry that runs the original bootstrap prepareStorageOnly path. */
  readonly sessionStorageEntry: HostStorageResourceSnapshot;
}

export interface VerifiedHostStorageResource {
  readonly sha256: string;
  readonly workerUrl: URL;
}

export interface VerifiedHostStorageResources {
  readonly tasksStorageWorker: VerifiedHostStorageResource;
  readonly sessionStorageEntry: VerifiedHostStorageResource;
}

const MAX_STORAGE_SOURCE_BYTES = 64 * 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

function verifySnapshot(
  snapshot: HostStorageResourceSnapshot | undefined,
  field: string,
): VerifiedHostStorageResource {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error(`Node Host storage ${field} must be an embedded snapshot`);
  }
  if (typeof snapshot.source !== "string" || snapshot.source.length === 0) {
    throw new Error(`Node Host storage ${field}.source must be a non-empty string`);
  }
  if (typeof snapshot.sha256 !== "string" || !SHA256_HEX.test(snapshot.sha256)) {
    throw new Error(`Node Host storage ${field}.sha256 must be a lowercase SHA-256`);
  }
  const bytes = Buffer.from(snapshot.source, "utf8");
  if (bytes.byteLength > MAX_STORAGE_SOURCE_BYTES) {
    throw new Error(`Node Host storage ${field}.source exceeds ${MAX_STORAGE_SOURCE_BYTES} bytes`);
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== snapshot.sha256) {
    throw new Error(`Node Host storage ${field} digest mismatch`);
  }
  return Object.freeze({
    sha256: snapshot.sha256,
    // Worker parses ESM imports relative to the data: URL, so the embedded bundle must
    // stay self-contained. Native's ESM_BANNER bases createRequire on process.execPath.
    workerUrl: new URL(`data:text/javascript;base64,${bytes.toString("base64")}`),
  });
}

export function validateHostStorageResources(
  resources: HostStorageResources,
): VerifiedHostStorageResources {
  if (!resources || typeof resources !== "object") {
    throw new Error("Node Host storage resources must be an explicit object");
  }
  return Object.freeze({
    tasksStorageWorker: verifySnapshot(resources.tasksStorageWorker, "tasksStorageWorker"),
    sessionStorageEntry: verifySnapshot(resources.sessionStorageEntry, "sessionStorageEntry"),
  });
}
