import { writeSync } from "node:fs";

/**
 * entry 只能通过 fd3 报告“本次运行发生致命错误”，不能借此改变 owner/lease，
 * 也不能伪造截图结果。native 收到后只锁存非零退出诊断。
 */
export function installFatalReporting(): void {
  let reported = false;
  const report = (kind: string, error: unknown): void => {
    if (reported) return;
    reported = true;
    const detail =
      error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    // 逐字符去掉控制字符，避免正则字符类被 lint 误判；语义与原来替换为空格一致。
    const printable = Array.from(`${kind}: ${detail}`, (character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f ? " " : character;
    }).join("");
    const reason = printable.slice(0, 3000);
    try {
      writeSync(3, `${JSON.stringify({ schemaVersion: 1, type: "fatal", reason })}\n`);
    } catch {
      // fd3 已关闭时保持原异常路径，不把诊断失败当成成功。
    }
  };

  process.on("uncaughtExceptionMonitor", (error) => report("uncaught-exception", error));
  const onUnhandledRejection = (reason: unknown): void => {
    report("unhandled-rejection", reason);
    // Host 自己已有 unhandledRejection owner 时保持其清理路径；没有 owner 时
    // 恢复 Node 默认的致命退出，不能因为诊断监听器把进程留在半死状态。
    if (process.listenerCount("unhandledRejection") === 1) {
      process.removeListener("unhandledRejection", onUnhandledRejection);
      throw reason;
    }
  };
  process.on("unhandledRejection", onUnhandledRejection);
}
