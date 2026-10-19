import type { ProviderConfigLayerSnapshot, ProviderSource } from "@zcode/provider";
import {
  normalizeZCodeBuiltinEndpointOrigin,
  resolveZCodeBuiltinCachePaths,
} from "./zcode-builtin-cache-paths.js";
import { NodeZCodeBuiltinProviderConfigSource } from "./zcode-builtin-provider-config-source.js";
import {
  ZCodeBuiltinRemoteSynchronizer,
  type ZCodeBuiltinRefreshResult,
  type ZCodeBuiltinRemoteSynchronizerOptions,
} from "./zcode-builtin-remote-synchronizer.js";

export interface EndpointScopedZCodeBuiltinSourceOptions {
  readonly bundledFilePath: string;
  readonly environmentConfigRoot: string;
  readonly platform: string;
  readonly appVersion: string;
  readonly resolveEndpointOrigin: () => string | Promise<string>;
  readonly fetchRelease: ZCodeBuiltinRemoteSynchronizerOptions["fetchRelease"];
  readonly onRefreshResult?: ZCodeBuiltinRemoteSynchronizerOptions["onRefreshResult"];
  readonly watch?: boolean;
}

/**
 * 让 Environment 的 ZCode 控制面 Endpoint 同时决定 Active/LKG 与刷新控制路径。
 * Endpoint 切换只替换当前 Source，不读取上一 Endpoint 的缓存。
 */
export class EndpointScopedZCodeBuiltinSource implements ProviderSource<ProviderConfigLayerSnapshot> {
  readonly #options: EndpointScopedZCodeBuiltinSourceOptions;
  readonly #listeners = new Set<(reason: string) => void>();
  #current: CurrentEndpointSource | null = null;
  #ensureInFlight: Promise<CurrentEndpointSource> | null = null;
  #disposed = false;

  constructor(options: EndpointScopedZCodeBuiltinSourceOptions) {
    this.#options = options;
  }

  async read(): Promise<ProviderConfigLayerSnapshot> {
    return (await this.#ensureCurrent()).source.read();
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async refresh(options?: { readonly force?: boolean }): Promise<ZCodeBuiltinRefreshResult> {
    const current = await this.#ensureCurrent();
    // fork（F3.1）：端点未配置时关闭远端刷新，只读取随包/本地缓存。
    if (!current.synchronizer) {
      return "skipped";
    }
    return current.synchronizer.refresh(options);
  }

  /** 返回当前 Environment Endpoint 对应、已完成物化的 Active Config 路径。 */
  async resolveActiveFilePath(): Promise<string> {
    return (await this.#ensureCurrent()).activeFilePath;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#current?.dispose();
    this.#current = null;
    this.#listeners.clear();
  }

  async #ensureCurrent(): Promise<CurrentEndpointSource> {
    this.#assertNotDisposed();
    if (this.#ensureInFlight) return this.#ensureInFlight;
    const ensure = this.#resolveCurrent().finally(() => {
      if (this.#ensureInFlight === ensure) this.#ensureInFlight = null;
    });
    this.#ensureInFlight = ensure;
    return ensure;
  }

  async #resolveCurrent(): Promise<CurrentEndpointSource> {
    const rawEndpointOrigin = (await this.#options.resolveEndpointOrigin()).trim();
    // fork（F3.1）：未配置端点使用固定的本地缓存目录，只读取随包/本地缓存；
    // 该分支不创建远端 synchronizer，refresh 返回 skipped。
    const endpointOrigin = rawEndpointOrigin
      ? normalizeZCodeBuiltinEndpointOrigin(rawEndpointOrigin)
      : "";
    const paths = resolveZCodeBuiltinCachePaths({
      environmentConfigRoot: this.#options.environmentConfigRoot,
      platform: this.#options.platform,
      appVersion: this.#options.appVersion,
      zcodeEndpointOrigin: endpointOrigin,
    });
    if (this.#current?.activeFilePath === paths.activeFilePath) return this.#current;

    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: this.#options.bundledFilePath,
      activeFilePath: paths.activeFilePath,
      watch: this.#options.watch,
    });
    const sourceDispose = source.onDidChange((reason) => this.#emit(reason));
    const synchronizer = endpointOrigin
      ? new ZCodeBuiltinRemoteSynchronizer({
          source,
          controlFilePath: paths.controlFilePath,
          resolveEndpointKey: async () =>
            normalizeZCodeBuiltinEndpointOrigin(await this.#options.resolveEndpointOrigin()),
          fetchRelease: this.#options.fetchRelease,
          onRefreshResult: this.#options.onRefreshResult,
        })
      : null;
    try {
      await source.read();
      this.#assertNotDisposed();
    } catch (error) {
      sourceDispose();
      synchronizer?.dispose();
      source.dispose();
      throw error;
    }

    const previous = this.#current;
    const current = new CurrentEndpointSource(
      paths.activeFilePath,
      source,
      synchronizer,
      sourceDispose,
    );
    this.#current = current;
    previous?.dispose();
    if (previous) this.#emit("endpoint-changed");
    return current;
  }

  #emit(reason: string): void {
    if (this.#disposed) return;
    for (const listener of this.#listeners) listener(reason);
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("EndpointScopedZCodeBuiltinSource 已 dispose");
  }
}

class CurrentEndpointSource {
  constructor(
    readonly activeFilePath: string,
    readonly source: NodeZCodeBuiltinProviderConfigSource,
    /** 端点未配置时为 null：不创建远端刷新器。 */
    readonly synchronizer: ZCodeBuiltinRemoteSynchronizer | null,
    readonly sourceDispose: () => void,
  ) {}

  dispose(): void {
    this.sourceDispose();
    this.synchronizer?.dispose();
    this.source.dispose();
  }
}
