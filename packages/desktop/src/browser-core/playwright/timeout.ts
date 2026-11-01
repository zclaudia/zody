export const PLAYWRIGHT_DEFAULT_TIMEOUT_MS = 3_000;

/**
 * 常规 Playwright 操作使用短失败预算：默认 3s，且由调用点给出上限。
 * 避免猜错 locator 后长时间无效轮询；IAB 与 extension 共用同一口径。
 */
export function normalizePlaywrightTimeout(
  timeoutMs: number | undefined,
  max = PLAYWRIGHT_DEFAULT_TIMEOUT_MS,
): number {
  const requested = typeof timeoutMs === "number" ? timeoutMs : PLAYWRIGHT_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(0, requested), max || PLAYWRIGHT_DEFAULT_TIMEOUT_MS);
}
