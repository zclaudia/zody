import {
  ProviderConfigService,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
} from "@zody/provider";
import { NodeZodyBuiltinProviderConfigSource } from "./zody-builtin-provider-config-source.js";
import {
  EndpointScopedZodyBuiltinSource,
  type EndpointScopedZodyBuiltinSourceOptions,
} from "./endpoint-scoped-zody-builtin-source.js";
import {
  ZodyBuiltinRemoteSynchronizer,
  type ZodyBuiltinRemoteSynchronizerOptions,
  type ZodyBuiltinRefreshResult,
} from "./zody-builtin-remote-synchronizer.js";
import {
  NodePersonalProviderConfigRepository,
  type PersonalProviderConfigRecoveryEvent,
} from "./personal-provider-config-repository.js";

export interface NodeProviderConfigRuntimeOptions {
  readonly zodyBuiltinFilePath: string;
  readonly zodyBuiltinActiveFilePath?: string;
  readonly zodyBuiltinRemote?: Omit<ZodyBuiltinRemoteSynchronizerOptions, "source">;
  readonly zodyBuiltinEnvironment?: Omit<
    EndpointScopedZodyBuiltinSourceOptions,
    "bundledFilePath"
  >;
  readonly onZCodeBuiltinRefreshError?: (error: unknown) => void;
  readonly onPersonalConfigRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly onPersonalConfigPollingError?: (error: unknown) => void;
  readonly personalFilePath: string;
  readonly personalPollingIntervalMs?: number | false;
  readonly importLegacy?: (
    zcodeBuiltin: ProviderConfigLayerSnapshot,
  ) => Promise<ProviderConfigLayerUpdate | null>;
  readonly watch?: boolean;
}

/** 组装一个 Node.js 进程内共享的 ZCode Built-in/Personal Config 运行边界。 */
export class NodeProviderConfigRuntime {
  readonly configService: ProviderConfigService;
  readonly #zodyBuiltinSource:
    | NodeZodyBuiltinProviderConfigSource
    | EndpointScopedZodyBuiltinSource;
  readonly #personalRepository: NodePersonalProviderConfigRepository;
  readonly #remoteSynchronizer?: ZodyBuiltinRemoteSynchronizer;
  readonly #onRemoteRefreshError?: (error: unknown) => void;
  #startPromise: Promise<void> | null = null;
  #disposed = false;
  readonly #checkListeners = new Set<() => Promise<void>>();
  #checkTimer: ReturnType<typeof setInterval> | null = null;
  #checkInFlight: Promise<void> | null = null;

  constructor(options: NodeProviderConfigRuntimeOptions) {
    this.#zodyBuiltinSource = options.zodyBuiltinEnvironment
      ? new EndpointScopedZodyBuiltinSource({
          bundledFilePath: options.zodyBuiltinFilePath,
          ...options.zodyBuiltinEnvironment,
        })
      : new NodeZodyBuiltinProviderConfigSource({
          bundledFilePath: options.zodyBuiltinFilePath,
          activeFilePath: options.zodyBuiltinActiveFilePath,
          watch: options.watch,
        });
    this.#remoteSynchronizer =
      options.zodyBuiltinRemote &&
      this.#zodyBuiltinSource instanceof NodeZodyBuiltinProviderConfigSource
        ? new ZodyBuiltinRemoteSynchronizer({
            source: this.#zodyBuiltinSource,
            ...options.zodyBuiltinRemote,
          })
        : undefined;
    this.#onRemoteRefreshError = options.onZCodeBuiltinRefreshError;
    this.#personalRepository = new NodePersonalProviderConfigRepository({
      filePath: options.personalFilePath,
      onRecovery: options.onPersonalConfigRecovery,
      onPollingError: options.onPersonalConfigPollingError,
      pollingIntervalMs: options.personalPollingIntervalMs,
      ...(options.importLegacy
        ? {
            importLegacy: async () => options.importLegacy!(await this.#zodyBuiltinSource.read()),
          }
        : {}),
    });
    this.configService = new ProviderConfigService({
      zodyBuiltinSource: this.#zodyBuiltinSource,
      personalRepository: this.#personalRepository,
    });
  }

  resolveZCodeBuiltinActiveFilePath(): Promise<string> {
    return this.#zodyBuiltinSource instanceof NodeZodyBuiltinProviderConfigSource
      ? Promise.resolve(this.#zodyBuiltinSource.activeFilePath)
      : this.#zodyBuiltinSource.resolveActiveFilePath();
  }

  get personalRepository(): import("@zody/provider").PersonalProviderConfigRepository {
    return this.#personalRepository;
  }

  /** Environment 同一周期检查中恢复未对齐依赖，不被下载 TTL 或失败挡住。 */
  onDidCheckZCodeBuiltin(listener: () => Promise<void>): () => void {
    this.#checkListeners.add(listener);
    return () => this.#checkListeners.delete(listener);
  }

  start(): Promise<void> {
    if (this.#disposed) throw new Error("NodeProviderConfigRuntime 已 dispose");
    if (this.#startPromise) return this.#startPromise;
    const startPromise = this.configService.read().then(() => {
      if (this.#disposed) return;
      void this.#checkBackground();
      // Managed Worker 无下载配置也无恢复 owner，不建立周期任务。
      if (
        this.#remoteSynchronizer ||
        this.#zodyBuiltinSource instanceof EndpointScopedZodyBuiltinSource ||
        this.#checkListeners.size > 0
      ) {
        this.#checkTimer = setInterval(() => {
          void this.#checkBackground();
        }, 60_000);
        this.#checkTimer.unref?.();
      }
    });
    this.#startPromise = startPromise;
    void startPromise.catch(() => {
      if (this.#startPromise === startPromise) this.#startPromise = null;
    });
    return startPromise;
  }

  refreshZCodeBuiltin(options?: { readonly force?: boolean }): Promise<ZodyBuiltinRefreshResult> {
    if (this.#disposed) return Promise.resolve("disposed");
    if (this.#zodyBuiltinSource instanceof EndpointScopedZodyBuiltinSource) {
      return this.#zodyBuiltinSource.refresh(options);
    }
    return this.#remoteSynchronizer?.refresh(options) ?? Promise.resolve("skipped");
  }

  #checkBackground(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#checkInFlight) return this.#checkInFlight;
    const check = Promise.allSettled([
      this.refreshZCodeBuiltin(),
      ...[...this.#checkListeners].map((listener) => Promise.resolve().then(listener)),
    ])
      .then((results) => {
        if (this.#disposed) return;
        for (const result of results)
          if (result.status === "rejected") this.#onRemoteRefreshError?.(result.reason);
      })
      .finally(() => {
        if (this.#checkInFlight === check) this.#checkInFlight = null;
      });
    this.#checkInFlight = check;
    return check;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#checkTimer) clearInterval(this.#checkTimer);
    this.#checkTimer = null;
    this.#checkListeners.clear();
    this.#remoteSynchronizer?.dispose();
    this.configService.dispose();
    this.#personalRepository.dispose();
    this.#zodyBuiltinSource.dispose();
  }
}

export function createNodeProviderConfigRuntime(
  options: NodeProviderConfigRuntimeOptions,
): NodeProviderConfigRuntime {
  return new NodeProviderConfigRuntime(options);
}
