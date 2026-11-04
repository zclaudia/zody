import type { MobileRemotePrepareReloadResult, MobileUiReleaseManifest } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import type {
  MobileUiReleaseCheckReason,
  MobileUiReleaseControllerOptions,
  MobileUiReleaseEnvironment,
  MobileUiReleaseObservation,
  MobileUiReleaseScheduler,
  MobileUiReleaseThrottleStore,
} from "../src/mobile-remote/mobileUiReleaseController.js";
import { createMobileUiReleaseController } from "../src/mobile-remote/mobileUiReleaseController.js";
import { createMobileUiRefreshGuardRegistry } from "../src/mobile-remote/mobileUiRefreshGuards.js";

const BASE_TIME = 1_800_000_000_000;
const RELEASE_A = "a".repeat(24);
const RELEASE_B = "b".repeat(24);
const RELEASE_C = "c".repeat(24);
const RELEASE_D = "d".repeat(24);

function manifest(
  releaseId: string,
  overrides: Partial<MobileUiReleaseManifest> = {},
): MobileUiReleaseManifest {
  return {
    schemaVersion: 1,
    releaseId,
    desktopVersion: "0.1.0",
    supportedBridgeVersions: [1],
    entry: "/assets/remote/index.html",
    assetDigest: "e".repeat(64),
    ...overrides,
  };
}

function observed(releaseId: string): MobileUiReleaseObservation {
  return { kind: "observed", manifest: manifest(releaseId) };
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeEnvironment implements MobileUiReleaseEnvironment {
  visible = true;
  online = true;
  readonly listeners = new Map<string, Set<() => void>>();

  isVisible(): boolean {
    return this.visible;
  }

  isOnline(): boolean {
    return this.online;
  }

  subscribe(event: string, listener: () => void): () => void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => {
      listeners.delete(listener);
    };
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }

  get listenerCount(): number {
    let count = 0;
    for (const listeners of this.listeners.values()) {
      count += listeners.size;
    }
    return count;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.emit("visibilitychange");
  }

  setOnline(online: boolean): void {
    this.online = online;
    this.emit(online ? "online" : "offline");
  }
}

class FakeScheduler implements MobileUiReleaseScheduler {
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  private nextId = 0;

  constructor(private readonly now: () => number) {}

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.now() + Math.max(0, delayMs), callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  get size(): number {
    return this.timers.size;
  }

  async advance(ms: number): Promise<void> {
    const target = this.now() + ms;
    while (true) {
      let nextId: number | undefined;
      let nextTimer: { at: number; callback: () => void } | undefined;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && (!nextTimer || timer.at < nextTimer.at)) {
          nextId = id;
          nextTimer = timer;
        }
      }
      if (nextId === undefined || !nextTimer) {
        break;
      }
      this.timers.delete(nextId);
      clock.nowMs = nextTimer.at;
      nextTimer.callback();
      await flushAsync();
    }
    clock.nowMs = target;
    await flushAsync();
  }
}

const clock = {
  nowMs: BASE_TIME,
  now(): number {
    return this.nowMs;
  },
};

interface Harness {
  controller: ReturnType<typeof createMobileUiReleaseController>;
  environment: FakeEnvironment;
  scheduler: FakeScheduler;
  fetchRelease: ReturnType<typeof vi.fn>;
  prepareReload: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  guards: ReturnType<typeof createMobileUiRefreshGuardRegistry>;
  setDocumentReleaseId(value: string | undefined): void;
  advance(ms: number): Promise<void>;
  lastAutoReloadAt(): number | undefined;
  options: MobileUiReleaseControllerOptions;
}

function createHarness(
  overrides: Partial<MobileUiReleaseControllerOptions> & {
    responses?: Array<MobileUiReleaseObservation | Promise<MobileUiReleaseObservation>>;
    documentReleaseId?: string | undefined;
    throttle?: MobileUiReleaseThrottleStore;
    startTime?: number;
  } = {},
): Harness {
  clock.nowMs = overrides.startTime ?? BASE_TIME;
  const environment = new FakeEnvironment();
  const scheduler = new FakeScheduler(() => clock.now());
  let documentReleaseId =
    "documentReleaseId" in overrides ? overrides.documentReleaseId : RELEASE_A;
  const responses = overrides.responses ? [...overrides.responses] : [observed(RELEASE_A)];
  const fetchRelease = vi.fn(async () => {
    const next = responses.length > 1 ? responses.shift()! : responses[0]!;
    return await next;
  });
  const prepareReload = vi.fn(
    (_sessionId: string, _releaseId: string): MobileRemotePrepareReloadResult => ({
      kind: "ready",
    }),
  );
  const reload = vi.fn();
  const guards = createMobileUiRefreshGuardRegistry();
  let lastAutoReloadAt: number | undefined;
  const throttle: MobileUiReleaseThrottleStore = overrides.throttle ?? {
    readLastAutoReloadAt: () => lastAutoReloadAt,
    writeLastAutoReloadAt: (value) => {
      lastAutoReloadAt = value;
    },
  };

  const options: MobileUiReleaseControllerOptions = {
    sessionId: "session-1",
    bridgeVersion: 1,
    readCurrentReleaseId: () => documentReleaseId,
    fetchRelease,
    prepareReload,
    reload,
    guards,
    clock,
    scheduler,
    environment,
    throttleStore: throttle,
    ...overrides,
  };
  const controller = createMobileUiReleaseController(options);
  return {
    controller,
    environment,
    scheduler,
    fetchRelease,
    prepareReload,
    reload,
    guards,
    setDocumentReleaseId(value) {
      documentReleaseId = value;
    },
    advance: (ms) => scheduler.advance(ms),
    lastAutoReloadAt: () => throttle.readLastAutoReloadAt(),
    options,
  };
}

async function checkNow(
  controller: ReturnType<typeof createMobileUiReleaseController>,
  reason: MobileUiReleaseCheckReason = "poll",
): Promise<void> {
  await controller.checkNow(reason);
  await flushAsync();
}

describe("MobileUiReleaseController 二次确认", () => {
  it("同一新 releaseId 至少间隔 5 秒二次确认后才 reload", async () => {
    const harness = createHarness({ responses: [observed(RELEASE_B), observed(RELEASE_B)] });

    await checkNow(harness.controller);
    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.controller.getStatus()).toMatchObject({
      kind: "pending-confirmation",
      releaseId: RELEASE_B,
    });

    await harness.advance(4_999);
    expect(harness.reload).not.toHaveBeenCalled();

    await harness.advance(1);
    expect(harness.reload).toHaveBeenCalledOnce();
    expect(harness.reload).toHaveBeenCalledWith({
      releaseId: RELEASE_B,
      manifest: manifest(RELEASE_B),
    });
    expect(harness.prepareReload).toHaveBeenCalledWith("session-1", RELEASE_B);
    expect(harness.controller.getStatus()).toEqual({
      kind: "reloading",
      releaseId: RELEASE_B,
      manual: false,
    });
  });

  it("二次确认期间切换 release 时重新开始 5 秒确认，不刷新旧目标", async () => {
    const harness = createHarness({
      responses: [observed(RELEASE_B), observed(RELEASE_C), observed(RELEASE_C)],
    });

    await checkNow(harness.controller);
    await harness.advance(2_000);
    // 滚动发布：确认前观察到 C，B 的目标被丢弃。
    await checkNow(harness.controller);
    expect(harness.controller.getStatus()).toMatchObject({
      kind: "pending-confirmation",
      releaseId: RELEASE_C,
    });

    await harness.advance(4_999);
    expect(harness.reload).not.toHaveBeenCalled();
    await harness.advance(1);
    expect(harness.reload).toHaveBeenCalledOnce();
    expect(harness.reload.mock.calls[0]![0]).toMatchObject({ releaseId: RELEASE_C });
  });

  it("服务端回到当前文档 release（升级回滚）时取消待确认目标", async () => {
    const harness = createHarness({ responses: [observed(RELEASE_B), observed(RELEASE_A)] });

    await checkNow(harness.controller);
    expect(harness.controller.getStatus().kind).toBe("pending-confirmation");

    await harness.advance(5_000);
    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.controller.getStatus()).toMatchObject({ kind: "up-to-date" });
  });

  it("reload 前重新请求发现目标已变化时重新进入确认流程", async () => {
    const harness = createHarness({
      // 首次观察 B；5 秒确认请求返回 C；C 的二次确认仍返回 C。
      responses: [observed(RELEASE_B), observed(RELEASE_C), observed(RELEASE_C)],
    });

    await checkNow(harness.controller);
    await harness.advance(5_000);

    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.controller.getStatus()).toMatchObject({
      kind: "pending-confirmation",
      releaseId: RELEASE_C,
    });

    await harness.advance(5_000);
    expect(harness.reload).toHaveBeenCalledOnce();
    expect(harness.reload.mock.calls[0]![0]).toMatchObject({ releaseId: RELEASE_C });
  });
});

describe("MobileUiReleaseController 生命周期与迟到响应", () => {
  it("dispose 后迟到响应不刷新，并移除所有监听与计时器", async () => {
    let resolveFetch: ((value: MobileUiReleaseObservation) => void) | undefined;
    const pending = new Promise<MobileUiReleaseObservation>((resolve) => {
      resolveFetch = resolve;
    });
    const harness = createHarness({ responses: [pending] });
    harness.controller.start();

    const checking = checkNow(harness.controller);
    expect(harness.controller.getStatus().kind).toBe("checking");

    harness.controller.dispose();
    resolveFetch!(observed(RELEASE_B));
    await checking;
    await flushAsync();

    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.controller.getStatus()).toEqual({ kind: "disposed" });
    expect(harness.environment.listenerCount).toBe(0);
    expect(harness.scheduler.size).toBe(0);

    harness.environment.setVisible(true);
    harness.environment.setOnline(true);
    await flushAsync();
    expect(harness.fetchRelease).toHaveBeenCalledOnce();
  });

  it("后台时停止轮询和事件检查，回前台立即检查", async () => {
    const harness = createHarness({ responses: [observed(RELEASE_A)] });
    harness.controller.start();
    expect(harness.scheduler.size).toBe(1);

    harness.environment.setVisible(false);
    expect(harness.scheduler.size).toBe(0);
    const callsWhileHidden = harness.fetchRelease.mock.calls.length;

    await checkNow(harness.controller);
    expect(harness.fetchRelease).toHaveBeenCalledTimes(callsWhileHidden);

    harness.environment.setVisible(true);
    await flushAsync();
    expect(harness.fetchRelease.mock.calls.length).toBe(callsWhileHidden + 1);
    expect(harness.scheduler.size).toBe(1);
  });

  it("prepareReload 等待期间进入后台时不 reload", async () => {
    let resolveNative: ((value: MobileRemotePrepareReloadResult) => void) | undefined;
    const harness = createHarness({ responses: [observed(RELEASE_B), observed(RELEASE_B)] });
    harness.prepareReload.mockReturnValue(
      new Promise<MobileRemotePrepareReloadResult>((resolve) => {
        resolveNative = resolve;
      }),
    );
    harness.controller.start();

    await checkNow(harness.controller);
    await harness.advance(5_000);
    // 原生 veto 尚未返回时页面进入后台。
    harness.environment.setVisible(false);
    resolveNative!({ kind: "ready" });
    await flushAsync();
    await flushAsync();

    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("pagehide 停止检查，online 恢复后重新检查并安排轮询", async () => {
    const harness = createHarness({ responses: [observed(RELEASE_A)] });
    harness.controller.start();
    harness.environment.emit("pagehide");
    expect(harness.scheduler.size).toBe(0);
    const calls = harness.fetchRelease.mock.calls.length;

    harness.environment.setOnline(true);
    await flushAsync();
    expect(harness.fetchRelease.mock.calls.length).toBe(calls + 1);
    expect(harness.scheduler.size).toBe(1);
  });

  it("业务重连触发立即检查", async () => {
    const harness = createHarness({ responses: [observed(RELEASE_A)] });
    harness.controller.notifyBusinessReconnect();
    await flushAsync();
    expect(harness.fetchRelease).toHaveBeenCalledOnce();
  });

  it("前台每 60 秒轮询一次，offline 停止计时，online 立即检查", async () => {
    const harness = createHarness({ responses: [observed(RELEASE_A)] });
    harness.controller.start();
    expect(harness.fetchRelease).not.toHaveBeenCalled();

    await harness.advance(60_000);
    expect(harness.fetchRelease).toHaveBeenCalledOnce();
    // 一次轮询结束后继续安排下一次前台轮询。
    await harness.advance(60_000);
    expect(harness.fetchRelease).toHaveBeenCalledTimes(2);

    harness.environment.setOnline(false);
    expect(harness.scheduler.size).toBe(0);
    await harness.advance(120_000);
    expect(harness.fetchRelease).toHaveBeenCalledTimes(2);

    harness.environment.setOnline(true);
    await flushAsync();
    expect(harness.fetchRelease).toHaveBeenCalledTimes(3);
  });
});

describe("MobileUiReleaseController 失败保留当前文档", () => {
  it.each([
    ["network-error", "network-error"],
    ["rate-limited", "rate-limited"],
    ["server-error", "server-error"],
    ["login-invalid", "login-invalid"],
    ["invalid-manifest", "invalid-manifest"],
  ] as const)("%s 不刷新并保留候选文档", async (reason, expected) => {
    const harness = createHarness({
      responses: [{ kind: "failed", reason, status: 503 }],
    });

    await checkNow(harness.controller);
    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.controller.getStatus()).toMatchObject({
      kind: "check-failed",
      reason: expected,
    });
  });

  it("确认请求失败时不刷新，恢复后的下一次观察仍可完成确认", async () => {
    const harness = createHarness({
      responses: [
        observed(RELEASE_B),
        { kind: "failed", reason: "network-error" },
        observed(RELEASE_B),
        observed(RELEASE_B),
      ],
    });

    await checkNow(harness.controller);
    await harness.advance(5_000);
    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.controller.getStatus()).toMatchObject({ kind: "check-failed" });

    await checkNow(harness.controller, "online");
    // 已有候选超过 5 秒，本次观察可作为二次确认。
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("无有效基线只诊断不刷新，手动安全刷新同样拒绝", async () => {
    const harness = createHarness({
      documentReleaseId: undefined,
      responses: [observed(RELEASE_B)],
    });

    await checkNow(harness.controller);
    expect(harness.fetchRelease).not.toHaveBeenCalled();
    expect(harness.controller.getStatus()).toEqual({
      kind: "invalid-baseline",
      reason: "missing",
    });

    await harness.controller.requestSafeReload();
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("当前 HTML meta 非法时不刷新", async () => {
    const harness = createHarness({
      documentReleaseId: "0123456789ABCDEF01234567",
      responses: [observed(RELEASE_B)],
    });

    await checkNow(harness.controller);
    expect(harness.controller.getStatus()).toEqual({
      kind: "invalid-baseline",
      reason: "invalid",
    });
    expect(harness.reload).not.toHaveBeenCalled();
  });
});

describe("MobileUiReleaseController 一分钟自动刷新限频", () => {
  it("60 秒内不重复自动刷新，跨页面用共享 throttle 阻止升级/回滚循环", async () => {
    let lastReload: number | undefined;
    const throttle: MobileUiReleaseThrottleStore = {
      readLastAutoReloadAt: () => lastReload,
      writeLastAutoReloadAt: (value) => {
        lastReload = value;
      },
    };

    const first = createHarness({
      throttle,
      responses: [observed(RELEASE_B), observed(RELEASE_B)],
    });
    await checkNow(first.controller);
    await first.advance(5_000);
    expect(first.reload).toHaveBeenCalledOnce();
    expect(lastReload).toBe(BASE_TIME + 5_000);

    // 模拟新页面：文档仍是 A，服务端仍返回 B；限频记录来自 sessionStorage。
    const second = createHarness({
      throttle,
      startTime: BASE_TIME + 20_000,
      responses: [observed(RELEASE_B), observed(RELEASE_B)],
    });
    await checkNow(second.controller);
    await second.advance(5_000);
    expect(second.reload).not.toHaveBeenCalled();
    expect(second.controller.getStatus()).toMatchObject({
      kind: "ready",
      releaseId: RELEASE_B,
      retryAt: BASE_TIME + 65_000,
    });

    await second.advance(40_000);
    await checkNow(second.controller, "online");
    expect(second.reload).toHaveBeenCalledOnce();
  });
});

describe("MobileUiReleaseController refresh guards 与手动安全刷新", () => {
  it("guard 阻塞时自动检查不 reload，并返回稳定原因", async () => {
    const harness = createHarness({ responses: [observed(RELEASE_B), observed(RELEASE_B)] });
    harness.guards.register({ id: "composer", getBlockReason: () => "composer-draft" });

    await checkNow(harness.controller);
    await harness.advance(5_000);

    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.prepareReload).not.toHaveBeenCalled();
    expect(harness.controller.getStatus()).toEqual({
      kind: "ready",
      releaseId: RELEASE_B,
      desktopVersion: "0.1.0",
      blockedReasons: ["composer-draft"],
    });
  });

  it("手动安全刷新复用同一 guard，不绕过未提交草稿", async () => {
    const harness = createHarness({ responses: [observed(RELEASE_B), observed(RELEASE_B)] });
    const releaseGuard = harness.guards.register({
      id: "composer",
      getBlockReason: () => "composer-draft",
    });

    await checkNow(harness.controller);
    await harness.advance(5_000);

    const blocked = await harness.controller.requestSafeReload();
    expect(blocked).toEqual({
      kind: "blocked",
      releaseId: RELEASE_B,
      reasons: ["composer-draft"],
    });
    expect(harness.reload).not.toHaveBeenCalled();

    releaseGuard();
    const result = await harness.controller.requestSafeReload();
    expect(result).toEqual({ kind: "reloaded", releaseId: RELEASE_B });
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("手动安全刷新不绕过 5 秒二次确认", async () => {
    const harness = createHarness({ responses: [observed(RELEASE_B), observed(RELEASE_B)] });
    await checkNow(harness.controller);

    const early = await harness.controller.requestSafeReload();
    expect(early.kind).toBe("pending-confirmation");
    expect(harness.reload).not.toHaveBeenCalled();

    await harness.advance(5_000);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("等待重新请求 release 期间开始的保存操作会在 reload 前再次阻止", async () => {
    let resolveFetch!: (value: MobileUiReleaseObservation) => void;
    const pendingFetch = new Promise<MobileUiReleaseObservation>((resolve) => {
      resolveFetch = resolve;
    });
    // 第一次：初始 check 取得候选；第二次：apply 首次 fetch 立即返回；第三次是被延迟的
    // apply 复核请求；最后一项供恢复后的手动刷新使用。
    const harness = createHarness({
      responses: [observed(RELEASE_B), observed(RELEASE_B), pendingFetch, observed(RELEASE_B)],
    });
    let fileOperation: "file-operation" | null = null;
    harness.guards.register({
      id: "file",
      getBlockReason: () => fileOperation,
    });

    await checkNow(harness.controller);
    await harness.advance(5_000);
    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.prepareReload).not.toHaveBeenCalled();

    // release 复核在途时用户开始保存文件：第一次 guard 已经通过，第二次必须拦住。
    fileOperation = "file-operation";
    resolveFetch(observed(RELEASE_B));
    await flushAsync();

    expect(harness.reload).not.toHaveBeenCalled();
    // 第二次 guard 在 native prepareReload 之后执行；此时 native 已返回 ready，
    // 但保存操作仍必须阻止 reload。
    expect(harness.prepareReload).toHaveBeenCalledOnce();
    expect(harness.controller.getStatus()).toMatchObject({
      kind: "ready",
      releaseId: RELEASE_B,
      blockedReasons: ["file-operation"],
    });

    fileOperation = null;
    const result = await harness.controller.requestSafeReload();
    expect(result).toEqual({ kind: "reloaded", releaseId: RELEASE_B });
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("等待原生 prepareReload 期间开始的保存操作会在 reload 前再次阻止", async () => {
    let resolveNative!: (value: MobileRemotePrepareReloadResult) => void;
    const pendingNative = new Promise<MobileRemotePrepareReloadResult>((resolve) => {
      resolveNative = resolve;
    });
    const harness = createHarness({
      responses: [observed(RELEASE_B), observed(RELEASE_B), observed(RELEASE_B)],
    });
    harness.prepareReload.mockImplementation(() => pendingNative);
    let fileOperation: "file-operation" | null = null;
    harness.guards.register({
      id: "file",
      getBlockReason: () => fileOperation,
    });

    await checkNow(harness.controller);
    await harness.advance(5_000);
    expect(harness.prepareReload).toHaveBeenCalledOnce();
    expect(harness.reload).not.toHaveBeenCalled();

    // 原生 veto 检查返回 ready 前开始保存：native ready 之后仍需重新评估 guard。
    fileOperation = "file-operation";
    resolveNative({ kind: "ready" });
    await flushAsync();

    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.controller.getStatus()).toMatchObject({
      kind: "ready",
      releaseId: RELEASE_B,
      blockedReasons: ["file-operation"],
    });

    fileOperation = null;
    harness.prepareReload.mockReturnValue({ kind: "ready" });
    const result = await harness.controller.requestSafeReload();
    expect(result).toEqual({ kind: "reloaded", releaseId: RELEASE_B });
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("多个 guard 原因稳定返回，未知状态默认阻塞", async () => {
    const harness = createHarness({ responses: [observed(RELEASE_B), observed(RELEASE_B)] });
    harness.guards.register({ id: "file", getBlockReason: () => "file-operation" });
    harness.guards.register({
      id: "mystery",
      getBlockReason: () => "future-reason" as never,
    });

    await checkNow(harness.controller);
    await harness.advance(5_000);

    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.controller.getStatus()).toMatchObject({
      kind: "ready",
      blockedReasons: ["file-operation", "unknown-guard-state"],
    });
  });
});

describe("MobileUiReleaseController native prepareReload veto", () => {
  it.each([
    ["stale-session", "stale-session"],
    ["native-busy", "native-busy"],
    ["unsupported", "unsupported"],
  ] as const)("%s 时不 reload", async (nativeKind, expectedVeto) => {
    const harness = createHarness({ responses: [observed(RELEASE_B), observed(RELEASE_B)] });
    harness.prepareReload.mockReturnValue({ kind: nativeKind });

    await checkNow(harness.controller);
    await harness.advance(5_000);

    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.controller.getStatus()).toEqual({
      kind: "ready",
      releaseId: RELEASE_B,
      desktopVersion: "0.1.0",
      blockedReasons: [],
      nativeVeto: expectedVeto,
    });
  });

  it("prepareReload 抛错按 unsupported 处理，不刷新", async () => {
    const harness = createHarness({ responses: [observed(RELEASE_B), observed(RELEASE_B)] });
    harness.prepareReload.mockImplementation(() => {
      throw new Error("bridge unavailable");
    });

    await checkNow(harness.controller);
    await harness.advance(5_000);
    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.controller.getStatus()).toMatchObject({
      kind: "ready",
      nativeVeto: "unsupported",
    });
  });

  it("prepareReload 期间当前文档已变化时放弃 reload", async () => {
    const harness = createHarness({ responses: [observed(RELEASE_B), observed(RELEASE_B)] });
    harness.prepareReload.mockImplementation(() => {
      harness.setDocumentReleaseId(RELEASE_B);
      return { kind: "ready" };
    });

    await checkNow(harness.controller);
    await harness.advance(5_000);

    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.controller.getStatus()).toMatchObject({ kind: "up-to-date" });
  });
});

describe("MobileUiReleaseController bridge 兼容性与状态订阅", () => {
  it("运行期服务端回到不兼容当前 bridge 的 release 时不 reload", async () => {
    const harness = createHarness({
      responses: [
        {
          kind: "observed",
          manifest: manifest(RELEASE_B, { supportedBridgeVersions: [2] }),
        },
      ],
    });

    await checkNow(harness.controller);
    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.controller.getStatus()).toMatchObject({
      kind: "incompatible",
      releaseId: RELEASE_B,
      supportedBridgeVersions: [2],
    });
  });

  it("状态变化通知订阅者，取消订阅后不再收到", async () => {
    const harness = createHarness({ responses: [observed(RELEASE_B)] });
    const statuses: string[] = [];
    const unsubscribe = harness.controller.subscribe((status) => {
      statuses.push(status.kind);
    });

    await checkNow(harness.controller);
    expect(statuses).toContain("checking");
    expect(statuses).toContain("pending-confirmation");

    const count = statuses.length;
    unsubscribe();
    harness.controller.dispose();
    expect(statuses).toHaveLength(count);
  });
});
