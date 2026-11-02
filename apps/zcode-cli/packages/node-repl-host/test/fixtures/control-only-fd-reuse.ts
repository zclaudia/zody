import { closeSync, openSync, writeSync } from "node:fs";
import { createProducerControlOwner } from "@zcode/zcode-cua/producer-control";
import { runControlOnlyMain } from "../../src/control-only.js";

const filePath = process.env.ZCONTROL_FD_REUSE_FILE;
if (!filePath) throw new Error("ZCONTROL_FD_REUSE_FILE is required");

let reusedFd = -1;
const code = await runControlOnlyMain({
  argv: [process.execPath, "control-only-fd-reuse", "--zcode-node-repl-control"],
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
