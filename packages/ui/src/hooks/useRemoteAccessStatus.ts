import { useCallback, useEffect, useState } from "react";
import type { RemoteAccessStatus } from "@zcode/shared";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

function isSameRuntimeStatus(
  left: RemoteAccessStatus["status"],
  right: RemoteAccessStatus["status"],
): boolean {
  return (
    left.status === right.status &&
    left.mobileConnected === right.mobileConnected &&
    left.mobileViewState?.activeWorkspaceKey === right.mobileViewState?.activeWorkspaceKey &&
    left.mobileViewState?.activeTaskId === right.mobileViewState?.activeTaskId &&
    left.mobileViewState?.updatedAt === right.mobileViewState?.updatedAt &&
    left.mobileDeviceInfo?.updatedAt === right.mobileDeviceInfo?.updatedAt &&
    left.mobileDeviceInfo?.name === right.mobileDeviceInfo?.name &&
    left.mobileDeviceInfo?.userAgent === right.mobileDeviceInfo?.userAgent &&
    left.mobileDeviceInfo?.browserPlatform === right.mobileDeviceInfo?.browserPlatform &&
    left.error === right.error &&
    left.failure?.reason === right.failure?.reason &&
    left.failure?.message === right.failure?.message
  );
}

function isSameRemoteAccessStatus(left: RemoteAccessStatus, right: RemoteAccessStatus): boolean {
  if (left.enabled !== right.enabled || !isSameRuntimeStatus(left.status, right.status)) {
    return false;
  }
  if (left.gateway.state !== right.gateway.state) {
    return false;
  }
  if (left.gateway.state === "online" && right.gateway.state === "online") {
    return (
      left.gateway.backendId === right.gateway.backendId &&
      left.gateway.epoch === right.gateway.epoch
    );
  }
  if (left.gateway.state === "error" && right.gateway.state === "error") {
    return left.gateway.reason === right.gateway.reason;
  }
  return true;
}

export interface RemoteAccessStatusRead {
  status: RemoteAccessStatus | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * App 级远程访问状态（开关 + gateway 连接 + 手机连接）。
 *
 * Main 是唯一事实源：这里只查询和订阅，不在 renderer 里推导连接状态。gateway 状态变化目前
 * 没有独立推送事件，因此保留 1s 轮询；运行态变化仍由 `WebRemoteControlStatusChanged` 触发
 * 立即刷新，避免手机接入/断开要等一个轮询周期。
 */
export function useRemoteAccessStatus({
  enabled = true,
  intervalMs = 1000,
}: {
  enabled?: boolean;
  intervalMs?: number;
} = {}): RemoteAccessStatusRead {
  const platform = useOptionalPlatform();
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchStatus = useCallback(async () => {
    const getStatus = platform?.getRemoteAccessStatus;
    if (!getStatus) {
      setStatus(null);
      return;
    }
    const nextStatus = await getStatus.call(platform);
    setStatus((current) =>
      current && isSameRemoteAccessStatus(current, nextStatus) ? current : nextStatus,
    );
  }, [platform]);

  const refresh = useCallback(async () => {
    if (!platform?.getRemoteAccessStatus) {
      setStatus(null);
      return;
    }
    setLoading(true);
    try {
      await fetchStatus();
    } catch (error) {
      // 轮询失败属于高频诊断信息，只走 debug，避免生产日志随刷新频率增长。
      logger.debug("[useRemoteAccessStatus] 同步远程访问状态失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  }, [fetchStatus, platform]);

  useEffect(() => {
    if (!enabled || !platform?.getRemoteAccessStatus) {
      setStatus(null);
      return;
    }

    let disposed = false;
    const sync = async () => {
      try {
        const nextStatus = await platform.getRemoteAccessStatus!();
        if (disposed) {
          return;
        }
        setStatus((current) =>
          current && isSameRemoteAccessStatus(current, nextStatus) ? current : nextStatus,
        );
      } catch (error) {
        logger.debug("[useRemoteAccessStatus] 同步远程访问状态失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    void sync();
    const disposeStatusChanged = platform.onWebRemoteControlStatusChanged?.(() => {
      void sync();
    });
    const intervalId = window.setInterval(() => {
      void sync();
    }, intervalMs);

    return () => {
      disposed = true;
      disposeStatusChanged?.();
      window.clearInterval(intervalId);
    };
  }, [enabled, intervalMs, platform]);

  return { status, loading, refresh };
}
