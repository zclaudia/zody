import { describe, expect, it } from "vitest";
import type { ExtensionBridgeClientMessage } from "@zcode/shared/browser-extension-transport";
import {
  EXTENSION_CLAIM_TTL_MS,
  ExtensionClaimManager,
} from "../src/host/extensionBrowserClaims.js";
import type { ExtensionExecutionContext } from "../src/host/extensionBrowserBackendTypes.js";
import type { ExtensionHostConnection } from "../src/host/extensionTransportClient.js";

const connection: ExtensionHostConnection = {
  profileInstanceId: "profile-instance-1234567890",
  browserId: "extension:profile-instance-1234567890",
  generation: 4,
  connectionId: "connection-1234567890",
  windowId: "window-1",
};

function context(
  sessionId: string,
  extra: Partial<ExtensionExecutionContext> = {},
): ExtensionExecutionContext {
  return {
    requestId: `request-${sessionId}`,
    sessionId,
    workspaceKey: "workspace-1",
    clientMode: "desktop-continuous",
    sessionContext: "live",
    ...extra,
  };
}

function createManager(options: { ttlMs?: number; now?: () => number } = {}) {
  const sent: Array<{ profileInstanceId: string; message: ExtensionBridgeClientMessage }> = [];
  let claimSequence = 0;
  const manager = new ExtensionClaimManager({
    transport: {
      async send(profileInstanceId, message) {
        sent.push({ profileInstanceId, message });
        return true;
      },
    } as never,
    ttlMs: options.ttlMs ?? EXTENSION_CLAIM_TTL_MS,
    ...(options.now ? { now: options.now } : {}),
    createClaimId: () => `claim-${++claimSequence}`,
  });
  return { manager, sent };
}

describe("ExtensionClaimManager two-phase claim", () => {
  it("first claim returns authorization_required without waiting and registers one pending", async () => {
    const { manager, sent } = createManager();
    const outcome = await manager.request(context("session-a"), connection, 42);
    expect(outcome).toEqual({ kind: "authorization_required", claimId: "claim-1" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message).toMatchObject({
      type: "claim.request",
      claimId: "claim-1",
      nativeTabId: 42,
    });
  });

  it("merges a repeated claim from the same session and native tab", async () => {
    const { manager, sent } = createManager();
    const first = await manager.request(context("session-a"), connection, 42);
    const second = await manager.request(context("session-a"), connection, 42);
    expect(second).toEqual(first);
    expect(sent).toHaveLength(1);
  });

  it("denies a different session while a claim is pending", async () => {
    const { manager } = createManager();
    await manager.request(context("session-a"), connection, 42);
    await expect(manager.request(context("session-b"), connection, 42)).resolves.toEqual({
      kind: "conflict",
    });
  });

  it("denies the same session for a different native tab while pending", async () => {
    const { manager } = createManager();
    await manager.request(context("session-a"), connection, 42);
    await expect(manager.request(context("session-a"), connection, 43)).resolves.toEqual({
      kind: "conflict",
    });
  });

  it("grant only applies to the initiating session and the next claim consumes it", async () => {
    const { manager } = createManager();
    const first = await manager.request(context("session-a"), connection, 42);
    if (first.kind !== "authorization_required") throw new Error("expected pending");
    const decision = manager.handleDecision({
      type: "claim.decision",
      claimId: first.claimId,
      nativeTabId: 42,
      decision: "granted",
    });
    expect(decision.kind).toBe("granted");

    // 另一个 session 不能使用该 grant，会建立自己的 pending。
    await expect(manager.request(context("session-b"), connection, 42)).resolves.toMatchObject({
      kind: "authorization_required",
    });
    // 发起 session 的第二次 claim 才拿到一次性的 grant（随后进入 attach）。
    await expect(manager.request(context("session-a"), connection, 42)).resolves.toEqual({
      kind: "granted",
    });
    // grant 已被消费；session-b 的 pending 仍互斥。
    await expect(manager.request(context("session-a"), connection, 42)).resolves.toEqual({
      kind: "conflict",
    });
  });

  it("a denied decision makes the next same-session claim permission_denied without a new request", async () => {
    const { manager, sent } = createManager();
    const first = await manager.request(context("session-a"), connection, 42);
    if (first.kind !== "authorization_required") throw new Error("expected pending");
    expect(
      manager.handleDecision({
        type: "claim.decision",
        claimId: first.claimId,
        nativeTabId: 42,
        decision: "denied",
      }).kind,
    ).toBe("denied");
    const sentAfterDenial = sent.length;

    // 拒绝事实只消费一次：立即重试得到 permission_denied，且不重新发送 claim.request。
    await expect(manager.request(context("session-a"), connection, 42)).resolves.toEqual({
      kind: "denied",
    });
    expect(sent).toHaveLength(sentAfterDenial);

    // 消费之后的再次 claim 才视为新的显式用户意图，可重新进入 pending。
    await expect(manager.request(context("session-a"), connection, 42)).resolves.toMatchObject({
      kind: "authorization_required",
    });
    expect(sent).toHaveLength(sentAfterDenial + 1);
    expect(sent.at(-1)?.message).toMatchObject({ type: "claim.request", nativeTabId: 42 });
  });

  it("a dismissed Popup behaves like a denial for the same session only", async () => {
    const { manager, sent } = createManager();
    const first = await manager.request(context("session-a"), connection, 42);
    if (first.kind !== "authorization_required") throw new Error("expected pending");
    expect(
      manager.handleDecision({
        type: "claim.decision",
        claimId: first.claimId,
        nativeTabId: 42,
        decision: "dismissed",
      }).kind,
    ).toBe("denied");
    const sentAfterDismiss = sent.length;

    await expect(manager.request(context("session-a"), connection, 42)).resolves.toEqual({
      kind: "denied",
    });
    expect(sent).toHaveLength(sentAfterDismiss);
    // 其他 session 的显式 claim 是新的授权请求，不被 session-a 的拒绝事实影响。
    await expect(manager.request(context("session-b"), connection, 42)).resolves.toMatchObject({
      kind: "authorization_required",
    });
    expect(sent).toHaveLength(sentAfterDismiss + 1);
  });

  it("expired pending rejects a late granted decision fail closed", async () => {
    let now = 1_000;
    const { manager } = createManager({ ttlMs: 2_000, now: () => now });
    const first = await manager.request(context("session-a"), connection, 42);
    if (first.kind !== "authorization_required") throw new Error("expected pending");
    now += 2_001;
    expect(
      manager.handleDecision({
        type: "claim.decision",
        claimId: first.claimId,
        nativeTabId: 42,
        decision: "granted",
      }).kind,
    ).toBe("stale");
    // 晚到决定之后也不能补 attach。
    await expect(manager.request(context("session-a"), connection, 42)).resolves.toMatchObject({
      kind: "authorization_required",
    });
  });

  it("unknown claim id or mismatched tab is stale", async () => {
    const { manager } = createManager();
    const first = await manager.request(context("session-a"), connection, 42);
    if (first.kind !== "authorization_required") throw new Error("expected pending");
    expect(
      manager.handleDecision({
        type: "claim.decision",
        claimId: "unknown",
        nativeTabId: 42,
        decision: "granted",
      }).kind,
    ).toBe("stale");
    expect(
      manager.handleDecision({
        type: "claim.decision",
        claimId: first.claimId,
        nativeTabId: 43,
        decision: "granted",
      }).kind,
    ).toBe("stale");
    // 不同 Profile 的决定不能命中另一个 Profile 的 pending。
    expect(
      manager.handleDecision(
        {
          type: "claim.decision",
          claimId: first.claimId,
          nativeTabId: 42,
          decision: "granted",
        },
        "other-profile-1234567890",
      ).kind,
    ).toBe("stale");
  });

  it("connection invalidation clears pending and grants", async () => {
    const { manager } = createManager();
    const first = await manager.request(context("session-a"), connection, 42);
    if (first.kind !== "authorization_required") throw new Error("expected pending");
    manager.invalidateConnection(connection.profileInstanceId);
    expect(manager.pendingClaimId).toBeUndefined();
    await expect(manager.request(context("session-a"), connection, 42)).resolves.toMatchObject({
      kind: "authorization_required",
    });
  });
});
