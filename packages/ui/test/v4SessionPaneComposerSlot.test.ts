import { describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationComposerProps } from "@/v4/ConversationComposer.js";
import {
  composerSnapshotSemanticsEqual,
  createComposerSlotStore,
} from "@/v4/SessionPane.js";

/** 只覆盖 composerSnapshotSemanticsEqual 的读取面；store 只按引用比较其余 props。 */
function snapshot(
  overrides: Record<string, unknown> = {},
): ConversationSnapshot {
  return {
    sessionId: "session-1",
    inputRouting: { mode: "startNow" },
    control: { canStop: false, phase: "idle" },
    rows: { totalCount: 10 },
    config: { followupMode: "enqueue" },
    usage: { cumulative: { inputTokens: 1 } },
    backgroundWorks: [],
    queue: { items: [] },
    ...overrides,
  } as unknown as ConversationSnapshot;
}

function composerProps(
  overrides: Partial<ConversationComposerProps> & {
    snapshot?: ConversationSnapshot | null;
  } = {},
): ConversationComposerProps {
  return {
    snapshot: overrides.snapshot ?? null,
    composerDraft: { text: "", updatedAt: 0 },
    ...overrides,
  } as unknown as ConversationComposerProps;
}

describe("composerSnapshotSemanticsEqual（perf-5 语义门控）", () => {
  it("同为 null 视为相等，单边 null 不相等", () => {
    expect(composerSnapshotSemanticsEqual(null, null)).toBe(true);
    expect(composerSnapshotSemanticsEqual(null, snapshot())).toBe(false);
    expect(composerSnapshotSemanticsEqual(snapshot(), null)).toBe(false);
  });

  it("同一引用直接相等", () => {
    const snap = snapshot();
    expect(composerSnapshotSemanticsEqual(snap, snap)).toBe(true);
  });

  it("流式帧全新引用但 composer 语义字段未变 → 相等", () => {
    // JSON 反序列化语义：嵌套对象全部换新引用。
    expect(composerSnapshotSemanticsEqual(snapshot(), snapshot())).toBe(true);
  });

  it("渲染路径字段变化（phase / canStop / routing / totalCount / followupMode）→ 不相等", () => {
    const base = snapshot();
    expect(
      composerSnapshotSemanticsEqual(
        base,
        snapshot({ control: { canStop: false, phase: "running" } }),
      ),
    ).toBe(false);
    expect(
      composerSnapshotSemanticsEqual(
        base,
        snapshot({ control: { canStop: true, phase: "idle" } }),
      ),
    ).toBe(false);
    expect(
      composerSnapshotSemanticsEqual(
        base,
        snapshot({ inputRouting: { mode: "reject" } }),
      ),
    ).toBe(false);
    expect(
      composerSnapshotSemanticsEqual(
        base,
        snapshot({ rows: { totalCount: 11 } }),
      ),
    ).toBe(false);
    expect(
      composerSnapshotSemanticsEqual(
        base,
        snapshot({ config: { followupMode: "startNow" } }),
      ),
    ).toBe(false);
  });

  it("usage / backgroundWorks / config / sharedContextImport 值变化 → 不相等", () => {
    const base = snapshot();
    expect(
      composerSnapshotSemanticsEqual(
        base,
        snapshot({ usage: { cumulative: { inputTokens: 2 } } }),
      ),
    ).toBe(false);
    expect(
      composerSnapshotSemanticsEqual(
        base,
        snapshot({ backgroundWorks: [{ workId: "w1" }] }),
      ),
    ).toBe(false);
    expect(
      composerSnapshotSemanticsEqual(
        base,
        snapshot({ config: { followupMode: "enqueue", thought: "high" } }),
      ),
    ).toBe(false);
    expect(
      composerSnapshotSemanticsEqual(
        base,
        snapshot({ sharedContextImport: { version: 2 } }),
      ),
    ).toBe(false);
  });

  it("queue 只按 queueItemId 签名比对：同 id 新对象相等，id 增删不相等", () => {
    const base = snapshot({ queue: { items: [{ queueItemId: "q1" }] } });
    // delta 帧重建 queue 数组但条目 id 相同 → 相等。
    expect(
      composerSnapshotSemanticsEqual(
        base,
        snapshot({ queue: { items: [{ queueItemId: "q1" }] } }),
      ),
    ).toBe(true);
    expect(
      composerSnapshotSemanticsEqual(
        base,
        snapshot({
          queue: { items: [{ queueItemId: "q1" }, { queueItemId: "q2" }] },
        }),
      ),
    ).toBe(false);
    expect(
      composerSnapshotSemanticsEqual(
        base,
        snapshot({ queue: { items: [{ queueItemId: "q9" }] } }),
      ),
    ).toBe(false);
  });
});

describe("createComposerSlotStore（perf-3/perf-5 插槽 store）", () => {
  it("首次 set 版本递增；同引用重复 set 不递增", async () => {
    const store = createComposerSlotStore();
    const listener = vi.fn();
    store.subscribe(listener);

    expect(store.getVersion()).toBe(0);
    const props = composerProps({ snapshot: snapshot() });
    store.set(props);
    expect(store.getVersion()).toBe(1);

    store.set(props);
    expect(store.getVersion()).toBe(1);
    // 通知在微任务合并，且没有变化时不触发。
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("流式帧：snapshot 新引用但语义未变、其余 props 引用不变 → 不下发（perf-5 核心）", () => {
    const store = createComposerSlotStore();
    const composerDraft = { text: "", updatedAt: 1 };
    store.set(composerProps({ snapshot: snapshot(), composerDraft }));

    // 新渲染帧：所有值引用不变，只有 snapshot 是 JSON 重建的新对象。
    store.set(composerProps({ snapshot: snapshot(), composerDraft }));

    expect(store.getVersion()).toBe(1);
  });

  it("击键：composerDraft 引用变化 → 立即递增版本（perf-3 核心）", () => {
    const store = createComposerSlotStore();
    const snap = snapshot();
    store.set(composerProps({ snapshot: snap }));
    store.set(
      composerProps({
        snapshot: snap,
        composerDraft: { text: "a", updatedAt: 2 },
      }),
    );

    expect(store.getVersion()).toBe(2);
  });

  it("snapshot 语义字段变化 → 递增并下发最新 props", () => {
    const store = createComposerSlotStore();
    const composerDraft = { text: "", updatedAt: 1 };
    store.set(composerProps({ snapshot: snapshot(), composerDraft }));

    const changed = snapshot({ control: { canStop: true, phase: "running" } });
    store.set(composerProps({ snapshot: changed, composerDraft }));

    expect(store.getVersion()).toBe(2);
    expect(store.read().snapshot).toBe(changed);
  });

  it("非 snapshot props 引用变化（如 error 对象）→ 递增", () => {
    const store = createComposerSlotStore();
    const snap = snapshot();
    const composerDraft = { text: "", updatedAt: 1 };
    store.set(composerProps({ snapshot: snap, composerDraft }));

    store.set(
      composerProps({
        snapshot: snap,
        composerDraft,
        error: { code: "E", message: "boom" },
      }),
    );

    expect(store.getVersion()).toBe(2);
  });

  it("read() 返回最近一次下发的 props；语义未变的帧不更新下发对象", () => {
    const store = createComposerSlotStore();
    expect(() => store.read()).toThrow();

    const composerDraft = { text: "", updatedAt: 1 };
    const first = composerProps({ snapshot: snapshot(), composerDraft });
    store.set(first);
    expect(store.read()).toBe(first);

    // 流式帧：snapshot 新引用但语义未变、其余 props 引用相同 → committed 保持旧引用，
    // dock 内容重建触发 boundary 重渲染时 ConversationComposer 的 memo 才能短路。
    store.set(composerProps({ snapshot: snapshot(), composerDraft }));
    expect(store.read()).toBe(first);
  });

  it("微任务合并通知：一帧内多次 set 只通知一次", async () => {
    const store = createComposerSlotStore();
    const listener = vi.fn();
    store.subscribe(listener);

    const snap = snapshot();
    store.set(composerProps({ snapshot: snap }));
    store.set(
      composerProps({
        snapshot: snap,
        composerDraft: { text: "a", updatedAt: 1 },
      }),
    );

    // set 内版本已同步递增，但监听器要等微任务。
    expect(store.getVersion()).toBe(2);
    expect(listener).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe 后不再收到通知", async () => {
    const store = createComposerSlotStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();

    store.set(composerProps({ snapshot: snapshot() }));
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });
});
