import { afterEach, describe, expect, it, vi } from "vitest";
import { MOBILE_REMOTE_NATIVE_BRIDGE_GLOBAL_KEY } from "../src/mobile-remote/mobileRemoteSecureStore.js";
import {
  MOBILE_REMOTE_MAX_ATTACHMENT_BYTES,
  MOBILE_REMOTE_SAVE_CHUNK_BYTES,
  createMobileRemoteFileCapabilities,
  resolveMobileRemoteFileBridge,
  saveMobileRemoteFile,
  type MobileRemoteFileNativeBridge,
} from "../src/mobile-remote/mobileRemoteFileBridge.js";

function createFakeBridge() {
  const chunks: string[] = [];
  const bridge: MobileRemoteFileNativeBridge & {
    begin: ReturnType<typeof vi.fn>;
    append: ReturnType<typeof vi.fn>;
    finish: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
  } = {
    begin: vi.fn(() => "save-token"),
    append: vi.fn((_token: string, chunk: string) => {
      chunks.push(chunk);
    }),
    finish: vi.fn(() =>
      JSON.stringify({
        uri: "content://media/external/downloads/42",
        displayPath: "Download/report.pdf",
      }),
    ),
    abort: vi.fn(),
    open: vi.fn(() => true),
    saveFileBegin(fileName, mimeType) {
      return bridge.begin(fileName, mimeType) as string;
    },
    saveFileAppend(token, chunk) {
      bridge.append(token, chunk);
    },
    saveFileFinish(token) {
      return bridge.finish(token) as string;
    },
    saveFileAbort(token) {
      bridge.abort(token);
    },
    openFile(uri, mimeType) {
      return bridge.open(uri, mimeType) as boolean;
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

describe("mobile remote file bridge (T6.3)", () => {
  it("resolves only complete native file bridges", () => {
    expect(resolveMobileRemoteFileBridge({})).toBeUndefined();
    expect(
      resolveMobileRemoteFileBridge({
        [MOBILE_REMOTE_NATIVE_BRIDGE_GLOBAL_KEY]: {
          saveFileBegin: () => "token",
          saveFileAppend: () => {},
          saveFileFinish: () => "{}",
          // 缺少 saveFileAbort：release 构建不应暴露半套能力。
        },
      }),
    ).toBeUndefined();

    const resolved = resolveMobileRemoteFileBridge({
      [MOBILE_REMOTE_NATIVE_BRIDGE_GLOBAL_KEY]: {
        saveFileBegin: () => "token",
        saveFileAppend: () => {},
        saveFileFinish: () => "{}",
        saveFileAbort: () => {},
        openFile: () => true,
      },
    });
    expect(resolved?.saveFileBegin("a.txt", "text/plain")).toBe("token");
  });

  it("chunks data payloads into base64 bridge calls and opens the saved file", async () => {
    const { bridge, chunks } = createFakeBridge();
    const bytes = new Uint8Array(MOBILE_REMOTE_SAVE_CHUNK_BYTES + 17);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 251;
    }

    const result = await saveMobileRemoteFile(bridge, {
      data: bytes.buffer,
      suggestedName: "report.pdf",
    });

    expect(result).toEqual({ success: true, path: "Download/report.pdf" });
    expect(bridge.begin).toHaveBeenCalledWith("report.pdf", "application/pdf");
    expect(chunks).toHaveLength(2);
    expect(decodeChunks(chunks)).toEqual(bytes);
    expect(bridge.finish).toHaveBeenCalledWith("save-token");
    expect(bridge.open).toHaveBeenCalledWith(
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

    const result = await saveMobileRemoteFile(bridge, {
      sourceUrl: "https://gateway.test/files/photo",
      suggestedName: "photo.png",
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("https://gateway.test/files/photo");
    expect(bridge.begin).toHaveBeenCalledWith("photo.png", "image/png");
    expect(decodeChunks(chunks)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("aborts the native session when finishing fails", async () => {
    const { bridge } = createFakeBridge();
    bridge.finish.mockImplementation(() => {
      throw new Error("disk full");
    });

    const result = await saveMobileRemoteFile(bridge, {
      data: new Uint8Array([1]).buffer,
      suggestedName: "a.bin",
    });

    expect(result).toEqual({ success: false, error: "disk full" });
    expect(bridge.abort).toHaveBeenCalledWith("save-token");
    expect(bridge.open).not.toHaveBeenCalled();
  });

  it("does not fail a saved file when no viewer can open it", async () => {
    const { bridge } = createFakeBridge();
    bridge.open.mockImplementation(() => {
      throw new Error("no viewer");
    });

    const result = await saveMobileRemoteFile(bridge, {
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

    const result = await saveMobileRemoteFile(bridge, {
      sourceUrl: "https://gateway.test/missing",
      suggestedName: "missing.png",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("404");
    expect(bridge.begin).not.toHaveBeenCalled();
  });

  it("exposes the 16 MiB attachment limit with or without a native bridge", () => {
    const withoutBridge = createMobileRemoteFileCapabilities(undefined);
    expect(withoutBridge.maxAttachmentBytes).toBe(MOBILE_REMOTE_MAX_ATTACHMENT_BYTES);
    expect(withoutBridge.saveFile).toBeUndefined();

    const { bridge } = createFakeBridge();
    const withBridge = createMobileRemoteFileCapabilities(bridge);
    expect(withBridge.saveFile).toBeTypeOf("function");
    expect(withBridge.maxAttachmentBytes).toBe(16 * 1024 * 1024);
  });
});
