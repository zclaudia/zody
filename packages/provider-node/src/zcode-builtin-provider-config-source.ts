import { watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ProviderConfigLayerSnapshot, ProviderSource } from "@zody/provider";
import { atomicWritePrivateTextFile, withFileLock } from "@zody/shared/node";
import {
  decodeZCodeBuiltinRelease,
  encodeZCodeBuiltinRelease,
  serializeZCodeBuiltinRelease,
  type ZCodeBuiltinRelease,
} from "./zcode-builtin-release.js";

export interface NodeZCodeBuiltinProviderConfigSourceOptions {
  readonly bundledFilePath: string;
  readonly activeFilePath?: string;
  readonly watch?: boolean;
}

export type ApplyZCodeBuiltinReleaseResult = "updated" | "unchanged" | "stale";

/** Bundled、Active/LKG 与 Remote 共用同一 Release，并最终发布为现有 Config Snapshot。 */
export class NodeZCodeBuiltinProviderConfigSource implements ProviderSource<ProviderConfigLayerSnapshot> {
  readonly #bundledFilePath: string;
  readonly #activeFilePath: string;
  readonly #sourceKey: string;
  readonly #watchEnabled: boolean;
  readonly #listeners = new Set<(reason: string) => void>();
  #watcher: FSWatcher | null = null;
  #observedSignature: string | null = null;
  #watchRefresh = Promise.resolve();
  #disposed = false;

  constructor(options: NodeZCodeBuiltinProviderConfigSourceOptions) {
    const bundledFilePath = options.bundledFilePath.trim();
    if (!bundledFilePath) throw new Error("ZCode Built-in bundledFilePath 不能为空");
    this.#bundledFilePath = bundledFilePath;
    this.#activeFilePath = options.activeFilePath?.trim() || bundledFilePath;
    // 旧标识只有发布序号，不同 Endpoint 同序号会让 Registry 误复用上一来源。
    // Active 路径已含规范化 Endpoint 隔离范围；Worker 收到同一路径，不另拼账号事实。
    this.#sourceKey = createHash("sha256").update(resolve(this.#activeFilePath)).digest("hex");
    this.#watchEnabled = options.watch !== false;
  }

  get activeFilePath(): string {
    return this.#activeFilePath;
  }

  async read(): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    let release: ZCodeBuiltinRelease;
    try {
      await this.#ensureWatcher();
      release = await withFileLock(this.#activeFilePath, () => this.#readAndMaterializeLocked());
    } catch {
      // Active 只是可丢弃缓存，目录锁、监听或原子物化失败不能阻断
      // Bundled 基线。缓存边界不可用时绕过 Active；Bundled 自身无效仍会在这里抛错。
      release = selectReleaseCandidate(await readReleaseCandidate(this.#bundledFilePath), null);
    }
    // 首次读取时 Active 可能尚未物化导致武装跳过,物化完成后在此补武装。
    await this.#ensureWatcher();
    this.#observedSignature ??= signatureOf(release);
    return snapshotFromRelease(release, this.#sourceKey);
  }

  async applyRemoteRelease(release: ZCodeBuiltinRelease): Promise<ApplyZCodeBuiltinReleaseResult> {
    this.#assertNotDisposed();
    await this.#ensureWatcher();
    const result = await withFileLock(this.#activeFilePath, async () => {
      this.#assertNotDisposed();
      const current = await this.#readAndMaterializeLocked();
      this.#assertNotDisposed();
      if (release.revision < current.revision) return "stale" as const;
      if (release.revision === current.revision) {
        if (serializeZCodeBuiltinRelease(release) === serializeZCodeBuiltinRelease(current)) {
          return "unchanged" as const;
        }
        throw new Error(`ZCode Built-in 相同 revision ${release.revision} 对应不同内容`);
      }
      await this.#writeActiveLocked(release);
      this.#observedSignature = signatureOf(release);
      return "updated" as const;
    });
    if (result === "updated" && !this.#disposed) this.#emit("remote-updated");
    // 写入 Active 后文件必然存在,补一次武装覆盖写入前武装失败(ENOENT)的场景。
    await this.#ensureWatcher();
    return result;
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#watcher?.close();
    this.#watcher = null;
    this.#listeners.clear();
  }

  async #readAndMaterializeLocked(): Promise<ZCodeBuiltinRelease> {
    const [bundled, active] = await Promise.all([
      readReleaseCandidate(this.#bundledFilePath),
      this.#activeFilePath === this.#bundledFilePath
        ? Promise.resolve(null)
        : readReleaseCandidate(this.#activeFilePath),
    ]);
    const selected = selectReleaseCandidate(bundled, active);
    if (this.#activeFilePath !== this.#bundledFilePath) {
      const activeSignature = active?.release ? signatureOf(active.release) : null;
      if (activeSignature !== signatureOf(selected)) await this.#writeActiveLocked(selected);
    }
    return selected;
  }

  async #writeActiveLocked(release: ZCodeBuiltinRelease): Promise<void> {
    this.#assertNotDisposed();
    await atomicWritePrivateTextFile(
      this.#activeFilePath,
      JSON.stringify(encodeZCodeBuiltinRelease(release), null, 2),
    );
  }

  async #ensureWatcher(): Promise<void> {
    await mkdir(dirname(this.#activeFilePath), { recursive: true });
    if (!this.#watchEnabled || this.#watcher || this.#disposed) return;
    this.#armWatcherOrClear();
  }

  // 中文原因:macOS 26(darwin 25.x)上目录级 fs.watch 对改写/新建/删除/重命名均不
  // 派发事件(Node 22–26 全系实测),原目录监听在生产等同失效,故改为文件级 watch。
  // 原子替换(临时文件 rename 覆盖)后文件级 watcher 仍指向旧 inode,必须在 rename 后
  // 关闭并按路径重建;武装失败(先删后写的空窗、首次读取时 Active 尚未物化)只置空,
  // 由 #scheduleWatchRefresh 的物化刷新或下一次 read/applyRemoteRelease 重新武装,
  // 不得让监听失败阻断读取主链。
  #armWatcherOrClear(): void {
    try {
      this.#watcher = this.#armFileWatcher();
    } catch {
      this.#watcher = null;
    }
  }

  #armFileWatcher(): FSWatcher {
    const watcher = watch(this.#activeFilePath, (eventType) => {
      if (eventType === "rename") {
        watcher.close();
        if (this.#watcher === watcher) this.#watcher = null;
        if (!this.#disposed) this.#armWatcherOrClear();
      }
      this.#scheduleWatchRefresh();
    });
    watcher.on("error", () => {
      this.#emit("watch-error");
      watcher.close();
      if (this.#watcher === watcher) this.#watcher = null;
    });
    return watcher;
  }

  #scheduleWatchRefresh(): void {
    this.#watchRefresh = this.#watchRefresh.then(async () => {
      if (this.#disposed) return;
      try {
        const release = await withFileLock(this.#activeFilePath, () =>
          this.#readAndMaterializeLocked(),
        );
        const signature = signatureOf(release);
        if (this.#disposed || signature === this.#observedSignature) return;
        this.#observedSignature = signature;
        this.#emit("file-changed");
      } catch {
        this.#emit("watch-error");
      } finally {
        // rename/删除空窗导致重建失败时,物化刷新把文件补齐后在此重新武装。
        if (!this.#disposed && this.#watchEnabled && this.#watcher === null) {
          this.#armWatcherOrClear();
        }
      }
    });
  }

  #emit(reason: string): void {
    if (this.#disposed) return;
    for (const listener of this.#listeners) listener(reason);
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("NodeZCodeBuiltinProviderConfigSource 已 dispose");
  }
}

export function createNodeZCodeBuiltinProviderConfigSource(
  options: NodeZCodeBuiltinProviderConfigSourceOptions,
): NodeZCodeBuiltinProviderConfigSource {
  return new NodeZCodeBuiltinProviderConfigSource(options);
}

interface ReleaseCandidate {
  readonly release?: ZCodeBuiltinRelease;
  readonly error?: unknown;
}

async function readReleaseCandidate(filePath: string): Promise<ReleaseCandidate | null> {
  try {
    return { release: decodeZCodeBuiltinRelease(JSON.parse(await readFile(filePath, "utf8"))) };
  } catch (error) {
    if (isFileNotFound(error)) return null;
    return { error };
  }
}

function selectReleaseCandidate(
  bundled: ReleaseCandidate | null,
  active: ReleaseCandidate | null,
): ZCodeBuiltinRelease {
  if (
    bundled?.release &&
    active?.release &&
    bundled.release.revision === active.release.revision &&
    serializeZCodeBuiltinRelease(bundled.release) !== serializeZCodeBuiltinRelease(active.release)
  ) {
    // 同 revision 冲突属于 Active 缓存失效，不能反向使可信 Bundled 无法启动。
    // 返回 Bundled 后调用方会在能够写入时原子替换 Active。
    return bundled.release;
  }
  const valid = [bundled?.release, active?.release].filter(
    (candidate): candidate is ZCodeBuiltinRelease => candidate !== undefined,
  );
  if (valid.length === 0) {
    throw new AggregateError(
      [bundled?.error, active?.error].filter((error) => error !== undefined),
      "Bundled 与 Active ZCode Built-in Release 均不可用",
    );
  }
  return valid.reduce((newest, candidate) =>
    candidate.revision > newest.revision ? candidate : newest,
  );
}

function snapshotFromRelease(
  release: ZCodeBuiltinRelease,
  sourceKey: string,
): ProviderConfigLayerSnapshot {
  return Object.freeze({
    revision: `zcode-builtin:${release.revision}:${sourceKey}`,
    providers: release.config.providers,
    providerTemplates: release.config.providerTemplates,
    models: release.config.modelConfigRules,
  });
}

function signatureOf(release: ZCodeBuiltinRelease): string {
  return `${release.revision}:${serializeZCodeBuiltinRelease(release)}`;
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
