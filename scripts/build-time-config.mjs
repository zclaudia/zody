import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * 桌面构建期可选能力的唯一解析入口：ARMS RUM 上报、事件上报、自动更新、下载页地址、fork 反馈地址。
 * 优先级：构建进程环境变量 > config/private/build-defaults.json（仅内部仓库存在）> 关闭。
 * 规则见 docs/desktop/build-time-optional-capabilities.md、docs/fork/build.md 与
 * specs/fork-official-backend-runtime-dependencies.md（fork 自动更新护栏与下载页地址）。
 */
export const PRIVATE_BUILD_DEFAULTS_PATH = resolve(
  import.meta.dirname,
  "../config/private/build-defaults.json",
);

const ENABLED_VALUES = new Set(["1", "true", "yes"]);

async function readPrivateDefaults(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`构建期私有默认配置必须是 JSON 对象：${path}`);
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function pickValue(env, defaults, key) {
  // 环境变量显式设置（包括空字符串）时优先，空字符串表示关闭该项能力
  if (typeof env[key] === "string") return env[key].trim();
  const value = defaults[key];
  return typeof value === "string" ? value.trim() : "";
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "::1", "0:0:0:0:0:0:0:1"]);

function isLoopbackHostname(hostname) {
  // WHATWG URL 的 IPv6 hostname 保留方括号（如 "[::1]"），统一去掉再比较
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(host)) return true;
  return /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * 构建期校验对外页面地址（下载页、fork 问题反馈页共用同一规则）：
 * 必须是完整 https URL；仅 loopback 允许 http（用于本机测试），防止打包构建带上明文外链。
 * 未配置返回空串，消费方据此不展示对应入口。
 */
function resolveExternalPageUrl(value, envName) {
  if (!value) return "";
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${envName} 不是合法 URL：${value}`);
  }
  const httpAllowedForLoopback = parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname);
  if (parsed.protocol !== "https:" && !httpAllowedForLoopback) {
    throw new Error(
      `${envName} 必须是完整 https URL（仅 loopback 允许 http，仅用于本机测试）：${value}`,
    );
  }
  return value;
}

export async function resolveBuildTimeConfig(
  env = process.env,
  { defaultsPath = PRIVATE_BUILD_DEFAULTS_PATH } = {},
) {
  const defaults = await readPrivateDefaults(defaultsPath);
  // 构建护栏（阶段 2 细则「自动更新」规则 4）：fork 采用手动更新，自有更新源（feed、签名、manifest 服务）落地前，
  // ZCODE_AUTO_UPDATE 为真一律让构建失败，避免构建意外启用指向官方 manifest 的更新器（安装包可能被官方包原地替换）。
  if (ENABLED_VALUES.has(pickValue(env, defaults, "ZCODE_AUTO_UPDATE").toLowerCase())) {
    throw new Error(
      "ZCODE_AUTO_UPDATE 已启用：fork 尚无自有自动更新源，启用会把更新请求指向官方 manifest。" +
        "fork 构建禁止设置该变量（环境变量与 config/private/build-defaults.json 均不可），规则见" +
        " specs/fork-official-backend-runtime-dependencies.md「自动更新」。",
    );
  }
  return {
    armsRumEndpoint: pickValue(env, defaults, "ZCODE_ARMS_RUM_ENDPOINT"),
    telemetryReportEndpoint: pickValue(env, defaults, "ZCODE_TELEMETRY_REPORT_ENDPOINT"),
    // 上方护栏保证此处恒为 false；运行时由 @zcode/shared 的 isDesktopAutoUpdateActive() 统一判定
    autoUpdateEnabled: false,
    downloadPageUrl: resolveExternalPageUrl(
      pickValue(env, defaults, "ZCODE_DOWNLOAD_PAGE_URL"),
      "ZCODE_DOWNLOAD_PAGE_URL",
    ),
    // fork（F2.9，决策门 D7）：反馈本地化后，官方工单提交停用，反馈入口改为
    // 「导出日志 + 打开 fork 问题反馈地址」；地址未配置时入口不显示。
    feedbackIssueUrl: resolveExternalPageUrl(
      pickValue(env, defaults, "ZCODE_FEEDBACK_ISSUE_URL"),
      "ZCODE_FEEDBACK_ISSUE_URL",
    ),
  };
}

export function createBuildTimeConfigDefines(config) {
  return {
    __ZCODE_ARMS_RUM_ENDPOINT__: JSON.stringify(config.armsRumEndpoint),
    __ZCODE_TELEMETRY_REPORT_ENDPOINT__: JSON.stringify(config.telemetryReportEndpoint),
    __ZCODE_AUTO_UPDATE_ENABLED__: JSON.stringify(config.autoUpdateEnabled),
    __ZCODE_DOWNLOAD_PAGE_URL__: JSON.stringify(config.downloadPageUrl),
    __ZCODE_FEEDBACK_ISSUE_URL__: JSON.stringify(config.feedbackIssueUrl),
  };
}
