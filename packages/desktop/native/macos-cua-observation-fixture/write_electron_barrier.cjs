"use strict";
const { readFile, writeFile, rename } = require("node:fs/promises");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function createWriteBarrier(directory, timeout = 700) {
  const nonce = randomUUID();
  let sequence = 0;
  return {
    nonce,
    async wait() {
      const current = ++sequence;
      const pending = { nonce, sequence: current };
      await writeFile(join(directory, "write-pending.tmp"), JSON.stringify(pending), {
        mode: 0o600,
      });
      await rename(join(directory, "write-pending.tmp"), join(directory, "write-pending.json"));
      const until = performance.now() + timeout;
      while (performance.now() < until) {
        try {
          const release = JSON.parse(await readFile(join(directory, "write-release.json"), "utf8"));
          // 中文原因：只接纳本进程随机 nonce 与本次严格数字序号，旧文件或其他运行不能释放业务效果。
          if (
            Object.keys(release).length === 2 &&
            release.nonce === nonce &&
            Number.isSafeInteger(release.sequence) &&
            release.sequence === current
          )
            return true;
        } catch (error) {
          if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        }
        await pause(3);
      }
      return false;
    },
  };
}
module.exports = { createWriteBarrier };
