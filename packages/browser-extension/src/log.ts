/**
 * 扩展内日志只写到 DevTools console；不得输出配对码、共享密钥、nonce 或 proof。
 * 成功握手只记录状态与 generation 等非敏感事实。
 */
type LogLevel = "debug" | "info" | "warn" | "error";

function write(level: LogLevel, ...args: unknown[]): void {
  // 扩展没有统一的落盘 logger；console 是 DevTools 可见的唯一诊断出口。
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn("[zody-bridge]", ...args);
}

export const log = {
  debug: (...args: unknown[]) => write("debug", ...args),
  info: (...args: unknown[]) => write("info", ...args),
  warn: (...args: unknown[]) => write("warn", ...args),
  error: (...args: unknown[]) => write("error", ...args),
};
