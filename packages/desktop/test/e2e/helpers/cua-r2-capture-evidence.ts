import { createHash } from "node:crypto";

/** 仅摘要精确工具调用内的真实 PNG；绝不返回或落盘像素。 */
export function r2PngDigest(request: unknown, toolId: string) {
  const found: unknown[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    if (row.type === "tool_result" && row.tool_use_id === toolId)
      found.push(row.content);
    else Object.values(row).forEach(visit);
  };
  visit(request);
  const images = found
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .filter(
      (value) => value && typeof value === "object" && value.type === "image",
    );
  if (images.length !== 1) return null;
  const source = images[0].source;
  if (
    !source ||
    source.type !== "base64" ||
    source.media_type !== "image/png" ||
    typeof source.data !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      source.data,
    )
  )
    return null;
  const png = Buffer.from(source.data, "base64");
  if (
    png.length < 24 ||
    !png
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    png.readUInt32BE(8) !== 13 ||
    png.toString("ascii", 12, 16) !== "IHDR"
  )
    return null;
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20);
  if (!width || !height) return null;
  return {
    width,
    height,
    bytes: png.length,
    sha256: createHash("sha256").update(png).digest("hex"),
  };
}

/** 仅接收生产日志提升后的固定字段，不返回其它日志正文。 */
export function r2CaptureAuditFromLog(log: string) {
  const marker = "CUA native audit [cua-native] capture-delivered ";
  return log.split("\n").flatMap((line) => {
    const at = line.indexOf(marker);
    if (at < 0) return [];
    try {
      const value = JSON.parse(line.slice(at + marker.length)) as Record<
        string,
        unknown
      >;
      const keys = Object.keys(value).sort().join(",");
      const borrowed =
        keys ===
          "bytes,height,machineLeaseBorrowReturned,machineLeaseReleased,resourcesReleased,sha256,width" &&
        value.machineLeaseReleased === false &&
        value.machineLeaseBorrowReturned === true;
      const released =
        keys ===
          "bytes,height,machineLeaseReleased,resourcesReleased,sha256,width" &&
        value.machineLeaseReleased === true;
      if (
        (!borrowed && !released) ||
        value.resourcesReleased !== true ||
        typeof value.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.sha256) ||
        !Number.isSafeInteger(value.width) ||
        (value.width as number) < 1 ||
        !Number.isSafeInteger(value.height) ||
        (value.height as number) < 1 ||
        !Number.isSafeInteger(value.bytes) ||
        (value.bytes as number) < 24
      )
        return [];
      return [
        {
          sha256: value.sha256,
          width: value.width as number,
          height: value.height as number,
          bytes: value.bytes as number,
          machineLeaseReleased: !borrowed,
          ...(borrowed ? { machineLeaseBorrowReturned: true } : {}),
          resourcesReleased: true,
        },
      ];
    } catch {
      return [];
    }
  });
}

/** 只保留固定拒绝分类，供 TCC 或链路失败时诊断，不保存 stderr 正文。 */
export function r2CaptureRejectionsFromLog(log: string) {
  const marker = "CUA native audit [cua-native] capture-rejected ";
  const allowed = new Set([
    "tcc-not-authorized",
    "screen_locked",
    "machine-lease-unavailable",
    "capture-canceled",
    "capture-result-not-accepted",
    "capture-result-transport-failed",
    "visual-start-denied",
    "capture-file-verify-failed",
    "final-owner-check-failed",
    "post-confirm-check-failed",
    "confirmation-denied",
    "confirmation-canceled",
    "authority-failed",
    "capture-failed",
  ]);
  return log.split("\n").flatMap((line) => {
    const at = line.indexOf(marker);
    if (at < 0) return [];
    try {
      const value = JSON.parse(line.slice(at + marker.length)) as Record<
        string,
        unknown
      >;
      return Object.keys(value).join(",") === "reason" &&
        typeof value.reason === "string" &&
        allowed.has(value.reason)
        ? [{ reason: value.reason }]
        : [];
    } catch {
      return [];
    }
  });
}
