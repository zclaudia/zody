import { describe, expect, it } from "vitest";
import {
  clampOffset,
  redoHistory,
  undoHistory,
  updateHistory,
  zoomAtPoint,
  type History,
} from "@/image-preview-editor/geometry.js";

// F15（上游 a60ba6a7 image-preview-editor/geometry.ts）：几何与历史纯函数回归。
// 反例口径：模块落地前本文件因缺模块导入直接失败；落地后下列断言全部通过。

describe("clampOffset 平移夹紧", () => {
  it("缩放后仍小于视口（fit 图）时 offset 归零，不产生平移", () => {
    expect(
      clampOffset({ x: 40, y: -20 }, 1, { width: 200, height: 100 }, { width: 400, height: 300 }),
    ).toEqual({ x: 0, y: 0 });
  });

  it("溢出时 offset 被夹紧到 ±(溢出量/2)", () => {
    // image*scale = 800x600，viewport = 400x300 → 每轴各溢出 400/300，半宽 200/150。
    expect(
      clampOffset({ x: 999, y: -999 }, 2, { width: 400, height: 300 }, { width: 400, height: 300 }),
    ).toEqual({ x: 200, y: -150 });
  });

  it("单轴溢出时只夹紧溢出轴，另一轴保持 0", () => {
    const clamped = clampOffset(
      { x: 10, y: 50 },
      1,
      { width: 600, height: 100 },
      { width: 400, height: 300 },
    );
    expect(clamped).toEqual({ x: 10, y: 0 });
  });
});

describe("zoomAtPoint 指针锚定缩放", () => {
  it("缩放前后锚点在图上的位置不变（anchor 不漂移）", () => {
    const before = { scale: 1, offset: { x: -12, y: 8 } };
    const anchor = { x: 130, y: 77 };
    const after = zoomAtPoint(before, 2, anchor);
    expect(after.scale).toBe(2);
    // 视口坐标 p 在图坐标 = (p - offset) / scale；锚点必须映射到同一点。
    const map = (t: typeof before) => ({
      x: (anchor.x - t.offset.x) / t.scale,
      y: (anchor.y - t.offset.y) / t.scale,
    });
    expect(map(after)).toEqual(map(before));
  });

  it("offset=0 时缩放锚定在锚点自身方向上移动", () => {
    expect(zoomAtPoint({ scale: 1, offset: { x: 0, y: 0 } }, 2, { x: 10, y: 20 })).toEqual({
      scale: 2,
      offset: { x: -10, y: -20 },
    });
  });
});

describe("标注历史", () => {
  const empty: History<number> = { past: [], present: [1], future: [] };

  it("updateHistory 压栈当前态并清空 future", () => {
    expect(updateHistory({ past: [[1]], present: [2], future: [[3]] }, [2, 4])).toEqual({
      past: [[1], [2]],
      present: [2, 4],
      future: [],
    });
  });

  it("undo 取出上一态并把当前态压入 future", () => {
    expect(undoHistory({ past: [[1]], present: [2], future: [] })).toEqual({
      past: [],
      present: [1],
      future: [[2]],
    });
  });

  it("redo 恢复 future 首项", () => {
    expect(redoHistory({ past: [[1]], present: [2], future: [[3], [4]] })).toEqual({
      past: [[1], [2]],
      present: [3],
      future: [[4]],
    });
  });

  it("边界 no-op：past/future 为空时 undo/redo 原样返回", () => {
    expect(undoHistory(empty)).toBe(empty);
    expect(redoHistory(empty)).toBe(empty);
  });

  it("undo→redo 往返还原", () => {
    const updated = updateHistory(empty, [1, 2]);
    const undone = undoHistory(updated);
    expect(redoHistory(undone)).toEqual(updated);
  });
});
