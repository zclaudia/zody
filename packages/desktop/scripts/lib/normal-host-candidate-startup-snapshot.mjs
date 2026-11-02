// Bounded Host diagnostic snapshot accepted by the candidate builder. Unknown/raw provider
// or network fields are rejected; only opaque digests and normalized selection are kept.
import { NarrowResourceError } from "../macos-cua-narrow-resources-base.mjs";
import { normalizeNormalHostSelection } from "./normal-host-candidate-provider-profile.mjs";
import { assertSha256, readJsonFile } from "./normal-host-candidate-profile-values.mjs";

const STARTUP_SNAPSHOT_KEYS = new Set([
  "kind",
  "reason",
  "providerRevisionSha256",
  "selection",
  "networkDigestSha256",
  "snapshotSource",
  "taskTimeProviderGuard",
]);

export function parseNormalHostStartupSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NarrowResourceError(
      "startupSnapshot-shape",
      "startup snapshot must be a JSON object",
    );
  }
  for (const key of Object.keys(value)) {
    if (!STARTUP_SNAPSHOT_KEYS.has(key)) {
      throw new NarrowResourceError(
        "startupSnapshot-unsupported-field",
        `startup snapshot contains unsupported field: ${key}`,
      );
    }
  }
  if (value.kind !== undefined && value.kind !== "narrow-runtime-startup-snapshot") {
    throw new NarrowResourceError("startupSnapshot-kind", "startup snapshot kind mismatch");
  }
  const revisionSha256 = assertSha256(
    value.providerRevisionSha256,
    "startupSnapshot.providerRevisionSha256",
  );
  const selection = normalizeNormalHostSelection(value.selection);
  if (!selection) {
    throw new NarrowResourceError(
      "startupSnapshot-selection",
      "startupSnapshot.selection must contain providerId/modelId",
    );
  }
  return {
    revisionSha256,
    selection,
    networkDigestSha256: assertSha256(
      value.networkDigestSha256,
      "startupSnapshot.networkDigestSha256",
    ),
  };
}

export async function readStartupSnapshot(startupSnapshotPath) {
  return parseNormalHostStartupSnapshot(await readJsonFile(startupSnapshotPath, "startupSnapshot"));
}
