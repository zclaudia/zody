import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { clickR1AllowOnce } from "./cua-r1-dialog.js";
import { waitRead } from "./cua-r1-lifecycle.js";
import type { R1Fixture } from "./cua-r1-receipt.js";
export {
  evaluateReadTrial,
  summarizeReadTrials,
  type ReadTrialScore,
} from "../../../scripts/lib/cua-r1-read-trial.mjs";

type ReadEvent = {
  pid: number;
  observationId: number;
  sequence: number;
  scopeDigest: string;
  event: string;
};
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
export async function readOptional(path: string): Promise<any> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export async function readCEvents(): Promise<ReadEvent[]> {
  const directory = process.env.ZODY_LOG_DIR;
  if (!directory) throw new Error("R1 actual worker CLI log directory missing");
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const logs = await Promise.all(
    names
      .filter((name) => /^zody-.*\.jsonl$/.test(name))
      .sort()
      .map((name) => readFile(resolve(directory, name), "utf8")),
  );
  return logs.flatMap((log) =>
    log
      .split("\n")
      .slice(0, -1)
      .flatMap((line) => {
        const entry = JSON.parse(line) as { message?: unknown };
        return typeof entry.message === "string" && entry.message.startsWith("cua-read-delivery: ")
          ? [JSON.parse(entry.message.slice(19)) as ReadEvent]
          : [];
      }),
  );
}
export async function writeCControl(directory: string, name: string, value: unknown) {
  const temporary = resolve(directory, `${name}.tmp`);
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, resolve(directory, name));
}
async function until<T>(read: () => Promise<T | null>, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await pause(10);
  }
  throw new Error("R1 real observation/monitor evidence timed out");
}
export async function observeCTrial(input: {
  fixture: R1Fixture;
  kind: string;
  index: number;
  runtime: string;
  monitor: string;
  reads: Set<string>;
}) {
  const { fixture, kind, index, runtime, monitor, reads } = input;
  const trialId = `${kind}-${index}`;
  const prior = new Set(
    (await readCEvents())
      .filter((event) => event.event === "allowed")
      .map((event) => `${event.pid}:${event.observationId}`),
  );
  const requestId = await waitRead(fixture, reads);
  await writeCControl(monitor, "command.json", { sequence: index * 2 + 1, kind: "begin", trialId });
  const ack = await until(async () => {
    const value = await readOptional(resolve(monitor, "monitor-ack.json"));
    return value?.trialId === trialId ? value : null;
  });
  if (!ack.sample.active || !ack.sample.key)
    throw new Error("R1 input monitor must stay foreground before approving read");
  await clickR1AllowOnce("read", requestId);
  const allowed = await until(
    async () =>
      (await readCEvents()).find(
        (event) => event.event === "allowed" && !prior.has(`${event.pid}:${event.observationId}`),
      ) ?? null,
  );
  const baseline = (await readOptional(resolve(monitor, "last-key.json")))?.key?.sequence ?? 0;
  let witnessKey: number | undefined;
  const deadline = Date.now() + 15_000;
  let delivered: ReadEvent | undefined;
  while (Date.now() < deadline) {
    const key = await readOptional(resolve(monitor, "last-key.json"));
    const events = await readCEvents();
    delivered = events.find(
      (event) =>
        event.pid === allowed.pid &&
        event.observationId === allowed.observationId &&
        event.event === "delivered",
    );
    if (key?.trialId === trialId && key.key.sequence > baseline && !delivered)
      witnessKey ??= key.key.sequence;
    if (delivered) break;
    await pause(5);
  }
  if (!delivered) throw new Error("R1 C read never delivered");
  const result = await until(() => readOptional(resolve(runtime, `result-${index}.json`)));
  await writeCControl(monitor, "command.json", { sequence: index * 2 + 2, kind: "end", trialId });
  const record = await until(() => readOptional(resolve(monitor, `${trialId}.json`)));
  return {
    trialId,
    kind,
    requestId,
    monitor: record,
    read: { allowed, delivered },
    result,
    witness: {
      trialId,
      keySequence: witnessKey ?? null,
      allowedObservedBeforeWitnessArm: true,
      deliveryAbsentAfterKeyObserved: witnessKey !== undefined,
    },
  };
}
