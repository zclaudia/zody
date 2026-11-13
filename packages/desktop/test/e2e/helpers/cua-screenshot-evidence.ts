/** 返回精确 tool_result 内 PNG 的安全摘要，绝不返回图像字节。 */
export function screenshotEvidence(request: unknown, toolId: string) {
  const results: unknown[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.type === "tool_result" && record.tool_use_id === toolId)
      results.push(record.content);
    else for (const child of Object.values(record)) visit(child);
  };
  visit(request);
  const blocks = results
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .filter((value) => value && typeof value === "object" && value.type === "image");
  if (blocks.length !== 1) return { valid: false, width: 0, height: 0, imageCount: blocks.length };
  const source = blocks[0].source;
  if (
    !source ||
    source.type !== "base64" ||
    source.media_type !== "image/png" ||
    typeof source.data !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source.data)
  )
    return { valid: false, width: 0, height: 0, imageCount: 1 };
  const png = Buffer.from(source.data, "base64");
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    png.length < 24 ||
    !png.subarray(0, 8).equals(signature) ||
    png.readUInt32BE(8) !== 13 ||
    png.toString("ascii", 12, 16) !== "IHDR"
  )
    return { valid: false, width: 0, height: 0, imageCount: 1 };
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20);
  return { valid: width > 0 && height > 0, width, height, imageCount: 1 };
}
