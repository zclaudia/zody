// 官方引用词表：供 scripts/check-official-refs.mjs（F0.1 残留检查）与
// F0.3 断网验收容器（生成 --add-host 屏蔽清单）复用。
// 规则依据 specs/fork-official-deps-removal-plan.md 阶段 0.1 与
// specs/fork-official-deps-removal-tasks.md 的 F0.1 小节：
// - 域名类是真正的外部依赖，必须拦截；正则需转义点号并加边界，
//   例如 `fooz.ai` 不得命中 `z.ai`。
// - 标识类（品牌 / 内部命名 / provider id）不产生网络请求，只统计不拦截；
//   `z-ai`、`z_ai`、`z-ai-pc` 等 provider id 属于标识，不得计入域名残留。
// - 允许的 BYOK 端点是作为第三方模型服务使用的公开 API 地址（用户自带 key
//   直连），不计入残留；官方网关改写地址（带 :443 端口等变体）不在此列。

/** 转义正则元字符，保证词表字符串按字面匹配（`.` 不作通配符）。 */
export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** 官方域名列表（裸域；匹配时自动覆盖任意层级子域）。F0.3 由此生成 --add-host 清单。 */
export const officialDomains = ["z.ai", "bigmodel.cn", "codegeex.cn", "chatglm.cn", "zcode-ai.com"];

// 域名匹配骨架：
// - `(?<![\w.-])` 负向后行排除前缀粘连（`fooz.ai`、`not-z.ai` 不命中）；
// - `(?:[\w-]+\.)*` 覆盖任意层级子域（`api.z.ai`、`zcode.z.ai` 整体命中）；
// - `\b` 尾边界防止命中后紧跟字母数字的串（`z.aix` 不命中）。
const domainPatternSource = (domain) => `(?<![\\w.-])(?:[\\w-]+\\.)*${escapeRegExp(domain)}\\b`;

/** 域名类词表：`{ keyword, regex }`，regex 带全局标志，供 String.match 收集全部命中。 */
export const officialDomainPatterns = officialDomains.map((domain) => ({
  keyword: domain,
  regex: new RegExp(domainPatternSource(domain), "gu"),
}));

/** 标识类词表：品牌 / 内部命名 / provider id，只统计不拦截。 */
export const officialIdentifierPatterns = [
  { keyword: "zhipu", regex: /zhipu/giu },
  { keyword: "@zai-ai", regex: /@zai-ai/gu },
  { keyword: "zai-sdk", regex: /zai-sdk/gu },
  { keyword: "zai-org", regex: /zai-org/gu },
  // `z-ai` / `z_ai` 是 provider id（含 `z-ai-pc` 等派生 id），属标识而非域名；
  // 边界防止把 `maze-ai` 这类无关词算进来，同时仍覆盖 `z-ai-pc`（`-` 处成立边界）。
  { keyword: "z-ai", regex: /(?<![\w-])z-ai(?![\w])/gu },
  { keyword: "z_ai", regex: /(?<![\w])z_ai(?![\w])/gu },
];

/**
 * 允许的 BYOK 端点前缀：第三方模型服务的公开 API 地址（用户自带 key 直连，fork 保留）。
 * 任务文档 F0.1 小节列出的四个地址；带子路径（如 `/api/anthropic/v1/messages`）
 * 以此前缀放行。官方网关改写地址（`https://api.z.ai:443/...` 等带端口变体）
 * 不在放行之列，照常计入残留。
 */
export const allowedByokEndpoints = [
  "https://api.z.ai/api/anthropic",
  "https://api.z.ai/api/paas/v4",
  "https://open.bigmodel.cn/api/anthropic",
  "https://open.bigmodel.cn/api/paas/v4",
];

// 放行正则：`(?![\w-])` 尾边界保证只放行端点本身及其 `/` 子路径，
// 不会把 `https://api.z.ai/api/anthropic-evil` 这类粘连串一并放行
// （`-` 在边界集内，粘连串不被剔除，官方域名照常计入残留）。
/** BYOK 端点放行正则（全局标志；扫描时先从行中剔除命中，再统计域名）。 */
export const allowedByokEndpointPattern = new RegExp(
  allowedByokEndpoints.map((endpoint) => `${escapeRegExp(endpoint)}(?![\\w-])`).join("|"),
  "giu",
);
