import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  startControlOnlyDiagnosticLauncher,
  type ControlOnlyLauncherClosedEvent,
} from "../src/mcp/control-only-launcher.js";

const waitTimeoutMs = 15_000;
const childPath = resolve(import.meta.dirname, "fixtures/control-only-ready-child.mjs");

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), waitTimeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("control-only launcher ready boundaries", () => {
  it.each([
    ["forged signature", "forged-signature", "signature is invalid"],
    ["wrong binding", "wrong-binding", "binding changed"],
    ["wrong challenge", "wrong-challenge", "challenge changed"],
  ])("rejects a ready with a %s", async (_label, mode, expectedMessage) => {
    const closedEvents: ControlOnlyLauncherClosedEvent[] = [];

    await expect(
      withTimeout(
        startControlOnlyDiagnosticLauncher({
          appIncarnation: "app-invalid-ready",
          closeTimeoutMs: 1_000,
          launch: { args: [childPath, mode], command: process.execPath },
          onClosed: (event) => {
            closedEvents.push(event);
          },
          startupTimeoutMs: 5_000,
        }),
        "invalid ready was not rejected",
      ),
    ).rejects.toMatchObject({
      code: "startup_invalid",
      message: expect.stringContaining(expectedMessage),
    });

    expect(closedEvents).toHaveLength(1);
    expect(closedEvents[0]?.reason).toBe("startup_failed");
  });

  it("settles a pending request and emits onClosed once when the child exits after ready", async () => {
    const closedEvents: ControlOnlyLauncherClosedEvent[] = [];
    const launcher = await withTimeout(
      startControlOnlyDiagnosticLauncher({
        appIncarnation: "app-abnormal-exit",
        closeTimeoutMs: 2_000,
        launch: { args: [childPath, "abnormal-exit"], command: process.execPath },
        onClosed: (event) => {
          closedEvents.push(event);
        },
        requestTimeoutMs: 10_000,
        startupTimeoutMs: 5_000,
      }),
      "fixture did not become ready",
    );

    const pending = launcher.request({
      operation: "revoke_submission",
      submissionLineageId: "lineage-abnormal-exit",
      authorizationRevision: 1,
    });
    pending.catch(() => undefined);

    await expect(withTimeout(pending, "pending request was not settled")).rejects.toThrow(
      /control channel closed/u,
    );
    await withTimeout(launcher.close(), "launcher did not finish child-exit cleanup");

    expect(closedEvents).toHaveLength(1);
    expect(closedEvents[0]).toMatchObject({
      exitCode: 23,
      pendingRequests: 1,
      signal: null,
    });
    expect(["child_exit", "peer_eof", "transport_closed", "transport_error"]).toContain(
      closedEvents[0]?.reason,
    );
  });
});
