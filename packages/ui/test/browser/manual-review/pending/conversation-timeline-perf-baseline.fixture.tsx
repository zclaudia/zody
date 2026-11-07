// F17 基线夹具（upstream v3.17.1 a60ba6a7 分区渲染移植的基线步）：
// 与 conversation-timeline-resize.fixture.tsx 同一驱动方式，但面向长会话性能测量——
// 真实 ConversationTimeline + TanStack virtualizer + Streamdown，在真实 Chromium 里
// 量化「流式每帧成本」「初始挂载」「定位跳转后的挂载量」「查找激活时的流式成本」。
// 数据全部确定性生成（不依赖 provider），由 conversation-timeline-perf-baseline.test.mjs 驱动。
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type {
  AssistantTextRow,
  ConversationRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zody/shared/zody-protocol-v4";
import { ZodyIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import { advanceConversationRowsPartition } from "@/v4/conversationProjectionStore.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import "@/styles.css";

export interface MountedStats {
  /** 消息层内已挂载的 turn 单元数（含 running live tail）。 */
  mountedTurnUnits: number;
  /** 虚拟历史容器内已挂载的 turn 单元数（对 ROW_OVERSCAN 敏感）。 */
  historyTurnUnits: number;
  /** 虚拟历史容器内 DOM 元素总数（对屏外 markdown 挂载量敏感）。 */
  historyElements: number;
}

export interface ScrollState {
  following: string | null;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  gap: number;
}

const query = new URLSearchParams(location.search);
const theme = query.get("theme") === "light" ? "light" : "dark";
// 终态轮数；running 尾轮额外 +1。每轮 3 行（turnHeader/userInput/assistantText）。
const terminalTurnCount = Math.max(1, Number(query.get("turns") ?? "500"));
const FIND_NEEDLE = "F17_NEEDLE_MARKER";

// 历史正文与查找索引都要求真实量级：正文带 markdown 结构，NEEDLE 让查找索引
// 在长会话下有真实命中数（查找分区缓存的分步要复测这一项）。
function assistantText(index: number): string {
  return `第 ${index + 1} 轮回答。${FIND_NEEDLE} 流式分区基线。内容包含段落、列表与代码，保证 markdown 渲染成本与真实会话同量级。\n\n- 要点一：虚拟滚动只挂载窗口附近轮次\n- 要点二：流式帧每帧都产生新的 rows 数组引用\n\n\`\`\`ts\nconst rows = window.map((row) => row);\n\`\`\`\n\n${"补充段落，用于把每轮正文拉到接近真实回答的长度，避免行高全部退化为同一估计值。".repeat(3)}`;
}

function userInputText(index: number): string {
  return `问题 ${index + 1}：长会话流式性能基线 ${FIND_NEEDLE}，这是第 ${index + 1} 个用户输入，文本长度与真实提问同量级。`;
}

interface FixtureRows {
  rows: ConversationRow[];
  /** running 尾轮的 assistantText rowId（流式帧只改这一行）。 */
  tailAssistantRowId: number;
  /** 终态轮数（不含 running 尾轮）。 */
  terminalTurns: number;
}

function buildRows(terminalTurns: number): FixtureRows {
  const rows: ConversationRow[] = [];
  const total = terminalTurns + 1;
  for (let turn = 0; turn < total; turn += 1) {
    const running = turn === total - 1;
    const turnId = `turn-${turn}`;
    const base = turn * 3;
    const createdAt = 1_700_000_000_000 + turn * 1_000;
    const header: TurnHeaderRow = {
      rowId: base + 1,
      turnId,
      createdAt,
      createdAtSeq: base + 1,
      kind: "turnHeader",
      origin: "userInput",
      state: running ? "running" : "completedSuccess",
      startedAt: createdAt,
      ...(running ? {} : { endedAt: createdAt + 30_000, activeMs: 25_000 }),
    };
    const input: UserInputRow = {
      rowId: base + 2,
      turnId,
      createdAt,
      createdAtSeq: base + 2,
      kind: "userInput",
      origin: "realUser",
      text: userInputText(turn),
      attachments: [],
    };
    const assistant: AssistantTextRow = {
      rowId: base + 3,
      turnId,
      createdAt,
      createdAtSeq: base + 3,
      kind: "assistantText",
      text: assistantText(turn),
      state: running ? "streaming" : "complete",
    };
    rows.push(header, input, assistant);
  }
  return {
    rows,
    tailAssistantRowId: (total - 1) * 3 + 3,
    terminalTurns,
  };
}

const initial = buildRows(terminalTurnCount);

const settle = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

function findTimeline(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="v4-timeline"]');
}

function scrollState(): ScrollState | null {
  const timeline = findTimeline();
  if (!timeline) return null;
  return {
    following: timeline.dataset.following ?? null,
    scrollTop: timeline.scrollTop,
    scrollHeight: timeline.scrollHeight,
    clientHeight: timeline.clientHeight,
    gap: timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop,
  };
}

// 挂载量口径：必须限定在消息层内统计——turn navigator 目录 rail 的条目也带
// data-turn-id，全文档计数会把目录虚拟列表混进时间线挂载量。
// ROW_OVERSCAN 收紧（F17 overscan 步）后 historyTurnUnits/historyElements 应确定性下降。
function mountedStats(): MountedStats {
  const timeline = findTimeline();
  const messageLayer = timeline?.querySelector<HTMLElement>(
    "[data-v4-timeline-message-layer]",
  );
  const history = timeline?.querySelector<HTMLElement>(
    "[data-v4-timeline-virtual-history]",
  );
  return {
    mountedTurnUnits: messageLayer
      ? messageLayer.querySelectorAll("[data-v4-turn-unit]").length
      : 0,
    historyTurnUnits: history
      ? history.querySelectorAll("[data-v4-turn-unit]").length
      : 0,
    historyElements: history ? history.querySelectorAll("*").length : 0,
  };
}

interface TimelinePerfHarness {
  meta: {
    terminalTurns: number;
    totalRows: number;
    tailAssistantRowId: number;
  };
  ready: () => Promise<{ stats: MountedStats; scroll: ScrollState | null }>;
  streamFrames: (options: {
    frames: number;
    chunkChars: number;
    rafBetweenFrames: boolean;
    warmupFrames: number;
    mode: "replace" | "append";
  }) => Promise<{ durations: number[]; stats: MountedStats; scroll: ScrollState | null }>;
  jumpTo: (
    unitIndex: number,
    rowId: number,
  ) => Promise<{ stats: MountedStats; scroll: ScrollState | null }>;
  goBottom: () => Promise<ScrollState | null>;
  setFind: (value: string) => Promise<MountedStats>;
  mountedStats: () => MountedStats;
  scrollState: () => ScrollState | null;
}

declare global {
  interface Window {
    __timelineErrors: string[];
    __timelinePerf: TimelinePerfHarness;
  }
}

function Fixture() {
  const [rows, setRows] = useState<ConversationRow[]>(initial.rows);
  const [findQuery, setFindQuery] = useState("");
  const back = useRef<(() => void) | null>(null);
  const locate = useRef<
    ((target: { unitIndex: number; rowId: number }) => void) | null
  >(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // 流式帧：每帧生成新的 rows 数组引用 + 新的尾轮 assistantText 对象，
  // 与真实 delta 应用语义一致（rows 每帧都是新数组）。用 flushSync 让
  // render+commit 同步完成，performance.now 差值即该帧 renderer 主线程成本，
  // 不含浏览器 layout/paint（口径写入 docs/ui/chat-virtual-scroll.md）。
  // warmup 帧执行但不计入（排除首帧 JIT/记忆化噪声）。
  //
  // mode:
  // - replace（默认，M1 口径）：尾轮文本 = 基线正文 + 帧序号嵌入的等长增量，
  //   每帧内容变化但长度恒定。这样尾轮 markdown 重渲染成本是常量项，
  //   p50 随历史规模的增量即历史段每帧派生成本（分区步的直接靶点）。
  // - append：真实 provider 语义（文本单调增长），作真实性交叉验证；
  //   该模式下尾轮渲染成本随帧增长，growth 信号会被稀释。
  const streamFrames = async (options: {
    frames: number;
    chunkChars: number;
    rafBetweenFrames: boolean;
    warmupFrames: number;
    mode: "replace" | "append";
  }) => {
    const {
      frames,
      chunkChars,
      rafBetweenFrames,
      warmupFrames,
      mode = "replace",
    } = options;
    const durations: number[] = [];
    const baseChunk = `${FIND_NEEDLE} 流式增量段落，保持与真实 provider chunk 同量级的文本长度。`.repeat(
      Math.max(1, Math.round(chunkChars / 32)),
    );
    const tailRowId = initial.tailAssistantRowId;
    const baseTailText = initial.rows
      .find((row) => row.rowId === tailRowId && row.kind === "assistantText")
      ?.text;
    if (baseTailText === undefined) throw new Error("tail assistant row missing");
    for (let frame = 0; frame < warmupFrames + frames; frame += 1) {
      const current = rowsRef.current;
      // replace 模式：末尾数字轮换保证内容每帧变化、长度恒定。
      const frameTag = String(frame % 10);
      const tailText =
        mode === "append"
          ? (current.find(
              (row) => row.rowId === tailRowId && row.kind === "assistantText",
            )?.text ?? baseTailText) + baseChunk
          : baseTailText.slice(0, -1) + frameTag + baseChunk;
      const next = current.map((row) =>
        row.rowId === tailRowId && row.kind === "assistantText"
          ? { ...row, text: tailText }
          : row,
      );
      // 与生产一致：ConversationProjectionStore 在 delta 应用后、setState 前调用
      // advanceConversationRowsPartition 登记「只改尾轮」的分区（F17 步骤②）。
      // fixture 不经过真实 store，这里等价复现该登记步骤；基线步（分区不存在时）
      // 语义等同于跳过此调用——两阶段的差异正是本步的实现内容。
      // replace 模式整行替换尾轮 assistantText = row.upserted；append 模式 = row.delta。
      advanceConversationRowsPartition(current, next, [
        mode === "append"
          ? { op: "row.delta", rowId: tailRowId, path: "text", append: baseChunk }
          : { op: "row.upserted", row: next[next.length - 1]! },
      ]);
      const start = performance.now();
      flushSync(() => {
        setRows(next);
      });
      if (frame >= warmupFrames) durations.push(performance.now() - start);
      rowsRef.current = next;
      if (rafBetweenFrames) await settle();
    }
    await settle();
    return { durations, stats: mountedStats(), scroll: scrollState() };
  };

  const jumpTo = async (unitIndex: number, rowId: number) => {
    locate.current?.({ unitIndex, rowId });
    await settle();
    await settle();
    return { stats: mountedStats(), scroll: scrollState() };
  };

  const goBottom = async () => {
    back.current?.();
    await settle();
    await settle();
    return scrollState();
  };

  const setFind = async (value: string) => {
    flushSync(() => {
      setFindQuery(value);
    });
    await settle();
    return mountedStats();
  };

  window.__timelinePerf = {
    meta: {
      terminalTurns: initial.terminalTurns,
      totalRows: initial.rows.length,
      tailAssistantRowId: initial.tailAssistantRowId,
    },
    ready: async () => {
      await settle();
      return { stats: mountedStats(), scroll: scrollState() };
    },
    streamFrames,
    jumpTo,
    goBottom,
    setFind,
    mountedStats,
    scrollState,
  };

  return (
    <TooltipProvider>
      <ZodyIntlProvider initialLocale="zh-CN">
        <div className="flex h-dvh min-w-0 flex-col bg-background text-foreground">
          <div className="flex min-h-0 min-w-0 flex-1">
            <ConversationTimeline
              rows={rows}
              totalCount={rows.length}
              sessionKey="f17-perf-baseline"
              scrollMemoryKey={null}
              sessionPhase="running"
              conversationFindQuery={findQuery}
              scrollToBottomActionRef={back}
              scrollToQueryActionRef={locate}
              rowContext={{
                codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
                sessionId: "f17-perf-baseline",
                theme,
                workspacePath: "/fixture",
              }}
              bottomDock={
                <div className="h-16 bg-background" data-testid="fixture-composer">
                  Composer
                </div>
              }
            />
          </div>
        </div>
      </ZodyIntlProvider>
    </TooltipProvider>
  );
}

window.__timelineErrors = [];
window.addEventListener("error", (event) => {
  window.__timelineErrors.push(event.message);
});

createRoot(document.getElementById("root")!).render(<Fixture />);
