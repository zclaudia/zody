/* eslint-disable max-lines -- 模型供应商 schema、迁移和运行时投影 helper 需要共享同一套类型边界，暂时集中在单文件避免契约分散。 */
export const BUILTIN_PROVIDER_TEMPLATE_IDS = {
  zai: "zai-api",
  bigmodel: "bigmodel-api",
} as const;

// fork（F4.11）：官方账号 provider id（account:zai|bigmodel-*）与 isBuiltinModelProviderId /
// isStartPlanModelProviderId 等账号判定随官方账号链路删除。旧持久化数据中的 account:* 与
// builtin:*-start-plan / builtin:*-coding-plan 只由迁移/遥测兼容代码按字面量识别，不再作为
// 可解析的 Provider 身份对外导出（见 legacy-model-provider-identity.ts、telemetryRedaction.ts）。

/** 一个正式 Model 的连通性测试结果。 */
export type ModelConnectivityResult =
  | { readonly success: true }
  | {
      readonly success: false;
      readonly error: {
        readonly message: string;
        /** 设置连接测试边界已确认的资格失败；其他执行错误保留原消息。 */
        readonly code?: "provider-unavailable" | "model-unavailable";
      };
    };
