// Bounded Host diagnostic snapshot accepted by the candidate builder. Unknown/raw provider
// or network fields are rejected; only opaque digests and normalized selection are kept.
import { NarrowResourceError } from "../macos-cua-narrow-resources-base.mjs";
import { normalizeNormalHostSelection } from "./normal-host-candidate-provider-profile.mjs";
import { assertSha256, readJsonFile } from "./normal-host-candidate-profile-values.mjs";

// 中文注释：provider digest 的 JSON key 曾以旧 registry revision 概念命名，其前缀撞上
// M2 已退出标识（生产源码零残留断言），已与 Host 事件字段同步更名 providerDigestSha256；
// 解析器是严格 allowlist，旧 key 的历史 snapshot 会被拒绝，需用改名后 Host 日志重新采集。
const STARTUP_SNAPSHOT_KEYS = new Set([
  "kind",
  "reason",
  "providerDigestSha256",
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
    value.providerDigestSha256,
    "startupSnapshot.providerDigestSha256",
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
