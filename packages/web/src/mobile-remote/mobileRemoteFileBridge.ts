import {
  MOBILE_UI_REMOTE_BRIDGE_GLOBAL_KEY,
  type IPlatformService,
  type SaveFileRequest,
  type SaveFileResult,
} from "@zcode/shared";
import {
  parseMobileRemoteBridgeEnvelope,
  requireMobileRemoteBridgeObject,
  requireMobileRemoteBridgeString,
} from "./mobileRemoteBridgeEnvelope.js";

/**
 * 手机页面的文件保存能力（T6.3）。
 *
 * Android 壳的 `ZodyRemoteBridge` 只有平铺的 `@JavascriptInterface` 方法：
 * `saveFileBegin/Append/Finish/Abort` 与 `openFile`，且每个方法都携带当前 sessionId。
 * 原生按 MobileShellController 的当前 session 校验，旧 session 一律拒绝；页面只负责透传，
 * 失败后不写回任何配置。页面在这里把 `IPlatformService.saveFile`
 * 适配成「按 base64 分块传给原生」：
 *
 * 1. 先把 `data` 或 `sourceUrl` 读成字节；
 * 2. 每 256 KiB 编码成 base64 调用一次 `saveFileAppend`，避免单次 JS ↔ 原生调用过大；
 * 3. `saveFileBegin` 返回 `{ token }`，`saveFileFinish` 返回 `{ file: { uri, displayPath } }`，
 *    再调用 `openFile`（返回 `{ opened }`）打开。
 *
 * 所有方法都返回 M2-T5 的 JSON envelope；页面只按 `error.code` 分支，损坏响应按失败处理。
 *
 * 附件选择不经过这里：WebView 的 `onShowFileChooser` 直接把系统选择器/拍照结果交给
 * `<input type="file">`，composer 继续走现有按字节上传的远端附件链路。`selectFiles` 的契约
 * 是「返回宿主绝对路径」，在手机上返回私有路径对桌面 Agent 没有意义，因此不覆盖。
 */

/** 单条逻辑消息 16 MiB 是远端附件链路的硬上限（web-remote-control-rpc-transport）。 */
export const MOBILE_REMOTE_MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;

/** 每次桥调用的原始字节数；base64 后约 341 KiB，远低于原生 1 MiB 保护上限。 */
export const MOBILE_REMOTE_SAVE_CHUNK_BYTES = 256 * 1024;

export interface MobileRemoteFileNativeBridge {
  saveFileBegin(sessionId: string, fileName: string, mimeType: string): string;
  saveFileAppend(sessionId: string, token: string, chunkBase64: string): string;
  saveFileFinish(sessionId: string, token: string): string;
  saveFileAbort(sessionId: string, token: string): string;
  openFile?(sessionId: string, uri: string, mimeType: string): string;
}

interface SavedNativeFile {
  uri: string;
  displayPath: string;
}

/** 发现宿主注入的文件桥；缺少任一保存方法时不提供 saveFile 能力。 */
export function resolveMobileRemoteFileBridge(
  target: unknown = globalThis,
): MobileRemoteFileNativeBridge | undefined {
  if (!target || typeof target !== "object") {
    return undefined;
  }
  const candidate = (target as Record<string, unknown>)[MOBILE_UI_REMOTE_BRIDGE_GLOBAL_KEY];
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }
  const bridge = candidate as Partial<MobileRemoteFileNativeBridge>;
  if (
    typeof bridge.saveFileBegin !== "function" ||
    typeof bridge.saveFileAppend !== "function" ||
    typeof bridge.saveFileFinish !== "function" ||
    typeof bridge.saveFileAbort !== "function"
  ) {
    return undefined;
  }
  return {
    saveFileBegin: bridge.saveFileBegin.bind(candidate),
    saveFileAppend: bridge.saveFileAppend.bind(candidate),
    saveFileFinish: bridge.saveFileFinish.bind(candidate),
    saveFileAbort: bridge.saveFileAbort.bind(candidate),
    ...(typeof bridge.openFile === "function" ? { openFile: bridge.openFile.bind(candidate) } : {}),
  };
}

const MIME_BY_EXTENSION: Record<string, string> = {
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  zip: "application/zip",
  gz: "application/gzip",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

function inferMimeType(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function normalizeMimeType(value: string | null | undefined): string | undefined {
  const normalized = value?.split(";", 1)[0]?.trim();
  return normalized ? normalized : undefined;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  // 分块转字符串，避免 apply 参数超过引擎上限。
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function readSavePayload(
  payload: SaveFileRequest,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (payload.data) {
    return {
      bytes: new Uint8Array(payload.data),
      mimeType: inferMimeType(payload.suggestedName),
    };
  }
  const response = await fetch(payload.sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to download the file (HTTP ${response.status}).`);
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mimeType:
      normalizeMimeType(response.headers.get("content-type")) ??
      inferMimeType(payload.suggestedName),
  };
}

function parseSavedFile(value: string): SavedNativeFile {
  const envelope = parseMobileRemoteBridgeEnvelope(value);
  const file = requireMobileRemoteBridgeObject(envelope, "file");
  if (typeof file.uri !== "string" || typeof file.displayPath !== "string") {
    throw new Error("The native file bridge returned an invalid save result.");
  }
  return { uri: file.uri, displayPath: file.displayPath };
}

/** 把一次 saveFile 请求分块写入原生下载目录，并在成功后尝试用系统应用打开。 */
export async function saveMobileRemoteFile(
  bridge: MobileRemoteFileNativeBridge,
  sessionId: string,
  payload: SaveFileRequest,
): Promise<SaveFileResult> {
  let token: string | undefined;
  try {
    const { bytes, mimeType } = await readSavePayload(payload);
    token = requireMobileRemoteBridgeString(
      parseMobileRemoteBridgeEnvelope(
        bridge.saveFileBegin(sessionId, payload.suggestedName, mimeType),
      ),
      "token",
    );
    for (let offset = 0; offset < bytes.length; offset += MOBILE_REMOTE_SAVE_CHUNK_BYTES) {
      const chunk = bytes.subarray(
        offset,
        Math.min(offset + MOBILE_REMOTE_SAVE_CHUNK_BYTES, bytes.length),
      );
      parseMobileRemoteBridgeEnvelope(
        bridge.saveFileAppend(sessionId, token, encodeBase64(chunk)),
      );
    }
    const saved = parseSavedFile(bridge.saveFileFinish(sessionId, token));
    token = undefined;
    if (bridge.openFile) {
      try {
        parseMobileRemoteBridgeEnvelope(
          bridge.openFile(sessionId, saved.uri, mimeType),
        );
      } catch {
        // Bugfix: 保存已经成功，系统没有可打开该类型的应用时不能把保存结果改成失败。
      }
    }
    return { success: true, path: saved.displayPath };
  } catch (error) {
    if (token) {
      try {
        parseMobileRemoteBridgeEnvelope(bridge.saveFileAbort(sessionId, token));
      } catch {
        // 原生会话可能已经结束；保留原始错误。
      }
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface CreateMobileRemoteFileCapabilitiesOptions {
  /** MobileShellController 为当前 Remote 文档创建的 sessionId。 */
  sessionId: string;
  maxAttachmentBytes?: number;
}

export function createMobileRemoteFileCapabilities(
  bridge: MobileRemoteFileNativeBridge | undefined,
  options: CreateMobileRemoteFileCapabilitiesOptions,
): Pick<IPlatformService, "saveFile" | "maxAttachmentBytes"> {
  return {
    // 即使开发模式没有原生桥，手机页面仍受远端 16 MiB 上限约束，composer 需要提前提示。
    maxAttachmentBytes: options.maxAttachmentBytes ?? MOBILE_REMOTE_MAX_ATTACHMENT_BYTES,
    ...(bridge
      ? {
          saveFile: (payload) =>
            saveMobileRemoteFile(bridge, options.sessionId, payload),
        }
      : {}),
  };
}
