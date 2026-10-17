import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@zcode/shared";

import { createFeedbackService } from "../src/feedback/feedbackService.js";
import { setDataBaseDir } from "../src/paths.js";

// fork（F2.9，决策门 D7）：官方工单提交停用，feedbackHttpClient 不再被装配。
// 本文件锁定新契约：工单类操作一律拒绝且不产生任何网络请求；
// 本地能力（历史工单读取、日志归档、归档展示）保持可用。

function makeNetworkGuard(): { apiClient: ApiClient; fetchMock: ReturnType<typeof vi.fn> } {
  const apiClient: ApiClient = {
    request: vi.fn(async () => {
      throw new Error("feedback service must not issue HTTP requests");
    }),
  };
  const fetchMock = vi.fn(async () => {
    throw new Error("feedback service must not issue global fetch requests");
  });
  vi.stubGlobal("fetch", fetchMock);
  return { apiClient, fetchMock };
}

describe("createFeedbackService（反馈本地化）", () => {
  afterEach(() => {
    setDataBaseDir(null);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("工单创建/查询/补充/附件上传全部拒绝，且不发出任何网络请求", async () => {
    const { apiClient, fetchMock } = makeNetworkGuard();
    const service = createFeedbackService({ apiClient });

    await expect(service.create({ title: "t", description: "d", type: "bug" })).rejects.toThrow(
      /停用/,
    );
    await expect(service.get("ticket-1")).rejects.toThrow(/停用/);
    await expect(service.comment("ticket-1", "补充")).rejects.toThrow(/停用/);
    await expect(
      service.uploadAttachment("ticket-1", "image", { path: "/tmp/a.png" }),
    ).rejects.toThrow(/停用/);
    await expect(
      service.uploadAttachmentWithProgress("ticket-1", "image", { path: "/tmp/a.png" }, "p1"),
    ).rejects.toThrow(/停用/);
    await expect(
      service.uploadAttachmentData("ticket-1", "image", {
        dataBase64: Buffer.from("x").toString("base64"),
        filename: "a.png",
        contentType: "image/png",
      }),
    ).rejects.toThrow(/停用/);
    await expect(service.attachLogsFromExport("ticket-1")).rejects.toThrow(/停用/);

    expect(apiClient.request).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("取消类操作幂等，事件订阅不触发网络", async () => {
    const { apiClient, fetchMock } = makeNetworkGuard();
    const service = createFeedbackService({ apiClient });

    await expect(service.cancelCreate("op-1")).resolves.toBeUndefined();
    await expect(service.cancelUpload("p-1")).resolves.toBeUndefined();
    const unsubscribe = service.onDynamicUploadProgress("p-1")(() => {});
    unsubscribe.dispose();

    expect(apiClient.request).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("list 只读本地历史工单，不发出网络请求", async () => {
    const { apiClient, fetchMock } = makeNetworkGuard();
    const tempDir = await mkdtemp(join(tmpdir(), "feedback-service-local-"));
    setDataBaseDir(tempDir);

    try {
      const service = createFeedbackService({ apiClient });
      const result = await service.list({ mine: true, limit: 50 });

      expect(result).toEqual({ items: [], total: 0 });
      expect(apiClient.request).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("紧凑日志归档走注入的本地归档入口，进度事件经 RPC 事件转发", async () => {
    const { apiClient, fetchMock } = makeNetworkGuard();
    const createFullLogArchive = vi.fn(async (_sourceDir: string) => ({
      path: "/tmp/full-archive.zip",
      size: 1234,
    }));
    const service = createFeedbackService({ apiClient, createFullLogArchive });

    const archive = await service.prepareCompactLogArchive({ full: true });

    expect(archive).toEqual({ path: "/tmp/full-archive.zip", size: 1234 });
    expect(createFullLogArchive).toHaveBeenCalledTimes(1);
    expect(apiClient.request).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("归档清理与展示只走本地回调", async () => {
    const { apiClient, fetchMock } = makeNetworkGuard();
    const revealPath = vi.fn();
    const service = createFeedbackService({ apiClient, revealPath });
    // cleanupPreparedLogArchive 委托 compactLogArchive.cleanupLogArchive（本地 rm）；
    // 对不存在路径 force 清理不应抛错。
    await expect(
      service.cleanupPreparedLogArchive("/tmp/never-existed/archive.zip"),
    ).resolves.toBeUndefined();
    await expect(service.revealLogArchive("/tmp/archive.zip")).resolves.toBeUndefined();

    expect(revealPath).toHaveBeenCalledWith("/tmp/archive.zip");
    expect(apiClient.request).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("设备快照只含本地进程信息，不含 device_mid", async () => {
    const { apiClient, fetchMock } = makeNetworkGuard();
    const service = createFeedbackService({ apiClient });

    const snapshot = await service.getDeviceSnapshot();

    expect(snapshot.appVersion).toEqual(expect.any(String));
    expect(snapshot.osPlatform).toEqual(expect.any(String));
    expect(JSON.stringify(snapshot)).not.toContain("deviceMid");
    expect(apiClient.request).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
