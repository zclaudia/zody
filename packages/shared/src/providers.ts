import { z } from "zod";

/**
 * Zody agent 提供方的单一真源。
 *
 * 类型 ZodyProvider、运行时 schema zodyProviderSchema 都从这里派生,
 * 避免各处内联 z.enum([...]) 副本随新增/删除 provider 漂移。
 * 本模块只依赖 zod(叶子),可被 validation / zody-protocol 等无环引用。
 */
export const ZODY_PROVIDERS = ["glm"] as const;

export const zodyProviderSchema = z.enum(ZODY_PROVIDERS);

export type ZodyProvider = (typeof ZODY_PROVIDERS)[number];
