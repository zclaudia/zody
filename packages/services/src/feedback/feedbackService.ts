import type { FeedbackDeviceInfo } from "@zcode/shared";
import { ZCODE_BUILD_TIME, ZCODE_COMMIT, ZCODE_VERSION } from "@zcode/shared";
import { Emitter } from "@zcode/rpc";
import { arch, platform, release, type as osType } from "node:os";

import type { FeedbackUploadProgress, IFeedbackService } from "./feedback.js";
import { cleanupLogArchive, prepareCompactLogArchive } from "./compactLogArchive.js";
import { FeedbackLocalTicketStore } from "#src/feedback/feedbackLocalTicketStore.js";

/**
 * fork（F2.9，决策门 D7）：官方工单提交停用，feedbackHttpClient 不再被装配。
 * 保留的本地能力只有：诊断日志归档（feedbackLogArchive / compactLogArchive）、
 * 本地 ticket store 的历史工单读取，以及进程内设备快照。
 * 工单类方法保留在 IFeedbackService 接口上（未挂载的旧 UI 文件仍编译通过），
 * 实现一律抛出明确的停用错误，保证任何调用路径都不会发出网络请求。
 */
export interface CreateFeedbackServiceOptions {
  createFullLogArchive?: (
    sourceDir: string,
    options?: {
      onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
    },
  ) => Promise<{ path: string; size: number }>;
  revealPath?: (path: string) => Promise<void>;
}

const OFFICIAL_SUBMISSION_DISABLED_MESSAGE =
  "官方工单提交已在 fork 中停用：请通过「导出诊断日志」与反馈地址提交问题。";

function buildDeviceSnapshot(): FeedbackDeviceInfo {
  return {
    appVersion: ZCODE_VERSION,
    buildCommitId: ZCODE_COMMIT,
    buildTime: ZCODE_BUILD_TIME,
    nodeVersion: process.version,
    osType: osType(),
    osPlatform: platform(),
    osRelease: release(),
    // node:os.version() 在 macOS 上是完整 Darwin kernel 字符串，超过后端 os_version VARCHAR(64) 会写库失败。
    osVersion: release(),
    osArch: arch(),
  };
}

export function createFeedbackService(options: CreateFeedbackServiceOptions): IFeedbackService {
  const localTicketStore = new FeedbackLocalTicketStore();
  const uploadProgressEmitters = new Map<string, Emitter<FeedbackUploadProgress>>();

  function getUploadProgressEmitter(id: string): Emitter<FeedbackUploadProgress> {
    const current = uploadProgressEmitters.get(id);
    if (current) return current;
    const emitter = new Emitter<FeedbackUploadProgress>({
      onDidRemoveLastListener: () => {
        uploadProgressEmitters.delete(id);
        emitter.dispose();
      },
    });
    uploadProgressEmitters.set(id, emitter);
    return emitter;
  }

  return {
    create: async () => {
      // 停用官方提交后不允许任何「本地假成功」：用户必须明确知道工单没有被接收。
      throw new Error(OFFICIAL_SUBMISSION_DISABLED_MESSAGE);
    },
    cancelCreate: async () => {
      // 无在途创建请求可取消，保持幂等 no-op。
    },
    list: async (query) => {
      const items = await localTicketStore.list(query);
      return { items, total: items.length };
    },
    get: async () => {
      throw new Error(OFFICIAL_SUBMISSION_DISABLED_MESSAGE);
    },
    comment: async () => {
      throw new Error(OFFICIAL_SUBMISSION_DISABLED_MESSAGE);
    },
    uploadAttachment: async () => {
      throw new Error(OFFICIAL_SUBMISSION_DISABLED_MESSAGE);
    },
    uploadAttachmentWithProgress: async () => {
      throw new Error(OFFICIAL_SUBMISSION_DISABLED_MESSAGE);
    },
    cancelUpload: async () => {
      // 无在途上传可取消，保持幂等 no-op。
    },
    onDynamicUploadProgress: (id) => getUploadProgressEmitter(id).event,
    uploadAttachmentData: async () => {
      throw new Error(OFFICIAL_SUBMISSION_DISABLED_MESSAGE);
    },
    attachLogsFromExport: async () => {
      throw new Error(OFFICIAL_SUBMISSION_DISABLED_MESSAGE);
    },
    getDeviceSnapshot: async () => buildDeviceSnapshot(),
    prepareCompactLogArchive: async (archiveOptions) => {
      const progressId = archiveOptions?.progressId;
      const progressEmitter = progressId ? getUploadProgressEmitter(progressId) : null;
      return prepareCompactLogArchive({
        full: archiveOptions?.full,
        createFullArchive: options.createFullLogArchive,
        onProgress: progressEmitter
          ? (event) => {
              progressEmitter.fire({
                id: progressId!,
                phase: "preparing",
                uploadedBytes: event.processedBytes,
                totalBytes: event.totalBytes,
              });
            }
          : undefined,
      });
    },
    cleanupPreparedLogArchive: (path) => cleanupLogArchive(path),
    revealLogArchive: async (path) => {
      if (options.revealPath) {
        await options.revealPath(path);
        return;
      }
    },
  };
}
