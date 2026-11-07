import type {
  ConversationTurnRenderUnit,
  ConversationTurnRenderUnitsPartition,
} from "@/v4/conversationTurnRenderUnits.js";

export interface ConversationTimelineLiveTailSplit {
  virtualizedUnits: readonly ConversationTurnRenderUnit[];
  liveUnit: ConversationTurnRenderUnit | null;
  liveUnitIndex: number | null;
}

/**
 * running turn 继续放在绝对定位虚拟行里时，正文 DOM 会先长高，
 * ResizeObserver 下一帧才回填 totalSize/scrollTop，导致轮尾 ChatLoading 来回跳。
 * 只把真正的最后一个 running unit 拆成 normal-flow live tail；历史或陈旧 running
 * 行仍归虚拟列表，避免扩大常驻 DOM。
 *
 * F17 步骤②（上游 a60ba6a7 移植）：输入支持「历史 + 尾轮」分区——运行中的最后一轮通常是
 * 唯一的尾轮 unit，此时虚拟列表直接复用 history 数组引用，virtualizer 与目录不随每个
 * token 重建。扁平数组入参保留，既有调用与测试契约不变。
 */
export function splitConversationTimelineLiveTail(
  units: readonly ConversationTurnRenderUnit[],
): ConversationTimelineLiveTailSplit;
export function splitConversationTimelineLiveTail(
  units: ConversationTurnRenderUnitsPartition,
): ConversationTimelineLiveTailSplit;
export function splitConversationTimelineLiveTail(
  units: readonly ConversationTurnRenderUnit[] | ConversationTurnRenderUnitsPartition,
): ConversationTimelineLiveTailSplit {
  // readonly 数组用 Array.isArray 收窄不可靠（lib 对 readonly 的 isArray 收窄不完整），
  // 分区用结构键区分。
  if (!("history" in units)) {
    const liveUnitIndex = units.length - 1;
    const liveUnit = units[liveUnitIndex];
    if (!liveUnit?.isRunning) {
      return { virtualizedUnits: units, liveUnit: null, liveUnitIndex: null };
    }
    return {
      virtualizedUnits: units.slice(0, liveUnitIndex),
      liveUnit,
      liveUnitIndex,
    };
  }
  const { history, tail } = units;
  const liveUnit = tail.at(-1) ?? history.at(-1);
  if (!liveUnit?.isRunning) {
    return {
      virtualizedUnits: tail.length === 0 ? history : [...history, ...tail],
      liveUnit: null,
      liveUnitIndex: null,
    };
  }
  return {
    virtualizedUnits:
      tail.length === 0
        ? history.slice(0, -1)
        : tail.length === 1
          ? history
          : [...history, ...tail.slice(0, -1)],
    liveUnit,
    liveUnitIndex: history.length + tail.length - 1,
  };
}
