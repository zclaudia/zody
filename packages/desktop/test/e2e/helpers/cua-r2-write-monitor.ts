import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readOptional, writeCControl } from "./cua-r1-read-monitor.js";
import { evaluateWriteTrial } from "../../../scripts/lib/cua-r2-write-trial.mjs";

const exec = promisify(execFile);
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function until<T>(read: () => Promise<T | null>, milliseconds = 3000): Promise<T> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await pause(5);
  }
  throw new Error("R2 actual monitor/barrier evidence timed out; action is never replayed");
}
export async function controlAudits(): Promise<any[]> {
  const directory = process.env.ZODY_E2E_RUNTIME_LOG_DIR;
  if (!directory) throw new Error("R2 worker desktop audit directory missing");
  const names = (await readdir(directory)).filter((name) => /^\d{4}-\d{2}-\d{2}\.log$/.test(name));
  const logs = await Promise.all(
    names.sort().map((name) => readFile(resolve(directory, name), "utf8")),
  );
  return logs.flatMap((log) =>
    log.split("\n").flatMap((line) => {
      const marker = "CUA native audit [cua-control] ";
      const at = line.indexOf(marker);
      if (at < 0) return [];
      return [JSON.parse(line.slice(at + marker.length))];
    }),
  );
}
export async function fixtureWindows(inspector: string, fixture: any): Promise<any[]> {
  const { stdout } = await exec(inspector, [String(fixture.pid)]);
  const windows = JSON.parse(stdout) as any[];
  return windows
    .filter((row) => [fixture.targetWindow, fixture.siblingWindow].includes(row.id))
    .map(({ id, pid, title }) => ({ id, pid, title }));
}
/** 人工等待在 SDK 调用之外完成；begin 后只允许有界机器屏障。 */
export async function beginWriteTrial(input: {
  fixturePath: string;
  monitor: string;
  inspector: string;
  method: "left_click" | "perform_action" | "set_value";
  index: number;
  trial: number;
  previousSequence: number;
}) {
  const { fixturePath, monitor, inspector, method, index, trial, previousSequence } = input;
  const before = JSON.parse(await readFile(fixturePath, "utf8"));
  if (before.barrierEnabled !== true)
    throw new Error("R2 live write requires actual enabled target barrier");
  const windowsBefore = await fixtureWindows(inspector, before);
  const prior = new Set((await controlAudits()).map((row) => JSON.stringify(row)));
  const trialId = `${method}-${trial}`;
  let order = 0;
  const witness: any = { trialId, beforeOrder: ++order };
  await writeCControl(monitor, "command.json", { sequence: index * 3 + 1, kind: "begin", trialId });
  const ack = await until(async () => {
    const a = await readOptional(resolve(monitor, "monitor-ack.json"));
    return a?.trialId === trialId && a.sequence === index * 3 + 1 ? a : null;
  });
  // 中文原因：旧监测进程或失焦不能等到写后才发现；真实 begin ACK 必须在批准控制前证明输入窗口就绪。
  if (!ack.sample?.active || !ack.sample?.key || !ack.sample?.firstResponder)
    throw new Error("R2 monitor must be foreground with its editor focused before control");
  let fenceRequest: any, baselineFence: any, pending: any, release: any;
  // 中文原因：先启动机器观察，再点击当前控制卡；700ms 业务屏障内不能依赖 WebDriver 慢轮询。
  const intersection = (async () => {
    pending = await until(async () => {
      const p = await readOptional(resolve(fixturePath, "..", "write-pending.json"));
      return p?.nonce === before.barrierNonce && p.sequence === previousSequence + 1 ? p : null;
    }, 30_000);
    witness.pendingOrder = ++order;
    fenceRequest = { sequence: index * 3 + 2, kind: "fence", trialId };
    witness.fenceRequestOrder = ++order;
    await writeCControl(monitor, "command.json", fenceRequest);
    baselineFence = await until(async () => {
      const a = await readOptional(resolve(monitor, "key-fence.json"));
      return a?.trialId === trialId && a.sequence === fenceRequest.sequence ? a : null;
    });
    witness.fenceAckOrder = ++order;
    witness.fenceCommandSequence = fenceRequest.sequence;
    witness.baselineKeySequence = baselineFence.keySequence;
    const observed = await until(async () => {
      const k = await readOptional(resolve(monitor, "last-key.json"));
      return k?.trialId === trialId &&
        k.key?.sequence > baselineFence.keySequence &&
        k.key.sourcePID === 0
        ? k
        : null;
    });
    witness.keyOrder = ++order;
    witness.keySequence = observed.key.sequence;
    witness.keyObservation = observed;
    release = { nonce: pending.nonce, sequence: pending.sequence };
    await writeCControl(resolve(fixturePath, ".."), "write-release.json", release);
    witness.releaseOrder = ++order;
  })();
  // 保留拒绝的 promise，后续统一落盘；后台异常不能被丢弃或充当成功。
  const intersectionOutcome = intersection.then(
    () => null,
    (error) => error as Error,
  );
  return {
    trialId,
    async finish(receipt: unknown, isError: boolean) {
      const error = await intersectionOutcome;
      const captureErrors: string[] = [];
      const after = await until(async () => {
        const a = JSON.parse(await readFile(fixturePath, "utf8"));
        return a.target.requests >= before.target.requests + 1 ? a : null;
      }).catch(async (error) => {
        captureErrors.push(String(error));
        return readOptional(fixturePath);
      });
      witness.effectOrder = ++order;
      const windowsAfter = await fixtureWindows(inspector, before).catch((error) => {
        captureErrors.push(String(error));
        return [];
      });
      await writeCControl(monitor, "command.json", {
        sequence: index * 3 + 3,
        kind: "end",
        trialId,
      });
      const observed = await until(() => readOptional(resolve(monitor, `${trialId}.json`))).catch(
        (error) => {
          captureErrors.push(String(error));
          return null;
        },
      );
      const audit = await until(async () => {
        const a = (await controlAudits()).filter((row) => !prior.has(JSON.stringify(row)));
        return a.length >= 2 ? a : null;
      }).catch(async (error) => {
        captureErrors.push(String(error));
        return (await controlAudits()).filter((row) => !prior.has(JSON.stringify(row)));
      });
      const record = {
        trialId,
        kind: before.appKind ?? "appkit",
        method,
        monitor: { ...observed, fenceRequest, baselineFence },
        barrier: { fixtureNonce: before.barrierNonce, previousSequence, pending, release },
        witness,
        native: { received: receipt !== undefined, isError, receipt, audit },
        effect: {
          before,
          after,
          windowsBefore,
          windowsAfter,
          ...(method === "set_value" ? { expectedValue: `E2E_R2_VALUE_${trial}` } : {}),
        },
        intersectionError: error?.message ?? null,
        captureErrors,
      };
      return { ...record, score: evaluateWriteTrial(record) };
    },
  };
}
