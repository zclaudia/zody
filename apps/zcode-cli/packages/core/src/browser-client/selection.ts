import { isIP } from "node:net";
import type { BrowserInfo } from "./facade.js";

export type BrowserTabsByBrowserId = ReadonlyMap<string, readonly string[]>;

/**
 * 用户显式设置的默认 backend。它必须是具体 `browserId`，不能是 backend type；
 * 未设置时 IAB 始终是默认。
 */
export interface BrowserSelectionOptions {
  defaultBrowserId?: string;
}

function isPreferredExtension(info: BrowserInfo): boolean {
  return (
    info.type === "extension" &&
    (info.metadata?.preferred === "true" ||
      info.metadata?.preferredInstance === "true" ||
      info.metadata?.profileIsLastUsed === "true" ||
      info.metadata?.profileOrdering === "0")
  );
}

function backendFallbackRank(info: BrowserInfo): number {
  if (info.type === "iab") return 0;
  if (isPreferredExtension(info)) return 1;
  if (info.type === "extension") return 2;
  return 3;
}

export function selectDefaultBrowser(
  infos: readonly BrowserInfo[],
  options: BrowserSelectionOptions = {},
): BrowserInfo | undefined {
  if (options.defaultBrowserId) {
    // 用户显式设置的默认 backend 消失时 fail closed，不能静默迁回 IAB。
    return infos.find((info) => info.id === options.defaultBrowserId);
  }
  return [...infos].sort(
    (left, right) => backendFallbackRank(left) - backendFallbackRank(right),
  )[0];
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`Invalid browser target URL: ${value}`);
  }
}

function withoutHash(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy.href;
}

function urlMatchRank(target: URL, candidate: URL): number | undefined {
  if (withoutHash(target) === withoutHash(candidate)) return 0;
  if (target.origin === candidate.origin && target.pathname === candidate.pathname) return 1;
  if (target.hostname === candidate.hostname) return 2;
  const targetHost = target.hostname.toLowerCase();
  const candidateHost = candidate.hostname.toLowerCase();

  const isParentHost = (parent: string, child: string) =>
    parent.includes(".") && isIP(parent) === 0 && child.endsWith(`.${parent}`);
  if (isParentHost(candidateHost, targetHost) || isParentHost(targetHost, candidateHost)) return 3;
  return undefined;
}

/**
 * open(url) 的 tab 复用匹配：在 agent-owned tabs 里挑最值得原地跳转的一个。
 * 复用阈值 rank <= 2（同 hostname）；rank 3 父子域可能是不同站点，误跳风险高，不复制用。
 * 同 rank 优先 active 的 tab，否则取列表中最新（靠后）的一个。
 * 与 selectBrowserForUrl 同为纯函数，便于共享 contract cases。
 */
export function selectTabForUrl<T extends { url?: string; active?: boolean }>(
  targetValue: string,
  tabs: readonly T[],
): T | undefined {
  const target = parseUrl(targetValue);
  let best: { tab: T; rank: number } | undefined;
  for (const tab of tabs) {
    if (!tab.url) continue;
    let rank: number | undefined;
    try {
      rank = urlMatchRank(target, parseUrl(tab.url));
    } catch {
      continue; // 单个坏 URL 不应让复用匹配失效。
    }
    if (rank === undefined || rank > 2) continue;
    if (
      best === undefined ||
      rank < best.rank ||
      // 同 rank：active 优先；都不 active 时列表靠后（更新）的胜出。
      (rank === best.rank && (tab.active === true || best.tab.active !== true))
    ) {
      best = { tab, rank };
    }
  }
  return best?.tab;
}

/**
 * URL 选择是纯函数，便于用同一组 contract cases 约束 IAB/extension/CDP。
 * 显式 browser selection 不走这里，因此这里的 fallback 不会造成跨 backend 静默切换。
 */
export function selectBrowserForUrl(
  infos: readonly BrowserInfo[],
  targetValue: string,
  tabsByBrowserId: BrowserTabsByBrowserId,
  options: BrowserSelectionOptions = {},
): BrowserInfo {
  if (infos.length === 0) {
    throw new Error("No browser backend is available");
  }
  if (options.defaultBrowserId) {
    const explicit = infos.find((info) => info.id === options.defaultBrowserId);
    if (explicit) return explicit;
    // 已配置的默认 backend 不在线时不能改投 IAB；交给调用方报 backend_unavailable。
    throw new Error(
      `Configured default browser backend '${options.defaultBrowserId}' is unavailable`,
    );
  }
  if (infos.length === 1) {
    return infos[0];
  }

  // extension tab 的 URL 命中不能把任务迁出 IAB。只有用户显式设置的默认
  // extension browserId 才在上面提前返回。
  const iab = infos.find((info) => info.type === "iab");
  if (iab) return iab;

  const target = parseUrl(targetValue);

  const matches = infos.flatMap((info) => {
    let best: number | undefined;
    for (const value of tabsByBrowserId.get(info.id) ?? []) {
      try {
        const rank = urlMatchRank(target, parseUrl(value));
        if (rank !== undefined && (best === undefined || rank < best)) best = rank;
      } catch {
        // backend 返回的单个坏 URL 不应让整个 registry 失效。
      }
    }
    return best === undefined ? [] : [{ info, matchRank: best }];
  });
  matches.sort(
    (left, right) =>
      left.matchRank - right.matchRank ||
      backendFallbackRank(left.info) - backendFallbackRank(right.info),
  );
  return matches[0]?.info ?? selectDefaultBrowser(infos) ?? infos[0];
}
