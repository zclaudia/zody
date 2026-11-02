import { describe, expect, it } from "vitest";
import {
  CELL_PROTOCOL_VERSION,
  CELL_REQUEST_MAX_BYTES,
  CELL_RESPONSE_MAX_BYTES,
  CellProtocolError,
  cellErrorResponse,
  cellResultResponse,
  encodeCellRequest,
  encodeCellResponse,
  parseCellRequest,
  parseCellResponse,
  type CellRequest,
} from "../src/cell-protocol.js";

const request: CellRequest = {
  version: CELL_PROTOCOL_VERSION,
  invocationId: "invocation-1",
  code: "1 + 1",
  requestMeta: { session_id: "session-1" },
  syncTimeoutMs: 1000,
  documentationRoots: { browser: "/browser/docs", cua: "/cua/docs" },
};

describe("node_repl cell protocol", () => {
  it("round-trips a strict request with per-call capabilities", () => {
    const withCapabilities: CellRequest = {
      ...request,
      cuaCapability: { socketPath: "/tmp/cua.sock", token: "cua-token", invocationId: "inv-1" },
      browserCapability: { socketPath: "/tmp/browser.sock", token: "browser-token" },
    };
    const parsed = parseCellRequest(encodeCellRequest(withCapabilities).trim());
    expect(parsed).toEqual(withCapabilities);
  });

  it("rejects a version mismatch instead of guessing compatibility", () => {
    expect(() =>
      parseCellRequest(JSON.stringify({ ...request, version: CELL_PROTOCOL_VERSION + 1 })),
    ).toThrow(CellProtocolError);
  });

  it("rejects client-supplied context and unknown fields", () => {
    expect(() =>
      parseCellRequest(
        JSON.stringify({
          ...request,
          cuaCapability: {
            socketPath: "/tmp/cua.sock",
            token: "token",
            invocationId: "inv-1",
            context: { sessionId: "forged" },
          },
        }),
      ),
    ).toThrow(/invalid/u);
    expect(() => parseCellRequest(JSON.stringify({ ...request, cwd: "/tmp/forged" }))).toThrow(
      /invalid/u,
    );
  });

  it("rejects oversized requests before spawning or encoding", () => {
    expect(() =>
      encodeCellRequest({ ...request, code: "x".repeat(CELL_REQUEST_MAX_BYTES) }),
    ).toThrow(/exceeded/u);
  });

  it("encodes ok and structured error responses with strict versions", () => {
    const ok = cellResultResponse("invocation-1", { logs: "", result: "2" });
    expect(parseCellResponse(encodeCellResponse(ok).trim())).toEqual(ok);

    const failed = cellErrorResponse(
      "invocation-1",
      Object.assign(new Error("boom"), {
        name: "BoomError",
      }),
    );
    expect(parseCellResponse(encodeCellResponse(failed).trim())).toMatchObject({
      ok: false,
      invocationId: "invocation-1",
      error: { name: "BoomError", message: "boom" },
    });
  });

  it("allows a null invocation id only for parse-time protocol errors", () => {
    const failed = cellErrorResponse(undefined, new CellProtocolError("bad request"));
    expect(parseCellResponse(encodeCellResponse(failed).trim())).toMatchObject({
      ok: false,
      invocationId: null,
    });
  });

  it("rejects oversized responses", () => {
    const response = cellResultResponse("invocation-1", {
      logs: "",
      result: "y".repeat(CELL_RESPONSE_MAX_BYTES),
    });
    expect(() => encodeCellResponse(response)).toThrow(/exceeded/u);
  });
});
