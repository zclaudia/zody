// fork（F2.10）：来源标识 HTTP-Referer / X-Title 不再指向官方域。
// D5（产品名、域名、渠道）未决期间取中性值——默认不发；构建期可通过 bundler define
// 注入 __ZCODE_SOURCE_REFERER_URL__ / __ZCODE_SOURCE_TITLE__ 启用（D5 决定后在 F7.1 替换取值）。
declare const __ZCODE_SOURCE_REFERER_URL__: string;
declare const __ZCODE_SOURCE_TITLE__: string;

/** 构建期 HTTP-Referer；为空时不发送。 */
export const ZCODE_SOURCE_REFERER_URL: string =
  typeof __ZCODE_SOURCE_REFERER_URL__ !== "undefined" ? __ZCODE_SOURCE_REFERER_URL__ : "";
/** 构建期 X-Title 基名（实际发送 `${基名}@${sourceTitle}`）；为空时不发送。 */
export const ZCODE_SOURCE_TITLE: string =
  typeof __ZCODE_SOURCE_TITLE__ !== "undefined" ? __ZCODE_SOURCE_TITLE__ : "";

// fork（F2.10）：设备标识 X-Device-Mid 与官方来源标识不再进入默认基础头。
export const ZCODE_SOURCE_HEADERS = {
  "User-Agent": "ZCode/unknown",
} as const;

export interface BuildZCodeSourceHeadersFromContextOptions {
  appVersion?: string;
  arch?: string;
  clientLanguage?: string;
  clientTimezone?: string;
  osVersion?: string;
  platform?: string;
  releaseChannel?: string;
  sourceTitle?: string;
}

export function normalizeZCodeSourceHeaderValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^[\x20-\x7e]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function buildZCodeSourceHeadersFromContext(
  options: BuildZCodeSourceHeadersFromContextOptions = {},
): Record<string, string> {
  const appVersion = normalizeZCodeSourceHeaderValue(options.appVersion);
  const arch = normalizeZCodeSourceHeaderValue(options.arch);
  const clientLanguage = normalizeZCodeSourceHeaderValue(options.clientLanguage) ?? "unknown";
  const clientTimezone = normalizeZCodeSourceHeaderValue(options.clientTimezone) ?? "unknown";
  const osVersion = normalizeZCodeSourceHeaderValue(options.osVersion);
  const platform = normalizeZCodeSourceHeaderValue(options.platform);
  const releaseChannel = normalizeZCodeSourceHeaderValue(options.releaseChannel);
  const sourceTitle = normalizeZCodeSourceHeaderValue(options.sourceTitle) ?? "electron";
  // 构建期注入值同样经过合法性校验；为空或含非法字符时一律不发。
  const sourceRefererUrl = normalizeZCodeSourceHeaderValue(ZCODE_SOURCE_REFERER_URL);
  const sourceTitleBase = normalizeZCodeSourceHeaderValue(ZCODE_SOURCE_TITLE);

  return {
    ...ZCODE_SOURCE_HEADERS,
    "User-Agent": `ZCode/${appVersion ?? "unknown"}`,
    ...(appVersion ? { "X-ZCode-App-Version": appVersion } : {}),
    ...(sourceRefererUrl ? { "HTTP-Referer": sourceRefererUrl } : {}),
    ...(sourceTitleBase ? { "X-Title": `${sourceTitleBase}@${sourceTitle}` } : {}),
    ...(platform && arch ? { "X-Platform": `${platform}-${arch}` } : {}),
    ...(releaseChannel ? { "X-Release-Channel": releaseChannel } : {}),
    "X-Client-Language": clientLanguage,
    "X-Client-Timezone": clientTimezone,
    ...(platform ? { "X-Os-Category": normalizeOsCategory(platform) } : {}),
    ...(osVersion ? { "X-Os-Version": osVersion } : {}),
  };
}

function normalizeOsCategory(platform: string): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}
