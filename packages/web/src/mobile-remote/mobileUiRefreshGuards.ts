/**
 * 手机 Remote 安全刷新的 guard 注册表（spec 第 9.3、10、11 M3 节；M3-T1 契约定点）。
 *
 * 唯一所有者边界：
 * - guard 只查询既有状态所有者（草稿、pending overlay、设置草稿、文件操作、弹层、
 *   原生操作、M3-T4 决定的后台任务），不把 task/draft 状态复制到这里；
 * - 注册表只保存「查询函数」，不保存业务快照；
 * - 控制器在每次 reload 前重新求值，guard 状态解除后自然放行，不需要缓存失效通知。
 *
 * 失败策略：guard 抛错、返回 `undefined`、返回未知/非法 reason 都视为未知状态并阻塞刷新。
 * 只有显式的 `null` 表示「当前没有阻塞」。这样新增状态所有者忘记升级本契约时不会误刷新。
 */

/** 刷新阻塞原因；稳定字符串供 UI 展示与测试断言，不随实现漂移。 */
export const MOBILE_UI_REFRESH_BLOCK_REASONS = [
  "composer-draft",
  "pending-optimistic-overlay",
  "unsaved-settings",
  "file-operation",
  "active-overlay",
  "native-operation",
  "background-task",
  "unknown-guard-state",
] as const;

export type MobileUiRefreshBlockReason = (typeof MOBILE_UI_REFRESH_BLOCK_REASONS)[number];

const KNOWN_BLOCK_REASONS = new Set<string>(MOBILE_UI_REFRESH_BLOCK_REASONS);

/** 单个 guard 的查询接口；`null` 表示允许，其余合法 reason 表示阻塞。 */
export interface MobileUiRefreshGuard {
  /** 稳定标识，仅用于诊断；允许重复注册，每个注册独立释放。 */
  id: string;
  getBlockReason(): MobileUiRefreshBlockReason | null;
}

export interface MobileUiRefreshGuardEvaluation {
  allowed: boolean;
  /** 去重后的阻塞原因，按注册顺序排列。 */
  reasons: readonly MobileUiRefreshBlockReason[];
  /** 返回未知状态的 guard id，按注册顺序去重。 */
  unknownGuardIds: readonly string[];
}

export interface MobileUiRefreshGuardRegistry {
  /** 注册 guard；返回幂等释放函数。 */
  register(guard: MobileUiRefreshGuard): () => void;
  /** 查询全部 guard；未知状态默认阻塞。 */
  evaluate(): MobileUiRefreshGuardEvaluation;
  /** 释放全部注册，供页面/控制器统一销毁。 */
  clear(): void;
}

interface RegisteredGuard {
  guard: MobileUiRefreshGuard;
  active: boolean;
}

export function createMobileUiRefreshGuardRegistry(): MobileUiRefreshGuardRegistry {
  const guards: RegisteredGuard[] = [];

  return {
    register(guard) {
      if (!guard || typeof guard.getBlockReason !== "function") {
        throw new TypeError("A mobile UI refresh guard must expose getBlockReason().");
      }
      const entry: RegisteredGuard = { guard, active: true };
      guards.push(entry);
      return () => {
        if (!entry.active) {
          return;
        }
        entry.active = false;
        const index = guards.indexOf(entry);
        if (index >= 0) {
          guards.splice(index, 1);
        }
      };
    },

    evaluate() {
      const reasons: MobileUiRefreshBlockReason[] = [];
      const unknownGuardIds: string[] = [];
      for (const entry of guards) {
        if (!entry.active) {
          continue;
        }
        let value: unknown;
        try {
          value = entry.guard.getBlockReason();
        } catch {
          // 状态所有者不可读时不能假设安全；记录未知并阻塞。
          value = undefined;
        }
        if (value === null) {
          continue;
        }
        if (typeof value === "string" && KNOWN_BLOCK_REASONS.has(value)) {
          const reason = value as MobileUiRefreshBlockReason;
          if (!reasons.includes(reason)) {
            reasons.push(reason);
          }
          continue;
        }
        if (!unknownGuardIds.includes(entry.guard.id)) {
          unknownGuardIds.push(entry.guard.id);
        }
        if (!reasons.includes("unknown-guard-state")) {
          reasons.push("unknown-guard-state");
        }
      }
      return {
        allowed: reasons.length === 0,
        reasons,
        unknownGuardIds,
      };
    },

    clear() {
      for (const entry of guards) {
        entry.active = false;
      }
      guards.length = 0;
    },
  };
}
