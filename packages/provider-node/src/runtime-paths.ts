export const ZODY_BUILTIN_PROVIDER_CONFIG_FILE_ENV = "ZODY_BUILTIN_PROVIDER_CONFIG_FILE";
export const ZODY_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV =
  "ZODY_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE";
export const ZODY_PERSONAL_PROVIDER_CONFIG_FILE_ENV = "ZODY_PERSONAL_PROVIDER_CONFIG_FILE";
export const PERSONAL_PROVIDER_CONFIG_FILE_NAME = "provider_config.json";

export interface NodeProviderRuntimePaths {
  readonly zcodeBuiltinFilePath: string;
  readonly personalFilePath: string;
}

export function createNodeProviderRuntimePathEnv(
  paths: NodeProviderRuntimePaths,
): Record<string, string> {
  return {
    [ZODY_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: paths.zcodeBuiltinFilePath,
    [ZODY_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: paths.personalFilePath,
  };
}

export function resolveNodeProviderRuntimePaths(
  env: Readonly<Record<string, string | undefined>>,
): NodeProviderRuntimePaths | null {
  const zodyBuiltinFilePath = env[ZODY_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const personalFilePath = env[ZODY_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim();
  if (!zodyBuiltinFilePath && !personalFilePath) return null;
  if (!zodyBuiltinFilePath || !personalFilePath) {
    throw new Error("ZCode Built-in 与 Personal Provider Config 路径必须同时提供");
  }
  return Object.freeze({ zcodeBuiltinFilePath: zodyBuiltinFilePath, personalFilePath });
}
