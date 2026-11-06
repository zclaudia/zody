import { describe, expect, it, vi } from "vitest";
import type { IFileService } from "@zody/services";
import type { IPlatformService } from "@zody/shared";
import {
  MOBILE_FILE_SAVE_MAX_BYTES,
  MOBILE_FILE_SAVE_RANGE_BYTES,
  createMobileSaveAbortError,
  isMobileSaveAbortError,
  readMobileFileForSave,
  saveMobileOriginalFile,
} from "../src/mobileFileBrowserSave.js";

function createFileService(
  size: number,
  options: { changeOnRead?: boolean; shortRead?: boolean; noMtime?: boolean } = {},
) {
  let statCalls = 0;
  return {
    stat: vi.fn(async () => {
      statCalls += 1;
      return {
        path: "/workspace/source.bin",
        type: "file" as const,
        size: options.changeOnRead && statCalls > 1 ? size + 1 : size,
        ...(options.noMtime ? {} : { mtimeMs: options.changeOnRead && statCalls > 1 ? 2 : 1 }),
      };
    }),
    readFileRange: vi.fn(async ({ offset, length }: { offset: number; length: number }) =>
      new Uint8Array(options.shortRead ? Math.max(0, length - 1) : length).fill(offset % 255),
    ),
  } as unknown as IFileService;
}

function createPlatform() {
  return {
    saveFile: vi.fn(async () => ({ success: true as const })),
  } as unknown as Pick<IPlatformService, "saveFile">;
}

describe("mobile original file save", () => {
  it("reads bounded ranges and saves the exact file bytes", async () => {
    const fileService = createFileService(MOBILE_FILE_SAVE_RANGE_BYTES + 8);
    const saveFile = vi.fn(async () => ({ success: true }));
    const result = await saveMobileOriginalFile({
      fileService,
      platform: { saveFile } as unknown as Pick<IPlatformService, "saveFile">,
      path: "/workspace/source.bin",
      suggestedName: "source.bin",
    });

    expect(result.success).toBe(true);
    expect(fileService.readFileRange).toHaveBeenCalledTimes(2);
    expect(fileService.readFileRange).toHaveBeenNthCalledWith(1, {
      path: "/workspace/source.bin",
      offset: 0,
      length: MOBILE_FILE_SAVE_RANGE_BYTES,
    });
    expect(saveFile).toHaveBeenCalledOnce();
    const savedPayload = saveFile.mock.calls[0]?.[0] as { data: ArrayBuffer } | undefined;
    expect(savedPayload?.data.byteLength).toBe(MOBILE_FILE_SAVE_RANGE_BYTES + 8);
  });

  it("rejects oversized or changing files before saving", async () => {
    const oversized = createFileService(MOBILE_FILE_SAVE_MAX_BYTES + 1);
    await expect(readMobileFileForSave(oversized, "/workspace/source.bin")).rejects.toThrow(
      "16 MiB",
    );
    expect(oversized.readFileRange).not.toHaveBeenCalled();

    const changed = createFileService(10, { changeOnRead: true });
    await expect(readMobileFileForSave(changed, "/workspace/source.bin")).rejects.toThrow(
      "changed",
    );

    const shortRead = createFileService(10, { shortRead: true });
    await expect(readMobileFileForSave(shortRead, "/workspace/source.bin")).rejects.toThrow(
      "changed",
    );

    const noMtime = createFileService(10, { noMtime: true });
    await expect(readMobileFileForSave(noMtime, "/workspace/source.bin")).rejects.toThrow(
      "modification time",
    );
    expect(noMtime.readFileRange).not.toHaveBeenCalled();
  });

  it("does not call a missing native save capability", async () => {
    const fileService = createFileService(0);
    await expect(
      saveMobileOriginalFile({
        fileService,
        platform: {},
        path: "/workspace/source.bin",
        suggestedName: "source.bin",
      }),
    ).rejects.toThrow("unavailable");
    expect(fileService.stat).not.toHaveBeenCalled();
  });

  it("MF08: 取消后不再读后续 chunk，也不发起原生保存", async () => {
    const controller = new AbortController();
    const pendingChunks: Array<(bytes: Uint8Array) => void> = [];
    const fileService = {
      stat: vi.fn(async () => ({
        path: "/workspace/source.bin",
        type: "file" as const,
        size: MOBILE_FILE_SAVE_RANGE_BYTES + 5,
        mtimeMs: 1,
      })),
      readFileRange: vi.fn(
        ({ length }: { offset: number; length: number }) =>
          new Promise<Uint8Array>((resolve) => {
            pendingChunks.push(() => resolve(new Uint8Array(length)));
          }),
      ),
    } as unknown as IFileService;
    const platform = createPlatform();

    const pending = saveMobileOriginalFile({
      fileService,
      platform,
      path: "/workspace/source.bin",
      suggestedName: "source.bin",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fileService.readFileRange).toHaveBeenCalledTimes(1));
    controller.abort();
    pendingChunks[0]!(new Uint8Array(MOBILE_FILE_SAVE_RANGE_BYTES));

    await expect(pending).resolves.toEqual({ success: false, canceled: true });
    // 第二个 chunk 不应再被请求；保存通道保持未触碰，原生侧不会建立下载会话。
    expect(fileService.readFileRange).toHaveBeenCalledTimes(1);
    expect(platform.saveFile).not.toHaveBeenCalled();
  });

  it("MF08: 全部分块读完但保存前取消，仍按取消收尾", async () => {
    const controller = new AbortController();
    let statCalls = 0;
    let resolveSecondStat!: (value: {
      path: string;
      type: "file";
      size: number;
      mtimeMs: number;
    }) => void;
    const fileService = {
      stat: vi.fn(async () => {
        statCalls += 1;
        if (statCalls === 1) {
          return { path: "/workspace/source.bin", type: "file" as const, size: 8, mtimeMs: 1 };
        }
        // 读取完成后的复核 stat 挂起，制造“读完但尚未保存”的取消窗口。
        return new Promise((resolve) => {
          resolveSecondStat = resolve;
        });
      }),
      readFileRange: vi.fn(
        async ({ length }: { offset: number; length: number }) => new Uint8Array(length),
      ),
    } as unknown as IFileService;
    const platform = createPlatform();

    const pending = saveMobileOriginalFile({
      fileService,
      platform,
      path: "/workspace/source.bin",
      suggestedName: "source.bin",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(statCalls).toBe(2));
    controller.abort();
    resolveSecondStat({ path: "/workspace/source.bin", type: "file", size: 8, mtimeMs: 1 });

    await expect(pending).resolves.toEqual({ success: false, canceled: true });
    expect(platform.saveFile).not.toHaveBeenCalled();
  });

  it("MF08: 保存失败不污染状态，可立即重新发起", async () => {
    const fileService = createFileService(8);
    const saveFile = vi.fn();
    saveFile.mockResolvedValueOnce({ success: false, error: "disk full" });
    saveFile.mockResolvedValueOnce({ success: true });
    const platform = { saveFile } as unknown as Pick<IPlatformService, "saveFile">;

    const first = await saveMobileOriginalFile({
      fileService,
      platform,
      path: "/workspace/source.bin",
      suggestedName: "source.bin",
    });
    const second = await saveMobileOriginalFile({
      fileService,
      platform,
      path: "/workspace/source.bin",
      suggestedName: "source.bin",
    });

    expect(first).toEqual({ success: false, error: "disk full" });
    expect(second).toEqual({ success: true });
    expect(saveFile).toHaveBeenCalledTimes(2);
  });

  it("searchfile-9: 原生写入进行中收到取消，立即按取消收尾，不等写入结果", async () => {
    const controller = new AbortController();
    let resolveWrite!: (result: { success: boolean }) => void;
    const saveFile = vi.fn(
      () =>
        new Promise<{ success: boolean }>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const fileService = createFileService(8);

    const pending = saveMobileOriginalFile({
      fileService,
      platform: { saveFile } as unknown as Pick<IPlatformService, "saveFile">,
      path: "/workspace/source.bin",
      suggestedName: "source.bin",
      signal: controller.signal,
    });
    // 读取完成、进入原生写入阶段后取消。
    await vi.waitFor(() => expect(saveFile).toHaveBeenCalledOnce());
    controller.abort();

    await expect(pending).resolves.toEqual({ success: false, canceled: true });
    // 迟到的写入结果不再改变取消结论：pending 已按取消收敛。
    resolveWrite({ success: true });
    expect(saveFile).toHaveBeenCalledOnce();
  });

  it("searchfile-9: 写入阶段未取消时返回真实写入结果；取消后发起的写入不触达平台", async () => {
    const fileService = createFileService(8);
    const saveFile = vi.fn(async () => ({ success: true }));
    const first = await saveMobileOriginalFile({
      fileService,
      platform: { saveFile } as unknown as Pick<IPlatformService, "saveFile">,
      path: "/workspace/source.bin",
      suggestedName: "source.bin",
    });
    expect(first).toEqual({ success: true });

    // 发起写入前已取消：不调用 platform.saveFile（既有发起前检查仍然有效）。
    const controller = new AbortController();
    controller.abort();
    const saveFileAfterAbort = vi.fn(async () => ({ success: true }));
    const second = await saveMobileOriginalFile({
      fileService,
      platform: { saveFile: saveFileAfterAbort } as unknown as Pick<IPlatformService, "saveFile">,
      path: "/workspace/source.bin",
      suggestedName: "source.bin",
      signal: controller.signal,
    });
    expect(second).toEqual({ success: false, canceled: true });
    expect(saveFileAfterAbort).not.toHaveBeenCalled();
  });

  it("uses the AbortError shape so cancel results are distinguishable from failures", () => {
    const abortError = createMobileSaveAbortError();
    expect(isMobileSaveAbortError(abortError)).toBe(true);
    expect(isMobileSaveAbortError(new Error("disk full"))).toBe(false);
    expect(isMobileSaveAbortError(undefined)).toBe(false);
  });
});
