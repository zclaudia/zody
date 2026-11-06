import { randomUUID } from "node:crypto";
import type { ExtensionClaimDecisionMessage } from "@zody/shared/browser-extension-transport";
import type {
  ExtensionExecutionContext,
  ExtensionBrowserBackendLogger,
} from "./extensionBrowserBackendTypes.js";
import type {
  ExtensionHostConnection,
  ExtensionTransportClient,
} from "./extensionTransportClient.js";

/** 默认 2 分钟：Host 负责计时，超时后 Popup 的晚到同意不得 attach。 */
export const EXTENSION_CLAIM_TTL_MS = 2 * 60 * 1000;

interface ClaimOwner {
  sessionId: string;
  workspaceKey: string;
  remoteSessionId?: string;
}

interface PendingClaim {
  claimId: string;
  profileInstanceId: string;
  connectionId: string;
  generation: number;
  nativeTabId: number;
  owner: ClaimOwner;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface ClaimGrant extends Omit<PendingClaim, "claimId" | "timer" | "expiresAt"> {
  expiresAt: number;
}

/** 用户拒绝/Popup 关闭的事实；只消费一次，避免自动重复提示。 */
interface ClaimDenial extends ClaimGrant {}

export type ClaimRequestOutcome =
  | { kind: "authorization_required"; claimId: string }
  | { kind: "granted" }
  | { kind: "denied" }
  | { kind: "conflict" }
  | { kind: "unavailable" };

export type ClaimDecisionOutcome =
  | { kind: "granted"; pending: PendingClaim }
  | { kind: "denied"; pending: PendingClaim }
  | { kind: "stale" };

export interface ExtensionClaimManagerDeps {
  transport: ExtensionTransportClient;
  logger?: ExtensionBrowserBackendLogger;
  ttlMs?: number;
  now?: () => number;
  createClaimId?: () => string;
}

/**
 * Host 的 pending claim / grant 唯一所有者。
 *
 * - 同一窗口（即同一个 backend 实例）同时只允许一个 pending。
 * - 同一 session + 同一 native tab 的重复 claim 合并到现有 pending。
 * - 用户 granted 只记到发起 session；仍由同一 session 第二次 claim 才 attach。
 * - TTL、取消、连接代次变化和晚到决定都 fail closed。
 */
export class ExtensionClaimManager {
  private pending: PendingClaim | undefined;
  private readonly grants = new Map<string, ClaimGrant>();
  private readonly denials = new Map<string, ClaimDenial>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly createClaimId: () => string;
  private disposed = false;

  constructor(private readonly deps: ExtensionClaimManagerDeps) {
    this.ttlMs = deps.ttlMs ?? EXTENSION_CLAIM_TTL_MS;
    this.now = deps.now ?? Date.now;
    this.createClaimId = deps.createClaimId ?? (() => `extclaim:${randomUUID()}`);
  }

  get pendingClaimId(): string | undefined {
    return this.pending?.claimId;
  }

  async request(
    context: ExtensionExecutionContext,
    connection: ExtensionHostConnection,
    nativeTabId: number,
  ): Promise<ClaimRequestOutcome> {
    this.pruneExpired();
    const owner = ownerFromContext(context);

    const bindingKey = this.bindingKey(connection, nativeTabId, owner);
    const grant = this.grants.get(bindingKey);
    if (grant) {
      this.grants.delete(bindingKey);
      return { kind: "granted" };
    }

    const denial = this.denials.get(bindingKey);
    if (denial) {
      // 用户已经拒绝/关闭 Popup：下一次同 session+同 tab 的 claim 直接 permission_denied，
      // 不重新发送 claim.request。拒绝事实只消费一次；之后的新 claim 才视为新的显式意图。
      this.denials.delete(bindingKey);
      return { kind: "denied" };
    }

    const pending = this.pending;
    if (pending) {
      if (
        pending.profileInstanceId === connection.profileInstanceId &&
        pending.connectionId === connection.connectionId &&
        pending.generation === connection.generation &&
        pending.nativeTabId === nativeTabId &&
        sameClaimOwner(pending.owner, owner)
      ) {
        // 同一 session/同一 tab 的重复 claim 合并，不新建第二个 pending。
        return { kind: "authorization_required", claimId: pending.claimId };
      }
      return { kind: "conflict" };
    }

    const claimId = this.createClaimId();
    const expiresAt = this.now() + this.ttlMs;
    const timer = setTimeout(() => {
      if (this.pending?.claimId !== claimId) return;
      this.pending = undefined;
      // 超时后主动清掉 badge/Popup；晚到 granted 会因找不到 pending 而 fail closed。
      void this.deps.transport
        .send(connection.profileInstanceId, { type: "claim.cancel", claimId })
        .catch(() => undefined);
      this.deps.logger?.debug("[extension-browser] pending claim expired", { claimId });
    }, this.ttlMs);
    timer.unref?.();

    const entry: PendingClaim = {
      claimId,
      profileInstanceId: connection.profileInstanceId,
      connectionId: connection.connectionId,
      generation: connection.generation,
      nativeTabId,
      owner,
      expiresAt,
      timer,
    };
    this.pending = entry;
    try {
      const sent = await this.deps.transport.send(connection.profileInstanceId, {
        type: "claim.request",
        claimId,
        nativeTabId,
        expiresAt,
      });
      if (!sent) {
        this.clearPending(entry);
        return { kind: "unavailable" };
      }
    } catch {
      this.clearPending(entry);
      return { kind: "unavailable" };
    }
    return { kind: "authorization_required", claimId };
  }

  handleDecision(
    message: ExtensionClaimDecisionMessage,
    profileInstanceId?: string,
  ): ClaimDecisionOutcome {
    const pending = this.pending;
    if (
      !pending ||
      pending.claimId !== message.claimId ||
      pending.nativeTabId !== message.nativeTabId ||
      (profileInstanceId !== undefined && pending.profileInstanceId !== profileInstanceId)
    ) {
      // 过期、已取消、已被其他 tab 替换或未知 claimId：不 attach。
      return { kind: "stale" };
    }
    if (pending.expiresAt <= this.now()) {
      this.clearPending(pending);
      return { kind: "stale" };
    }
    this.clearPending(pending);
    if (message.decision !== "granted") {
      // denied 与 dismissed 都表示用户没有授权；记录一次性拒绝事实，下一次同 session/tab
      // claim 必须返回 permission_denied，而不是重新创建 pending 再次打扰用户。
      this.denials.set(
        this.bindingKey(
          {
            profileInstanceId: pending.profileInstanceId,
            connectionId: pending.connectionId,
            generation: pending.generation,
          },
          pending.nativeTabId,
          pending.owner,
        ),
        {
          profileInstanceId: pending.profileInstanceId,
          connectionId: pending.connectionId,
          generation: pending.generation,
          nativeTabId: pending.nativeTabId,
          owner: pending.owner,
          expiresAt: this.now() + this.ttlMs,
        },
      );
      return { kind: "denied", pending };
    }
    this.grants.set(
      this.bindingKey(
        {
          profileInstanceId: pending.profileInstanceId,
          connectionId: pending.connectionId,
          generation: pending.generation,
        },
        pending.nativeTabId,
        pending.owner,
      ),
      {
        profileInstanceId: pending.profileInstanceId,
        connectionId: pending.connectionId,
        generation: pending.generation,
        nativeTabId: pending.nativeTabId,
        owner: pending.owner,
        expiresAt: this.now() + this.ttlMs,
      },
    );
    this.deps.logger?.info("[extension-browser] user granted tab claim", {
      claimId: pending.claimId,
      nativeTabId: pending.nativeTabId,
    });
    return { kind: "granted", pending };
  }

  /** 连接断开/代次变化：pending、grant 与 denial 全部失效，旧引用不能 attach。 */
  invalidateConnection(profileInstanceId: string): void {
    if (this.pending?.profileInstanceId === profileInstanceId) {
      const pending = this.pending;
      this.clearPending(pending);
      void this.deps.transport
        .send(profileInstanceId, { type: "claim.cancel", claimId: pending.claimId })
        .catch(() => undefined);
    }
    for (const [key, grant] of this.grants) {
      if (grant.profileInstanceId === profileInstanceId) this.grants.delete(key);
    }
    for (const [key, denial] of this.denials) {
      if (denial.profileInstanceId === profileInstanceId) this.denials.delete(key);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = undefined;
    this.grants.clear();
    this.denials.clear();
  }

  private clearPending(pending: PendingClaim): void {
    clearTimeout(pending.timer);
    if (this.pending?.claimId === pending.claimId) this.pending = undefined;
  }

  private pruneExpired(): void {
    if (this.disposed) return;
    const now = this.now();
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(key);
    }
    for (const [key, denial] of this.denials) {
      if (denial.expiresAt <= now) this.denials.delete(key);
    }
  }

  private bindingKey(
    connection: Pick<ExtensionHostConnection, "profileInstanceId" | "connectionId" | "generation">,
    nativeTabId: number,
    owner: ClaimOwner,
  ): string {
    return [
      connection.profileInstanceId,
      connection.connectionId,
      connection.generation,
      nativeTabId,
      owner.sessionId,
      owner.workspaceKey,
      owner.remoteSessionId ?? "",
    ].join("\u0000");
  }
}

function ownerFromContext(context: ExtensionExecutionContext): ClaimOwner {
  return {
    sessionId: context.sessionId,
    workspaceKey: context.workspaceKey,
    ...(context.remoteSessionId ? { remoteSessionId: context.remoteSessionId } : {}),
  };
}

function sameClaimOwner(left: ClaimOwner, right: ClaimOwner): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.workspaceKey === right.workspaceKey &&
    (left.remoteSessionId ?? "") === (right.remoteSessionId ?? "")
  );
}
