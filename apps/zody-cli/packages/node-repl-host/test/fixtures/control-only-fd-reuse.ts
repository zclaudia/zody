import { closeSync, fstatSync, openSync, read, writeSync } from "node:fs";
import { promisify } from "node:util";
import {
  createControlChannel,
  type ControlChannelClosedEvent,
} from "@zody/zody-cua/control-channel";
import { createProducerControlOwner } from "@zody/zody-cua/producer-control";
import { runControlOnlyMain } from "../../src/control-only.js";
import {
  createControlDuplex,
  parseBootstrap,
  readBootstrapLine,
  writeReady,
} from "../../src/control-only-protocol.js";

const readFd = promisify(read);

async function writeReport(value: unknown): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, () => resolve());
  });
}

async function main(): Promise<void> {
  if (process.env.ZCONTROL_READY_WRITE_DIAGNOSTIC) {
    const material = parseBootstrap(await readBootstrapLine(3));
    let precheck = false;
    try {
      fstatSync(4);
      precheck = true;
    } catch {
      // The diagnostic reports the precheck result; writeReady performs its own check.
    }
    await new Promise<void>((resolve) => {
      process.stdout.write("ready-fstat-precheck\n", () => resolve());
    });
    // 屏障：父端看到 precheck 后只关闭 fd4 的读端，再写入 1 字节放行。
    // 写端仍有效，因此 writeReady 的 fstat 会通过，失败只能来自真实写入。
    await readFd(0, Buffer.alloc(1), 0, 1, null);
    let phase = "ready_write_succeeded";
    let cause: string | null = null;
    try {
      await writeReady(4, material);
    } catch (error) {
      const entry = error as {
        code?: string;
        cause?: NodeJS.ErrnoException;
      };
      phase = entry.code ?? "unknown";
      cause = entry.cause?.code ?? entry.cause?.message ?? null;
    }
    await writeReport({ cause, phase, precheck });
    process.exitCode = 0;
    return;
  }

  const controlReuseFile = process.env.ZCONTROL_CONTROL_FD_REUSE_FILE;
  if (controlReuseFile) {
    const material = parseBootstrap(await readBootstrapLine(3));
    const owner = createProducerControlOwner();
    let closedCount = 0;
    const duplex = await createControlDuplex(5, 6);
    const channel = createControlChannel({
      binding: material.binding,
      duplex,
      keyId: material.producerKeyId,
      onClosed: () => {
        closedCount += 1;
        owner.close();
      },
      onRequest: (request) => owner.onRequest(request),
      privateKey: material.producerPrivateKey,
      role: "producer",
      trustedKeys: { [material.controllerKeyId]: material.controllerPublicKey },
    });
    try {
      await writeReady(4, material);
      await channel.dispose();
      // fd3 在 bootstrap 后关闭，fd4 在 ready 写完后关闭；先用填充 fd 占住 3/4，
      // 再打开目标文件，断言它们实际复用了 fd5/6。
      const fillerA = openSync(controlReuseFile, "w");
      const fillerB = openSync(controlReuseFile, "w");
      const reusedA = openSync(controlReuseFile, "w");
      const reusedB = openSync(controlReuseFile, "w");
      let writeError: string | null = null;
      try {
        // 第二次 dispose 发生在 fd5/6 已被复用之后；必须幂等且不得误关这些 fd。
        await channel.dispose();
        writeSync(reusedA, "reused-fd5");
        writeSync(reusedB, "reused-fd6");
      } catch (error) {
        writeError = (error as NodeJS.ErrnoException).code ?? "unknown";
      }
      for (const fd of [fillerA, fillerB, reusedA, reusedB]) {
        try {
          closeSync(fd);
        } catch {
          // The write/close assertion above is the observable result.
        }
      }
      await writeReport({
        closedCount,
        code: 0,
        reused: [reusedA, reusedB],
        writeError,
      });
      process.exitCode = 0;
    } finally {
      owner.close();
      await channel.dispose().catch(() => undefined);
    }
    return;
  }

  if (process.env.ZCONTROL_HALF_CLOSE_REPORT) {
    let closedCount = 0;
    const code = await runControlOnlyMain({
      argv: [process.execPath, "control-only-half-close", "--zody-node-repl-control"],
      onClosed: () => {
        closedCount += 1;
      },
    });
    await writeReport({ closedCount, code });
    process.exitCode = code;
    return;
  }

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
    let closedCount = 0;
    let closedCode: string | null = null;
    const code = await runControlOnlyMain({
      argv: [process.execPath, "control-only-missing-fd", "--zody-node-repl-control"],
      ...(selected === 3 ? { bootstrapFd: unavailable } : {}),
      ...(selected === 4 ? { readyFd: unavailable } : {}),
      ...(selected === 5 ? { controlReadFd: unavailable } : {}),
      ...(selected === 6 ? { controlWriteFd: unavailable } : {}),
      ...(selected === 4
        ? {
            onClosed: (event: ControlChannelClosedEvent) => {
              closedCount += 1;
              closedCode = event.code;
            },
          }
        : {}),
    });
    // ready 失败发生在 transport 建立之后；返回时 fd5/6 必须已由 dispose 关闭。
    // 其余缺失 fd 在 transport 成立前失败，仍归父进程所有，不能在子进程断言。
    let transportClosed: boolean | undefined;
    if (selected === 4) {
      transportClosed = [5, 6].every((fd) => {
        try {
          fstatSync(fd);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "EBADF";
        }
      });
    }
    await writeReport({
      code,
      selected,
      verified: "EBADF",
      ...(transportClosed === undefined ? {} : { transportClosed }),
      ...(selected === 4 ? { closedCode, closedCount } : {}),
    });
    // 自然退出：不调用 process.exit，父端保持 fd5 peer 打开，由事件循环自行排空。
    process.exitCode = code;
    return;
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
  await writeReport({ code, reusedFd, writeError });
  process.exitCode = code;
}

await main();
