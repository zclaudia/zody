import { afterEach, describe, expect, it, vi } from "vitest";
import { MOBILE_UI_REMOTE_BRIDGE_GLOBAL_KEY } from "@zcode/shared";
import {
  MOBILE_REMOTE_MAX_ATTACHMENT_BYTES,
  MOBILE_REMOTE_SAVE_CHUNK_BYTES,
  beginMobileRemoteFileOperation,
  createMobileRemoteFileCapabilities,
  hasActiveMobileRemoteFileOperation,
  resolveMobileRemoteFileBridge,
  saveMobileRemoteFile,
  type MobileRemoteFileNativeBridge,
} from "../src/mobile-remote/mobileRemoteFileBridge.js";

function success(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: 1, ok: true, ...extra });
}

function failure(code: string, message?: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    ok: false,
    error: { code, ...(message ? { message } : {}) },
  });
}

function createFakeBridge() {
  const chunks: string[] = [];
  const bridge: MobileRemoteFileNativeBridge & {
    begin: ReturnType<typeof vi.fn>;
    append: ReturnType<typeof vi.fn>;
    finish: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
  } = {
    begin: vi.fn(
      (_sessionId: string, _fileName: string, _mimeType: string) =>
        success({ token: "save-token" }),
    ),
    append: vi.fn((_sessionId: string, _token: string, chunk: string) => {
      chunks.push(chunk);
    }),
    finish: vi.fn((_sessionId: string, _token: string) =>
      success({
        file: {
          uri: "content://media/external/downloads/42",
          displayPath: "Download/report.pdf",
        },
      }),
    ),
    abort: vi.fn((_sessionId: string, _token: string) => success()),
    open: vi.fn((_sessionId: string, _uri: string, _mimeType: string) =>
      success({ opened: true }),
    ),
    saveFileBegin(sessionId, fileName, mimeType) {
      return bridge.begin(sessionId, fileName, mimeType) as string;
    },
    saveFileAppend(sessionId, token, chunk) {
      bridge.append(sessionId, token, chunk);
      return success();
    },
    saveFileFinish(sessionId, token) {
      return bridge.finish(sessionId, token) as string;
    },
    saveFileAbort(sessionId, token) {
      return bridge.abort(sessionId, token) as string;
    },
    openFile(sessionId, uri, mimeType) {
      return bridge.open(sessionId, uri, mimeType) as string;
    },
  };
  return { bridge, chunks };
}

function decodeChunks(chunks: string[]): Uint8Array {
  const parts = chunks.map((chunk) => Buffer.from(chunk, "base64"));
  return new Uint8Array(Buffer.concat(parts));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mobile remote file operation guard (M3-T2)", () => {
  it("counts nested operations and releases idempotently", () => {
    expect(hasActiveMobileRemoteFileOperation()).toBe(false);
    const first = beginMobileRemoteFileOperation();
    const second = beginMobileRemoteFileOperation();
    expect(hasActiveMobileRemoteFileOperation()).toBe(true);
    first();
    first();
    expect(hasActiveMobileRemoteFileOperation()).toBe(true);
    second();
    expect(hasActiveMobileRemoteFileOperation()).toBe(false);
  });

  it("releases the tracker after successful and failed saves", async () => {
    const { bridge } = createFakeBridge();
    const pending = saveMobileRemoteFile(bridge, "session-1", {
      data: new Uint8Array([1, 2, 3]).buffer,
      suggestedName: "report.txt",
    });
    expect(hasActiveMobileRemoteFileOperation()).toBe(true);
    await expect(pending).resolves.toEqual({ success: true, path: "Download/report.pdf" });
    expect(hasActiveMobileRemoteFileOperation()).toBe(false);

    const failing = createFakeBridge();
    failing.bridge.finish.mockReturnValueOnce(failure("native-busy"));
    await expect(
      saveMobileRemoteFile(failing.bridge, "session-1", {
        data: new Uint8Array([1]).buffer,
        suggestedName: "report.txt",
      }),
    ).resolves.toMatchObject({ success: false });
    expect(hasActiveMobileRemoteFileOperation()).toBe(false);
    expect(failing.bridge.abort).toHaveBeenCalledOnce();
  });
});

describe("mobile remote file bridge (T6.3)", () => {
  it("resolves only complete native file bridges", () => {
    expect(resolveMobileRemoteFileBridge({})).toBeUndefined();
    expect(
      resolveMobileRemoteFileBridge({
        [MOBILE_UI_REMOTE_BRIDGE_GLOBAL_KEY]: {
          saveFileBegin: () => "token",
          saveFileAppend: () => {},
          saveFileFinish: () => "{}",
          // 缺少 saveFileAbort：release 构建不应暴露半套能力。
        },
      }),
    ).toBeUndefined();

    const resolved = resolveMobileRemoteFileBridge({
      [MOBILE_UI_REMOTE_BRIDGE_GLOBAL_KEY]: {
        saveFileBegin: () => "token",
        saveFileAppend: () => {},
        saveFileFinish: () => "{}",
        saveFileAbort: () => {},
        openFile: () => true,
      },
    });
    expect(resolved?.saveFileBegin("session-1", "a.txt", "text/plain")).toBe("token");
  });

  it("chunks data payloads into base64 bridge calls and opens the saved file", async () => {
    const { bridge, chunks } = createFakeBridge();
    const bytes = new Uint8Array(MOBILE_REMOTE_SAVE_CHUNK_BYTES + 17);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 251;
    }

    const result = await saveMobileRemoteFile(bridge, "session-1", {
      data: bytes.buffer,
      suggestedName: "report.pdf",
    });

    expect(result).toEqual({ success: true, path: "Download/report.pdf" });
    expect(bridge.begin).toHaveBeenCalledWith("session-1", "report.pdf", "application/pdf");
    expect(chunks).toHaveLength(2);
    expect(decodeChunks(chunks)).toEqual(bytes);
    expect(bridge.finish).toHaveBeenCalledWith("session-1", "save-token");
    expect(bridge.open).toHaveBeenCalledWith(
      "session-1",
      "content://media/external/downloads/42",
      "application/pdf",
    );
    expect(bridge.abort).not.toHaveBeenCalled();
  });

  it("fetches source urls and keeps the response mime type", async () => {
    const { bridge, chunks } = createFakeBridge();
    const fetchMock = vi.fn(async () => {
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "image/png; charset=binary" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await saveMobileRemoteFile(bridge, "session-1", {
      sourceUrl: "https://gateway.test/files/photo",
      suggestedName: "photo.png",
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("https://gateway.test/files/photo");
    expect(bridge.begin).toHaveBeenCalledWith("session-1", "photo.png", "image/png");
    expect(decodeChunks(chunks)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("aborts the native session when finishing fails", async () => {
    const { bridge } = createFakeBridge();
    bridge.finish.mockImplementation(() => {
      throw new Error("disk full");
    });

    const result = await saveMobileRemoteFile(bridge, "session-1", {
      data: new Uint8Array([1]).buffer,
      suggestedName: "a.bin",
    });

    expect(result).toEqual({ success: false, error: "disk full" });
    expect(bridge.abort).toHaveBeenCalledWith("session-1", "save-token");
    expect(bridge.open).not.toHaveBeenCalled();
  });

  it("MF08: saveFileAppend 抛错时 abort 清理会话且不再调用 finish", async () => {
    const { bridge } = createFakeBridge();
    bridge.append.mockImplementation(() => {
      throw new Error("native write failed");
    });
    // 模拟原生 abort 后 token 已失效：若页面仍误调 finish，会得到未知 token 错误并泄漏。
    bridge.finish.mockImplementation(() => {
      throw new Error("Unknown save session token.");
    });

    const result = await saveMobileRemoteFile(bridge, "session-1", {
      data: new Uint8Array(MOBILE_REMOTE_SAVE_CHUNK_BYTES + 1).buffer,
      suggestedName: "a.bin",
    });

    expect(result).toEqual({ success: false, error: "native write failed" });
    expect(bridge.abort).toHaveBeenCalledWith("session-1", "save-token");
    // 失败后不能继续 finish：保存失败的错误是原始 append 错误，不被二次错误覆盖。
    expect(bridge.finish).not.toHaveBeenCalled();
    expect(bridge.open).not.toHaveBeenCalled();
  });

  it("does not fail a saved file when no viewer can open it", async () => {
    const { bridge } = createFakeBridge();
    bridge.open.mockImplementation(() => {
      throw new Error("no viewer");
    });

    const result = await saveMobileRemoteFile(bridge, "session-1", {
      data: new Uint8Array([1]).buffer,
      suggestedName: "a.bin",
    });

    expect(result).toEqual({ success: true, path: "Download/report.pdf" });
  });

  it("reports HTTP failures without starting a native session", async () => {
    const { bridge } = createFakeBridge();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("missing", { status: 404 })),
    );

    const result = await saveMobileRemoteFile(bridge, "session-1", {
      sourceUrl: "https://gateway.test/missing",
      suggestedName: "missing.png",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("404");
    expect(bridge.begin).not.toHaveBeenCalled();
  });

  it("exposes the 16 MiB attachment limit with or without a native bridge", () => {
    const withoutBridge = createMobileRemoteFileCapabilities(undefined, {
      sessionId: "session-1",
    });
    expect(withoutBridge.maxAttachmentBytes).toBe(MOBILE_REMOTE_MAX_ATTACHMENT_BYTES);
    expect(withoutBridge.saveFile).toBeUndefined();

    const { bridge } = createFakeBridge();
    const withBridge = createMobileRemoteFileCapabilities(bridge, {
      sessionId: "session-1",
    });
    expect(withBridge.saveFile).toBeTypeOf("function");
    expect(withBridge.maxAttachmentBytes).toBe(16 * 1024 * 1024);
  });

  it("每次原生文件调用都携带当前 sessionId", async () => {
    const native = {
      saveFileBegin: vi.fn(() => success({ token: "token" })),
      saveFileAppend: vi.fn(() => success()),
      saveFileFinish: vi.fn(() =>
        success({ file: { uri: "content://file/1", displayPath: "Download/a.txt" } }),
      ),
      saveFileAbort: vi.fn(() => success()),
      openFile: vi.fn(() => success({ opened: true })),
    };
    const { bridge } = createFakeBridge();
    const capabilities = createMobileRemoteFileCapabilities(
      {
        saveFileBegin(sessionId, fileName, mimeType) {
          return native.saveFileBegin(sessionId, fileName, mimeType);
        },
        saveFileAppend(sessionId, token, chunk) {
          return native.saveFileAppend(sessionId, token, chunk);
        },
        saveFileFinish(sessionId, token) {
          return native.saveFileFinish(sessionId, token);
        },
        saveFileAbort(sessionId, token) {
          return native.saveFileAbort(sessionId, token);
        },
        openFile(sessionId, uri, mimeType) {
          return native.openFile(sessionId, uri, mimeType);
        },
      },
      { sessionId: "session-1" },
    );

    await capabilities.saveFile!({
      data: new Uint8Array([1, 2, 3]).buffer,
      suggestedName: "a.txt",
    });

    expect(native.saveFileBegin).toHaveBeenCalledWith(
      "session-1",
      "a.txt",
      "text/plain",
    );
    expect(native.saveFileAppend).toHaveBeenCalledWith(
      "session-1",
      "token",
      expect.any(String),
    );
    expect(native.saveFileFinish).toHaveBeenCalledWith("session-1", "token");
    expect(native.openFile).toHaveBeenCalledWith(
      "session-1",
      "content://file/1",
      "text/plain",
    );
    // bridge 只是测试辅助对象，避免未使用变量告警。
    expect(bridge).toBeDefined();
  });

  it("原生 stale-session 直接返回失败，不重试、不写新配置", async () => {
    const native = {
      saveFileBegin: vi.fn(() => failure("stale-session")),
    };
    const capabilities = createMobileRemoteFileCapabilities(
      {
        saveFileBegin: native.saveFileBegin,
        saveFileAppend: vi.fn(),
        saveFileFinish: vi.fn(),
        saveFileAbort: vi.fn(),
      },
      { sessionId: "stale-session" },
    );

    await expect(
      capabilities.saveFile!({
        data: new Uint8Array([1]).buffer,
        suggestedName: "a.txt",
      }),
    ).resolves.toEqual({ success: false, error: "stale-session" });
    expect(native.saveFileBegin).toHaveBeenCalledOnce();
  });
});
