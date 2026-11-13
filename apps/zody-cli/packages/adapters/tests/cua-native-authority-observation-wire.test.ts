import { duplexPair } from "node:stream";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { CuaSubmissionTurnScope } from "@zody/contracts";
import { createCuaNativeAuthoritySession } from "../src/mcp/cua-native-authority.js";

const ref = {
  submissionLineageId: "l",
  appIncarnation: "a",
  hostInstanceId: "h",
  runtimeInstanceId: "r",
  sessionId: "s",
  workspaceKey: "w",
  authorizationRevision: 1,
};
const association = { ref, traceId: "t", producerIncarnation: "p", runId: "r", turnId: "t" };
const scope = {
  ref,
  traceId: "t",
  runId: "r",
  turnId: "t",
  bindProducer: () => true,
  close: () => {},
  onInvalidated: () => () => {},
  producerPort: {
    resolve: async () => ({ status: "candidate", ref }),
    revoke: async () => ({ status: "unknown" }),
  },
} as unknown as CuaSubmissionTurnScope;
function result(bytes: number) {
  const row = { pid: 42, name: "x".repeat(bytes), bundle_id: null, active: false };
  return { content: [{ type: "text", text: JSON.stringify([row]) }] };
}
function open(
  method?: "list_apps" | "list_windows" | "get_app_state",
  limits = {},
  args: Record<string, unknown> = {},
) {
  const [host, helper] = duplexPair();
  helper.on("error", () => {});
  const accept = vi.fn();
  const rejected = vi.fn();
  const session = createCuaNativeAuthoritySession({
    scope,
    stream: host,
    producerIncarnation: "p",
    requestTimeoutMs: 100,
    closeTimeoutMs: 20,
    ...limits,
    ...(method
      ? { observation: { request: { method, arguments: args }, accept, onRejected: rejected } }
      : {}),
  });
  const send = (name: string, payload: object) =>
    helper.write(`${JSON.stringify({ requestId: name, method: name, payload })}\n`);
  return { session, host, helper, accept, rejected, send };
}
async function bootstrap(f: ReturnType<typeof open>) {
  const reply = once(f.helper, "data");
  f.send("bootstrap", {});
  await reply;
}
describe("observation wire budgets", () => {
  it("rejects an oversized outgoing bootstrap response", async () => {
    const f = open("list_apps", {}, { padding: "x".repeat(17_000) });
    f.send("bootstrap", {});
    await expect.poll(() => f.session.diagnostics.lastFailure).toBe("output_backlog_exceeded");
    f.session.close();
  });
  it("rejects an oversized outgoing check response", async () => {
    let large = false;
    const customScope = {
      ...scope,
      producerPort: {
        ...scope.producerPort,
        resolve: async () => ({
          status: "candidate",
          ref,
          ...(large ? { padding: "x".repeat(17_000) } : {}),
        }),
      },
    };
    const f = open("list_apps", { scope: customScope });
    await bootstrap(f);
    large = true;
    f.send("check", association);
    await expect.poll(() => f.session.diagnostics.lastFailure).toBe("output_backlog_exceeded");
    f.session.close();
  });
  it("rejects accumulated outgoing backlog above 64 KiB", async () => {
    let large = false;
    const customScope = {
      ...scope,
      producerPort: {
        ...scope.producerPort,
        resolve: async () => ({
          status: "candidate",
          ref,
          ...(large ? { padding: "x".repeat(15_000) } : {}),
        }),
      },
    };
    const f = open("list_apps", { scope: customScope });
    await bootstrap(f);
    large = true;
    f.host.cork();
    for (let i = 0; i < 5; i++) {
      f.send("check", association);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await expect.poll(() => f.session.diagnostics.lastFailure).toBe("output_backlog_exceeded");
    f.session.close();
  });
  it("accepts a real 19.6 KiB metadata result through the wire", async () => {
    const f = open("list_apps");
    await bootstrap(f);
    f.send("observationResult", { ...association, result: result(19_600) });
    await expect.poll(() => f.accept.mock.calls.length).toBe(1);
    f.session.close();
  });
  it("allows the same metadata budget for list_windows", async () => {
    const f = open("list_windows");
    await bootstrap(f);
    const row = {
      pid: 42,
      window_id: 8,
      title: "x".repeat(19_600),
      text_preview: null,
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      main: null,
      focused: null,
      onscreen: true,
    };
    f.send("observationResult", {
      ...association,
      result: { content: [{ type: "text", text: JSON.stringify([row]) }] },
    });
    await expect.poll(() => f.accept.mock.calls.length).toBe(1);
    f.session.close();
  });
  it("accepts near 64 KiB and rejects a metadata result over 64 KiB", async () => {
    for (const [size, accepted] of [
      [65_000, true],
      [65_536, false],
    ] as const) {
      const f = open("list_apps");
      await bootstrap(f);
      f.send("observationResult", { ...association, result: result(size) });
      await expect
        .poll(() => (accepted ? f.accept.mock.calls.length : f.rejected.mock.calls.length))
        .toBe(1);
      if (!accepted) expect(f.rejected).toHaveBeenCalledWith("observation-invalid");
      f.session.close();
    }
  });
  it("enforces exact 64 KiB metadata result bytes", async () => {
    const base = result(1);
    const overhead = Buffer.byteLength(JSON.stringify(base)) - 1;
    for (const delta of [0, 1]) {
      const f = open("list_apps");
      await bootstrap(f);
      const payload = result(64 * 1024 - overhead + delta);
      expect(Buffer.byteLength(JSON.stringify(payload))).toBe(64 * 1024 + delta);
      f.send("observationResult", { ...association, result: payload });
      await expect
        .poll(() => (delta ? f.rejected.mock.calls.length : f.accept.mock.calls.length))
        .toBe(1);
      f.session.close();
    }
  });
  it("rejects body and error results above 12 KiB", async () => {
    for (const method of ["get_app_state", "list_apps"] as const) {
      const f = open(method);
      await bootstrap(f);
      const payload =
        method === "list_apps"
          ? { isError: true, content: [{ type: "text", text: "x".repeat(12 * 1024) }] }
          : result(12 * 1024);
      f.send("observationResult", { ...association, result: payload });
      await expect.poll(() => f.rejected.mock.calls.length).toBe(1);
      expect(f.rejected).toHaveBeenCalledWith("observation-invalid");
      f.session.close();
    }
  });
  it("honors caller limits that tighten metadata sessions", async () => {
    const f = open("list_apps", { maxFrameBytes: 17 * 1024, maxPendingBytes: 20 * 1024 });
    await bootstrap(f);
    f.send("observationResult", { ...association, result: result(19_600) });
    await expect.poll(() => f.session.diagnostics.lastFailure).toBe("frame_too_large");
    f.session.close();
  });
  it("keeps body and default sessions at 16 KiB wire", async () => {
    for (const method of [undefined, "get_app_state"] as const) {
      const f = open(method);
      await bootstrap(f);
      f.send("observationResult", { ...association, result: result(19_600) });
      await expect.poll(() => f.session.diagnostics.lastFailure).toBe("frame_too_large");
      f.session.close();
    }
  });
  it("keeps non-result frames at 16 KiB in metadata sessions", async () => {
    const f = open("list_apps");
    await bootstrap(f);
    f.send("check", { padding: "x".repeat(19_600) });
    await expect.poll(() => f.session.diagnostics.lastFailure).toBe("frame_too_large");
    f.session.close();
  });
  it("caps metadata frames at 128 KiB and pending input at 256 KiB", async () => {
    const frame = open("list_apps");
    await bootstrap(frame);
    frame.helper.write("x".repeat(128 * 1024 + 1));
    await expect.poll(() => frame.session.diagnostics.lastFailure).toBe("frame_too_large");
    frame.session.close();
    const pending = open("list_apps");
    await bootstrap(pending);
    pending.helper.write("x".repeat(256 * 1024 + 1));
    await expect.poll(() => pending.session.diagnostics.lastFailure).toBe("input_backlog_exceeded");
    pending.session.close();
  });
});
