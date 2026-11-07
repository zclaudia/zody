import { describe, expect, it, vi } from "vitest";
import {
  MAX_FILE_COPY_BYTES,
  fileSaveSuccessMessageId,
  readFileCopy,
  saveFileCopy,
} from "../src/file-menu/fileCopy.js";
import type { FileCopySource } from "../src/file-menu/contract.js";

// F16 另存为（upstream v3.17.1 file-menu/fileCopy，来源 SHA a60ba6a7）：
// ≤50 MiB 分块读取防截断；规则见 docs/ui/file-open-apps.md「另存为」章节。
function chunkedSource(bytes: Uint8Array, options?: { rangeCap?: number; mtimeMs?: number }) {
  const rangeCap = options?.rangeCap ?? 64 * 1024;
  const mtimeMs = options?.mtimeMs ?? 1000;
  const stat = vi.fn(async () => ({
    type: "file" as const,
    size: bytes.byteLength,
    mtimeMs,
  }));
  const readFileRange = vi.fn(async ({ offset, length }: { offset: number; length: number }) => {
    // 模拟 Host 单次 range 上限：一次读完整文件会被截断，这正是分块存在的原因。
    const capped = Math.min(length, rangeCap);
    return bytes.subarray(offset, offset + capped);
  });
  const source: FileCopySource = { stat, readFileRange };
  return { source, stat, readFileRange };
}

describe("readFileCopy 分块读取防截断", () => {
  it("源限制单次读取长度时仍读出完整字节（单次全量读取会被截断）", async () => {
    const payload = new Uint8Array(256 * 1024 + 7);
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
    const { source, readFileRange } = chunkedSource(payload);
    const data = await readFileCopy(source, "/workspace/大 文件.bin");
    expect(new Uint8Array(data)).toEqual(payload);
    expect(readFileRange.mock.calls.length).toBeGreaterThan(1);
  });

  it("超过 50 MiB 直接拒绝，不发起任何读取", async () => {
    const { source, stat, readFileRange } = chunkedSource(new Uint8Array(0));
    stat.mockResolvedValue({ type: "file", size: MAX_FILE_COPY_BYTES + 1, mtimeMs: 1 });
    await expect(readFileCopy(source, "/workspace/huge.iso")).rejects.toThrow("file_too_large");
    expect(readFileRange).not.toHaveBeenCalled();
  });

  it("读取前后 stat 不一致按 file_changed 失败", async () => {
    const payload = new Uint8Array(1024);
    const { source, stat } = chunkedSource(payload);
    // 读取前 size=1024；读取完成后文件被外部改写为 2048。
    stat.mockResolvedValueOnce({ type: "file", size: 1024, mtimeMs: 1000 });
    stat.mockResolvedValueOnce({ type: "file", size: 2048, mtimeMs: 1000 });
    await expect(readFileCopy(source, "/workspace/a.md")).rejects.toThrow("file_changed");
  });

  it("chunk 为空按 file_changed 失败，不把残缺字节交给保存对话框", async () => {
    const { source } = chunkedSource(new Uint8Array(1024));
    // F16③ 反例（SHA a60ba6a7）：Host 在读尽前返回空 chunk 视为并发改写，
    // 防止把部分字节当完整副本落盘（fileCopy「空或超长」守卫）。
    source.readFileRange.mockResolvedValue(new Uint8Array(0));
    await expect(readFileCopy(source, "/workspace/a.md")).rejects.toThrow("file_changed");
  });

  it("chunk 超出请求长度按 file_changed 失败", async () => {
    const { source } = chunkedSource(new Uint8Array(1024));
    // 请求 1 MiB 中的 1024 字节，Host 却返回 1025 字节：读端与 stat 已不一致。
    source.readFileRange.mockImplementation(async ({ offset }: { offset: number }) =>
      new Uint8Array(1025).fill(1).subarray(offset, offset + 1025),
    );
    await expect(readFileCopy(source, "/workspace/a.md")).rejects.toThrow("file_changed");
  });

  it("目录与无尺寸信息失败关闭", async () => {
    const { source, stat } = chunkedSource(new Uint8Array(0));
    stat.mockResolvedValue({ type: "directory", size: 0, mtimeMs: 1 });
    await expect(readFileCopy(source, "/workspace")).rejects.toThrow("not_a_file");
    stat.mockResolvedValue({ type: "file", size: undefined, mtimeMs: 1 } as never);
    await expect(readFileCopy(source, "/workspace/x")).rejects.toThrow("file_size_unavailable");
  });
});

describe("saveFileCopy 顺序与结果语义", () => {
  it("先完整读取再调用保存端口，建议名取路径叶节点", async () => {
    const payload = new TextEncoder().encode("F16 save");
    const { source } = chunkedSource(payload);
    const save = vi.fn(async () => ({ success: true as const, path: "/tmp/out.bin" }));
    const result = await saveFileCopy(source, "/workspace/报告 v2.bin", save as never);
    expect(result.success).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toEqual({ data: payload.buffer, suggestedName: "报告 v2.bin" });
  });

  it("取消是正常结果不抛错；失败按错误抛出", async () => {
    const { source } = chunkedSource(new Uint8Array(4));
    const canceled = vi.fn(async () => ({ success: false as const, canceled: true }));
    await expect(saveFileCopy(source, "/workspace/a", canceled as never)).resolves.toEqual({
      success: false,
      canceled: true,
    });
    const failed = vi.fn(async () => ({ success: false as const, error: "disk_full" }));
    await expect(saveFileCopy(source, "/workspace/a", failed as never)).rejects.toThrow(
      "disk_full",
    );
  });

  it("成功提示统一为已保存；取消不提示", () => {
    expect(fileSaveSuccessMessageId({ success: true, path: "/o" })).toBe("fileActions.saved");
    expect(fileSaveSuccessMessageId({ success: false, canceled: true })).toBeNull();
  });
});
