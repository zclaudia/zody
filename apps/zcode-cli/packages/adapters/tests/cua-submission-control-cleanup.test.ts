import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CuaSubmissionProjection,
  CuaSubmissionProducerPort,
  CuaSubmissionRef,
  CuaSubmissionRevocationResult,
  CuaSubmissionRevokeRequest,
  CuaSubmissionResolveRequest,
} from "@zcode/contracts";
import type { ControlOnlyLauncherInvalidatedEvent } from "../src/mcp/control-only-launcher.js";

const launcherMocks = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
  request: vi.fn(),
  start: vi.fn(),
}));

vi.mock("../src/mcp/control-only-launcher.js", () => ({
  startControlOnlyDiagnosticLauncher: launcherMocks.start,
}));

import { createCuaSubmissionControlSession } from "../src/mcp/cua-submission-control.js";

const ref: CuaSubmissionRef = Object.freeze({
  submissionLineageId: "lineage-cleanup-failure",
  authorizationRevision: 1,
  appIncarnation: "app-cleanup-failure",
  hostInstanceId: "host-cleanup-failure",
  runtimeInstanceId: "runtime-cleanup-failure",
  sessionId: "session-cleanup-failure",
  workspaceKey: "/workspace/cleanup-failure",
});

class Port implements CuaSubmissionProducerPort {
  async resolve(request: CuaSubmissionResolveRequest): Promise<CuaSubmissionProjection> {
    return {
      status: "candidate",
      ref: request.ref,
      nativeFence: "unknown",
      mobileDelivery: "unknown",
    };
  }

  async revoke(request: CuaSubmissionRevokeRequest): Promise<CuaSubmissionRevocationResult> {
    const next = Object.freeze({
      ...request.ref,
      authorizationRevision: request.ref.authorizationRevision + 1,
    });
    return {
      status: "revoked",
      ref: next,
      revocationReason: request.reason,
      idempotent: false,
      projection: {
        status: "revoked",
        ref: next,
        revocationReason: request.reason,
        nativeFence: "unknown",
        mobileDelivery: "unknown",
      },
    };
  }
}

class ThrowingPort extends Port {
  override async revoke(): Promise<CuaSubmissionRevocationResult> {
    throw new Error("authority unavailable");
  }
}

class UnknownPort extends Port {
  override async revoke(): Promise<CuaSubmissionRevocationResult> {
    return {
      status: "unknown",
      projection: { status: "unknown", nativeFence: "unknown", mobileDelivery: "unknown" },
    };
  }
}

class WrongRefPort extends Port {
  override async revoke(
    request: CuaSubmissionRevokeRequest,
  ): Promise<CuaSubmissionRevocationResult> {
    const result = await super.revoke(request);
    if (result.status !== "revoked") return result;
    const wrong = Object.freeze({ ...result.ref, appIncarnation: "wrong-app" });
    return { ...result, ref: wrong, projection: { ...result.projection, ref: wrong } };
  }
}

function captureInvalidation(): () => void {
  let invalidated: ((event: ControlOnlyLauncherInvalidatedEvent) => void) | undefined;
  launcherMocks.start.mockImplementation(
    async (options: { onInvalidated?: (event: ControlOnlyLauncherInvalidatedEvent) => void }) => {
      invalidated = options.onInvalidated;
      return {
        binding: {},
        closed: false,
        closeReason: null,
        request: launcherMocks.request,
        close: launcherMocks.close,
      };
    },
  );
  return () => invalidated?.({ cause: null, message: "control lost", reason: "peer_eof" });
}

describe("CUA submission control cleanup failures", () => {
  beforeEach(() => {
    launcherMocks.close.mockReset();
    launcherMocks.request.mockReset();
    launcherMocks.start.mockReset();
    launcherMocks.close.mockRejectedValue(new Error("cleanup failed"));
    launcherMocks.request.mockResolvedValue({
      ack: { body: { phase: "revoked", facts: { stop: null } } },
      evaluation: { stop: null },
    });
    launcherMocks.start.mockResolvedValue({
      binding: {},
      closed: false,
      closeReason: null,
      request: launcherMocks.request,
      close: launcherMocks.close,
    });
  });

  it("observes scheduled cleanup rejection and preserves it for explicit cleanup", async () => {
    const session = createCuaSubmissionControlSession({
      launch: { args: [], command: "unused" },
      producerPort: new Port(),
      ref,
      traceId: "trace-cleanup-failure",
    });
    await session.start();
    session.onOwnerRevocation(
      Object.freeze({
        status: "revoked",
        ref: Object.freeze({ ...ref, authorizationRevision: 2 }),
        revocationReason: "user-stop",
        nativeFence: "unknown",
        mobileDelivery: "unknown",
      }),
    );
    for (let index = 0; index < 50 && launcherMocks.close.mock.calls.length === 0; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(launcherMocks.close).toHaveBeenCalled();
    await expect(session.cleanup()).rejects.toThrow("cleanup failed");
  });

  it("does not skip finalize when the closed latch is already set", async () => {
    let closed = false;
    launcherMocks.start.mockResolvedValue({
      binding: {},
      get closed() {
        return closed;
      },
      closeReason: null,
      request: launcherMocks.request,
      close: launcherMocks.close,
    });
    const session = createCuaSubmissionControlSession({
      launch: { args: [], command: "unused" },
      producerPort: new Port(),
      ref,
      traceId: "trace-cleanup-closed",
    });
    await session.start();
    closed = true;
    await expect(session.cleanup()).rejects.toThrow("cleanup failed");
    expect(launcherMocks.close).toHaveBeenCalledTimes(1);
  });

  it("joins a delayed finalize instead of resolving cleanup early", async () => {
    let releaseClose!: () => void;
    launcherMocks.close.mockImplementation(
      () => new Promise<void>((resolve) => (releaseClose = resolve)),
    );
    const session = createCuaSubmissionControlSession({
      launch: { args: [], command: "unused" },
      producerPort: new Port(),
      ref,
      traceId: "trace-cleanup-delay",
    });
    await session.start();
    let settled = false;
    const cleaning = session.cleanup().finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseClose();
    await cleaning;
    expect(launcherMocks.close).toHaveBeenCalledTimes(1);
  });

  it("does not regress closed to stopped or forward after cleanup", async () => {
    launcherMocks.close.mockResolvedValue(undefined);
    const session = createCuaSubmissionControlSession({
      launch: { args: [], command: "unused" },
      producerPort: new Port(),
      ref,
      traceId: "trace-cleanup-before-stop",
    });
    await session.start();
    await session.cleanup();
    const result = await session.stop();
    expect(result.controlForwarded).toBe(false);
    expect(session.diagnostics().control).toBe("closed");
    expect(launcherMocks.request).not.toHaveBeenCalled();
  });

  it("fences a stop forward that settles after cleanup", async () => {
    launcherMocks.close.mockResolvedValue(undefined);
    let release!: () => void;
    launcherMocks.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              ack: { body: { phase: "revoked", facts: { stop: null } } },
              evaluation: { revoked: { complete: true }, stop: null },
            });
        }),
    );
    const session = createCuaSubmissionControlSession({
      launch: { args: [], command: "unused" },
      producerPort: new Port(),
      ref,
      traceId: "trace-late-forward",
    });
    await session.start();
    const stopping = session.stop();
    for (let index = 0; index < 50 && launcherMocks.request.mock.calls.length === 0; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(launcherMocks.request).toHaveBeenCalledTimes(1);
    await session.cleanup();
    release();
    await expect(stopping).resolves.toMatchObject({ controlForwarded: false });
    expect(session.diagnostics().control).toBe("closed");
    expect(launcherMocks.request).toHaveBeenCalledTimes(1);
  });

  it("joins launcher invalidation that arrives after the binding invalidated", async () => {
    launcherMocks.close.mockResolvedValue(undefined);
    let release!: () => void;
    launcherMocks.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ack: { body: { phase: "rejected", facts: { stop: null } } } });
        }),
    );
    const invalidate = captureInvalidation();
    const session = createCuaSubmissionControlSession({
      launch: { args: [], command: "unused" },
      producerPort: new Port(),
      ref,
      traceId: "trace-late-launcher-invalidation",
    });
    await session.start();
    session.onOwnerRevocation(
      Object.freeze({
        status: "revoked",
        ref: Object.freeze({ ...ref, authorizationRevision: 2 }),
        revocationReason: "user-stop",
        nativeFence: "unknown",
        mobileDelivery: "unknown",
      }),
    );
    invalidate();
    for (let index = 0; index < 50 && launcherMocks.close.mock.calls.length === 0; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(launcherMocks.close).toHaveBeenCalledTimes(1);
    release();
    await session.cleanup();
  });

  it.each([
    ["throws", () => new ThrowingPort(), "authority revoke failed"],
    ["returns unknown", () => new UnknownPort(), "mismatched ref"],
    ["returns another app", () => new WrongRefPort(), "mismatched ref"],
  ])(
    "rejects cleanup when control-loss authority revoke %s, after closing",
    async (_label, port, message) => {
      launcherMocks.close.mockResolvedValue(undefined);
      const invalidate = captureInvalidation();
      const session = createCuaSubmissionControlSession({
        launch: { args: [], command: "unused" },
        producerPort: port(),
        ref,
        traceId: "trace-cleanup-authority-failure",
      });
      await session.start();
      invalidate();
      await expect(session.cleanup()).rejects.toThrow(message);
      expect(launcherMocks.close).toHaveBeenCalledTimes(1);
    },
  );
});
