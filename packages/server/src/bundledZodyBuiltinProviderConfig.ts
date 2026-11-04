import { materializeZodyBuiltinProviderConfig } from "@zody/services/node";

declare const __ZODY_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

export interface MaterializeBundledZodyBuiltinProviderConfigOptions {
  readonly environmentConfigRoot: string;
  readonly content: string;
}

/** 返回构建时嵌入远端 Server 的 ZCode Built-in Provider Config。 */
export function readBundledZodyBuiltinProviderConfig(): string {
  if (typeof __ZODY_BUILTIN_PROVIDER_CONFIG_JSON__ !== "string") {
    throw new Error("当前构建未嵌入 ZCode Built-in Provider Config");
  }
  return __ZODY_BUILTIN_PROVIDER_CONFIG_JSON__;
}

/**
 * 将 ZCode Built-in Config 原子物化到所属环境的固定资源副本。
 * 升级前退出旧进程；不保留按内容 hash 增长的历史文件。
 */
export async function materializeBundledZodyBuiltinProviderConfig(
  options: MaterializeBundledZodyBuiltinProviderConfigOptions,
): Promise<string> {
  return materializeZodyBuiltinProviderConfig(options);
}
