import { closeSync, fstatSync, openSync, writeSync } from "node:fs";
import { createProducerControlOwner } from "@zody/zody-cua/producer-control";
import { runControlOnlyMain } from "../../src/control-only.js";

const missingFd = process.env.ZCONTROL_MISSING_FD;
if (missingFd) {
  // 缺失标准描述符可能被 libuv 复用；在 Node 初始化后验证高位 fd 确为 EBADF。
  const unavailable = 9999;
  try {
    fstatSync(unavailable);
    throw new Error("expected unavailable fd");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
  }
  const selected = Number(missingFd);
  const code = await runControlOnlyMain({
    argv: [process.execPath, "control-only-missing-fd", "--zody-node-repl-control"],
    ...(selected === 3 ? { bootstrapFd: unavailable } : {}),
    ...(selected === 4 ? { readyFd: unavailable } : {}),
    ...(selected === 5 ? { controlReadFd: unavailable } : {}),
    ...(selected === 6 ? { controlWriteFd: unavailable } : {}),
  });
  process.stdout.write(`${JSON.stringify({ code, selected, verified: "EBADF" })}\n`);
  process.exit(code);
}

const filePath = process.env.ZCONTROL_FD_REUSE_FILE;
if (!filePath) throw new Error("ZCONTROL_FD_REUSE_FILE is required");

let reusedFd = -1;
const code = await runControlOnlyMain({
  argv: [process.execPath, "control-only-fd-reuse", "--zody-node-repl-control"],
  createOwner: () => {
    // bootstrap fd 已关闭；这里应复用最低空闲编号。旧实现会在 finally 再按数字 close，
    // 从而误关这个文件 fd。测试在 runControlOnlyMain 返回后仍写入文件来观察。
    reusedFd = openSync(filePath, "w");
    return createProducerControlOwner();
  },
});

let writeError: string | null = null;
try {
  writeSync(reusedFd, "fd-still-owned");
} catch (error) {
  writeError = (error as NodeJS.ErrnoException).code ?? "unknown";
}
try {
  closeSync(reusedFd);
} catch {
  // The assertion is the write result above.
}
process.stdout.write(`${JSON.stringify({ code, reusedFd, writeError })}\n`);
process.exit(code);
