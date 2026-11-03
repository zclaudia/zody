import { mkdtempSync, rmSync, symlinkSync, type FSWatcher, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFileWatcherService,
  resolveFileWatchChangedPath,
} from "../src/fileWatcher/fileWatcherService.js";
import { collectServiceMemoryDiagnostics } from "../src/memoryDiagnostics.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-file-watcher-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** 可控的 fs.watch 替身：emit 直接驱动 listener，close 记录关闭状态 */
class FakeWatchHandle {
  closed = false;
  constructor(
    private readonly listener: (eventType: string, fileName: string | Buffer | null) => void,
  ) {}
  emit(eventType: string, fileName: string | Buffer | null = null): void {
    if (this.closed) return;
    this.listener(eventType, fileName);
  }
  on(_event: string, _listener: (error: Error) => void): this {
    return this;
  }
  close(): void {
    this.closed = true;
  }
}

function makeFakeWatchFactory(): {
  factory: typeof import("node:fs").watch;
  handles: FakeWatchHandle[];
} {
  const handles: FakeWatchHandle[] = [];
  const factory = ((
    _path: string,
    _options: unknown,
    listener: (eventType: string, fileName: string | Buffer | null) => void,
  ) => {
    const handle = new FakeWatchHandle(listener);
    handles.push(handle);
    return handle as unknown as FSWatcher;
  }) as unknown as typeof import("node:fs").watch;
  return { factory, handles };
}

/** 构造 stat 身份替身：实现只消费 dev/ino/isDirectory */
function makeFakeStats(identity: { dev: number; ino: number }): Stats {
  return {
    dev: identity.dev,
    ino: identity.ino,
    isDirectory: () => true,
  } as unknown as Stats;
}

describe("fileWatcherService", () => {
  it("resolves a changed child path and keeps unknown watcher paths conservative", () => {
    const watchedPath = resolve("workspace", "slides");
    // 修复原因：旧断言写死 POSIX 路径；产品使用宿主 path.resolve，Windows 会返回盘符与反斜杠。
    expect(resolveFileWatchChangedPath(watchedPath, "deck.pptx")).toBe(
      resolve(watchedPath, "deck.pptx"),
    );
    expect(resolveFileWatchChangedPath(watchedPath, null)).toBeUndefined();
  });

  it("treats a stale watcher subscription as a no-op event", async () => {
    const service = createFileWatcherService();
    const dir = makeTempDir();
    const { id } = await service.watch({ path: dir });

    await service.unwatch({ id });

    let fired = false;
    const subscription = service.onDynamicChange(id)(() => {
      fired = true;
    });
    subscription.dispose();

    expect(fired).toBe(false);
  });

  it("disposes all active watchers and keeps stale ids no-op", async () => {
    const service = createFileWatcherService();
    const firstDir = makeTempDir();
    const secondDir = makeTempDir();
    const first = await service.watch({ path: firstDir });
    const second = await service.watch({ path: secondDir });

    service.disposeAll();
    await service.unwatch({ id: first.id });
    await service.unwatch({ id: second.id });

    let fired = false;
    const firstSubscription = service.onDynamicChange(first.id)(() => {
      fired = true;
    });
    const secondSubscription = service.onDynamicChange(second.id)(() => {
      fired = true;
    });
    firstSubscription.dispose();
    secondSubscription.dispose();

    expect(fired).toBe(false);
  });

  it("持续写入低于防抖间隔时由 max-wait 定时器强制刷新（upstream a60ba6a7）", async () => {
    const { factory, handles } = makeFakeWatchFactory();
    const service = createFileWatcherService({
      watchFactory: factory,
      debounceMs: 5_000,
      maxWaitMs: 120,
    });
    const dir = makeTempDir();
    const { id } = await service.watch({ path: dir });
    const events: { dirPath: string; changedPath?: string }[] = [];
    const subscription = service.onDynamicChange(id)((event) => events.push(event));

    // 反例（修复前）：旧实现只有 trailing 防抖，事件间隔小于 debounceMs 时
    // 定时器被无限重置，订阅者在写入期间收不到任何刷新。
    for (let i = 0; i < 6; i += 1) {
      handles[0].emit("change", "a.txt");
      await sleep(40);
    }

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].dirPath).toBe(dir);
    subscription.dispose();
    service.disposeAll();
  });

  it("rename 收口只做一次身份校验，目录移走后发最终刷新并关闭 watcher（upstream a60ba6a7）", async () => {
    const { factory, handles } = makeFakeWatchFactory();
    let statCalls = 0;
    // 模拟目录被移走：watch 时身份 A，第一次收口后换为身份 B
    let currentStats = makeFakeStats({ dev: 1, ino: 100 });
    const statPath = async () => {
      statCalls += 1;
      return currentStats;
    };
    const service = createFileWatcherService({
      watchFactory: factory,
      statPath,
      debounceMs: 20,
      maxWaitMs: 5_000,
    });
    const dir = makeTempDir();
    const { id } = await service.watch({ path: dir });
    const events: { dirPath: string; changedPath?: string }[] = [];
    const subscription = service.onDynamicChange(id)((event) => events.push(event));

    // 同一窗口内多个 rename 事件只触发一次 stat 身份校验（收口一次）；
    // 均指向同一明确路径时该路径仍透传（null 事件会按保守语义省略 changedPath）
    handles[0].emit("rename", "moved.txt");
    handles[0].emit("rename", "moved.txt");
    await sleep(80);

    // 身份未变：rename 事件正常透传 changedPath，watcher 存活
    expect(statCalls).toBe(2); // watch 初始化 1 次 + 收口校验 1 次
    expect(events).toHaveLength(1);
    expect(events[0].changedPath).toBe(resolve(dir, "moved.txt"));
    expect(handles[0].closed).toBe(false);

    // 目录被移走：下一次 rename 收口发现身份变化
    currentStats = makeFakeStats({ dev: 1, ino: 999 });
    handles[0].emit("rename", null);
    await sleep(80);

    // 反例（修复前）：旧实现无身份校验，watcher 永不因目录移走关闭，
    // 旧 inode 上的事件会继续冒充原路径事件。
    expect(statCalls).toBe(3);
    expect(events).toHaveLength(2);
    expect(events[1].changedPath).toBeUndefined();
    expect(handles[0].closed).toBe(true);

    // 失效后即使替身再 emit 也不应产生新事件
    handles[0].emit("change", "stale.txt");
    await sleep(60);
    expect(events).toHaveLength(2);
    subscription.dispose();
  });

  it("symlink 指向新目标后按 stat 身份判定失效（真实 stat 跟随链接，upstream a60ba6a7）", async () => {
    const { factory, handles } = makeFakeWatchFactory();
    const service = createFileWatcherService({
      watchFactory: factory,
      debounceMs: 20,
      maxWaitMs: 5_000,
    });
    const targetA = makeTempDir();
    const targetB = makeTempDir();
    const linkPath = join(makeTempDir(), "link");
    symlinkSync(targetA, linkPath);

    const { id } = await service.watch({ path: linkPath });
    const events: { dirPath: string; changedPath?: string }[] = [];
    const subscription = service.onDynamicChange(id)((event) => events.push(event));

    // 目标未替换：rename 收口身份校验通过，正常刷新
    handles[0].emit("rename", null);
    await sleep(80);
    expect(events).toHaveLength(1);
    expect(handles[0].closed).toBe(false);

    // 目标替换为另一个目录：路径不变但 stat（跟随符号链接）解析到新身份
    rmSync(linkPath);
    symlinkSync(targetB, linkPath);
    handles[0].emit("rename", null);
    await sleep(80);

    // 反例（修复前）：旧实现按路径判断 watcher 仍有效，不发送最终刷新也不关闭。
    expect(events).toHaveLength(2);
    expect(events[1].changedPath).toBeUndefined();
    expect(handles[0].closed).toBe(true);
    subscription.dispose();
  });
});

describe("fileWatcher memory diagnostics", () => {
  it("注册 open watcher 计数，disposeAll 后注销", async () => {
    const service = createFileWatcherService();
    expect(collectServiceMemoryDiagnostics()["fileWatcher.open"]).toBe(0);
    await service.watch({ path: makeTempDir() });
    expect(collectServiceMemoryDiagnostics()["fileWatcher.open"]).toBe(1);
    service.disposeAll();
    expect(collectServiceMemoryDiagnostics()["fileWatcher.open"]).toBeUndefined();
  });
});
