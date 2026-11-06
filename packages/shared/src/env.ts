import type { ZodyRuntimeEnv } from "./runtimeEnv.js";

export type ZodyEnv = "test" | "production";
/** 安装包身份：决定应用名、app id、Electron 数据目录与更新策略；与后端环境 `ZodyEnv` 是两个轴。 */
export type ZodyProductFlavor = "production" | "preview";
export type ArmsRumEnv = "local" | "prod";

// 非构建环境（如 e2e 测试的 mocha）下 define 不存在，用 typeof 检查 + fallback 避免 ReferenceError
declare const __ZODY_ENV__: string;
declare const __ZODY_PRODUCT_FLAVOR__: string;
declare const __ZODY_ARMS_RUM_ENDPOINT__: string;
declare const __ZODY_TELEMETRY_REPORT_ENDPOINT__: string;
declare const __ZODY_AUTO_UPDATE_ENABLED__: boolean;
declare const __ZODY_DOWNLOAD_PAGE_URL__: string;
declare const __ZODY_FEEDBACK_ISSUE_URL__: string;

export function normalizeZodyEnv(value: string | undefined): ZodyEnv {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

export const ZODY_ENV = normalizeZodyEnv(
  typeof __ZODY_ENV__ !== "undefined" ? __ZODY_ENV__ : undefined,
);

/**
 * 身份缺省跟随后端环境（test → preview，production → production）。
 * 桌面构建通过 `ZODY_PREVIEW_IDENTITY=1` 显式注入 preview，得到连接生产后端的 Preview 包；
 * 未注入 define 的 bundle（web、CLI、测试）沿用旧的单轴语义。
 */
export function normalizeZodyProductFlavor(
  value: string | undefined,
  zcodeEnv: ZodyEnv,
): ZodyProductFlavor {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "production" || normalized === "preview") {
    return normalized;
  }
  return zcodeEnv === "production" ? "production" : "preview";
}

export const ZODY_PRODUCT_FLAVOR = normalizeZodyProductFlavor(
  typeof __ZODY_PRODUCT_FLAVOR__ !== "undefined" ? __ZODY_PRODUCT_FLAVOR__ : undefined,
  ZODY_ENV,
);
export const ZODY_APP_VERSION_ENV = "ZODY_APP_VERSION" as const;
export const ZODY_BUILD_COMMIT_ID_ENV = "ZODY_BUILD_COMMIT_ID" as const;

// ── 运行时环境变量（不经过编译打包，启动时从 process.env 读取） ──
// 启用调试模式，值为 inspect-brk 的端口号，如 ZODY_DEBUG=9230
export const RUNTIME_ZCODE_DEBUG =
  typeof process !== "undefined" ? process.env.ZODY_DEBUG : undefined;

// ── 构建期可选能力（见 docs/desktop/build-time-optional-capabilities.md），未注入时一律关闭 ──
/** ARMS RUM 上报地址；为空时 SDK 以 enable=false 初始化，不产生上报。 */
export const ZODY_ARMS_RUM_ENDPOINT: string =
  typeof __ZODY_ARMS_RUM_ENDPOINT__ !== "undefined" ? __ZODY_ARMS_RUM_ENDPOINT__ : "";
/** 事件上报（数仓）地址；为空时不上报。 */
export const ZODY_TELEMETRY_REPORT_ENDPOINT: string =
  typeof __ZODY_TELEMETRY_REPORT_ENDPOINT__ !== "undefined"
    ? __ZODY_TELEMETRY_REPORT_ENDPOINT__
    : "";
/** 桌面自动更新是否启用。 */
export const ZODY_AUTO_UPDATE_ENABLED: boolean =
  typeof __ZODY_AUTO_UPDATE_ENABLED__ !== "undefined" ? __ZODY_AUTO_UPDATE_ENABLED__ : false;
/**
 * fork 手动升级下载页地址（构建期 ZODY_DOWNLOAD_PAGE_URL，经 define 注入，运行时只读）。
 * 为空表示未配置，消费方（如架构不匹配弹框）不展示下载入口；loopback http 仅用于本机测试。
 */
export const ZODY_DOWNLOAD_PAGE_URL: string =
  typeof __ZODY_DOWNLOAD_PAGE_URL__ !== "undefined" ? __ZODY_DOWNLOAD_PAGE_URL__ : "";

/**
 * fork 问题反馈地址（构建期 ZODY_FEEDBACK_ISSUE_URL，经 define 注入，运行时只读）。
 * fork（F2.9，决策门 D7）：官方工单提交已停用，反馈入口只保留「导出诊断日志」与
 * 该外部反馈地址；为空表示未配置，消费方不展示对应入口。
 */
export const ZODY_FEEDBACK_ISSUE_URL: string =
  typeof __ZODY_FEEDBACK_ISSUE_URL__ !== "undefined" ? __ZODY_FEEDBACK_ISSUE_URL__ : "";

/**
 * 桌面自动更新是否生效：production 安装身份且构建期启用自动更新，两者缺一不可。
 * 这是唯一判定（阶段 2 细则「自动更新」规则 1）：启动初始化、应用菜单、托盘、渲染端入口
 * 与设置项统一只读它，不再各自拼条件。fork 采用手动更新，构建护栏禁止 ZODY_AUTO_UPDATE，
 * fork 构建中恒为 false。
 */
export function isDesktopAutoUpdateActive(): boolean {
  return ZODY_PRODUCT_FLAVOR === "production" && ZODY_AUTO_UPDATE_ENABLED;
}

/** 将本地运行态与编译期 ZODY_ENV 映射为 ARMS 控制台识别的上报环境标签 */
export function mapZodyEnvToArmsRumEnv(runtimeEnv: ZodyRuntimeEnv): ArmsRumEnv {
  return runtimeEnv !== "development" && ZODY_ENV === "production" ? "prod" : "local";
}
