// sealed sessionStorageEntry：只运行原 bootstrap 的 prepareStorageOnly 路径。
// 不装载 TUI/CLI 全量入口；Host 通过 contract source 在私有 0700 文件里执行这份字节。
import { writeSync } from "node:fs";
import { runZCodeProtocolAgent } from "../../../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.js";

function argumentValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

const argv = process.argv.slice(2);
let exitCode = 0;
try {
  await runZCodeProtocolAgent({
    prepareStorageOnly: true,
    cwd: argumentValue(argv, "--cwd") ?? process.cwd(),
    env: process.env,
    input: process.stdin,
    output: process.stdout,
    presentationSurface: "zcode_desktop",
  });
} catch (error) {
  exitCode = 1;
  // stderr 用同步写保证诊断在显式退出前完成；不冒充成功。
  try {
    writeSync(2, `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  } catch {
    /* stderr 已断开时保留原始失败码。 */
  }
}
// 一次性 Worker 的 stdin 被 readline 消费后，Node 仍保留内部 stdio MessagePort，
// pause/destroy 均无法释放，导致父进程永远等不到 exit。此处已经确认
// prepareStorageOnly 返回（库已关闭、storagePrepared 写回调完成），显式结束
// 只是释放该句柄，不是超时绕过或伪造 storage ready。
process.stdin.destroy();
process.exit(exitCode);
