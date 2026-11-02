import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
const resolver = vi.hoisted(() => vi.fn());
vi.mock("@zody/services/storage-startup", () => ({ resolveDefaultZCodeAgentCommand: resolver }));
import {
  prepareHostStorage,
  prepareSessionStorage,
} from "../src/host/storagePreparationProcesses.js";

function dataWorkerUrl(source: string): URL {
  return new URL(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

function sha256(source: string): string {
  return createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex");
}

it("uses the explicitly injected sealed tasks storage worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-host-preparation-worker-"));
  const source = `
    import { parentPort, workerData } from 'node:worker_threads';
    parentPort.postMessage({ type: 'progress', phase: 'checking' });
    if (workerData.path !== ${JSON.stringify(join(dir, "tasks.sqlite"))}) process.exit(9);
    parentPort.postMessage({ type: 'done' });
  `;
  const phases: string[] = [];
  try {
    await prepareHostStorage(
      join(dir, "tasks.sqlite"),
      (phase) => phases.push(phase),
      new AbortController().signal,
      { workerUrl: dataWorkerUrl(source) },
    );
    expect(phases).toEqual(["checking"]);
    await expect(
      prepareHostStorage(
        join(dir, "tasks.sqlite"),
        () => {},
        new AbortController().signal,
        { workerUrl: new URL("file:///tmp/tasksStorageWorker.mjs") },
      ),
    ).rejects.toThrow(/data: ESM URL/);
    expect(sha256(source)).toMatch(/^[0-9a-f]{64}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("uses a Host-owned Worker and waits for the preparation completion frame", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-preparation-worker-"));
  const source = `
    import readline from 'node:readline';
    import { isMainThread } from 'node:worker_threads';
    if (isMainThread) process.exit(5);
    const cwd = process.argv[process.argv.indexOf('--cwd') + 1];
    const lines = readline.createInterface({ input: process.stdin });
    lines.once('line', () => {
      process.stdout.write(JSON.stringify({method:'startup/storagePrepared',params:{}})+'\\n', () => process.exit(0));
    });
    process.stdout.write(JSON.stringify({method:'startup/storagePath',params:{path:cwd+'/relative.sqlite'}})+'\\n');
  `;
  const paths: string[] = [];
  try {
    await prepareSessionStorage({
      cwd: dir,
      storagePreparationEntryUrl: dataWorkerUrl(source),
      signal: new AbortController().signal,
      report: () => {},
      observePath: async (path) => {
        paths.push(path);
      },
    });
    expect(paths).toEqual([dir + "/relative.sqlite"]);
    await expect(
      prepareSessionStorage({
        cwd: dir,
        storagePreparationEntryUrl: dataWorkerUrl("process.exit(0)"),
        signal: new AbortController().signal,
        report: () => {},
        observePath: async () => {},
      }),
    ).rejects.toThrow("transport_closed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("SILENTDB-06: reuses only successful paths in this attempt and keeps different databases separate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-preparation-dedup-"));
  const entry = join(dir, "prepare.cjs");
  await writeFile(
    entry,
    `
    const readline = require('node:readline');
    const lines = readline.createInterface({ input: process.stdin });
    const path = process.env.TEST_DB_PATH;
    const send = frame => process.stdout.write(JSON.stringify(frame)+'\\n');
    lines.once('line', line => {
      const reuse = JSON.parse(line).reuse;
      if (!reuse) send({method:'startup/storageState',params:{schemaVersion:1,attemptId:'attempt',sequence:1,databaseId:'db',databaseKind:'session',phase:'checking',elapsedMs:0}});
      process.stdout.write(JSON.stringify({method:'startup/storagePrepared',params:{}})+'\\n', () => process.exit(process.env.TEST_FAIL === 'yes' ? 1 : 0));
    });
    send({method:'startup/storagePath',params:{path}});
  `,
  );
  resolver.mockReturnValue({
    command: process.execPath,
    args: [],
    supportsStorageStartup: true,
    storagePreparationEntry: entry,
  });
  const preparedPaths = new Set<string>();
  const report = vi.fn();
  const observePath = vi.fn(async () => {});
  const prepare = (name: string, fail = false) =>
    prepareSessionStorage({
      cwd: dir,
      env: { TEST_DB_PATH: join(dir, name), TEST_FAIL: fail ? "yes" : "no" },
      signal: new AbortController().signal,
      report,
      observePath,
      preparedPaths,
    });
  try {
    await prepare("shared.sqlite");
    await prepare("shared.sqlite");
    expect(observePath).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    await prepare("other.sqlite");
    expect(observePath).toHaveBeenCalledTimes(2);
    await expect(prepare("failed.sqlite", true)).rejects.toThrow("transport_closed");
    expect(preparedPaths.has(join(dir, "failed.sqlite"))).toBe(false);
    await prepare("failed.sqlite");
    expect(observePath).toHaveBeenCalledTimes(4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("uses an explicit sealed session storage entry without default command discovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-preparation-explicit-"));
  const source = `
    import readline from 'node:readline';
    const lines = readline.createInterface({ input: process.stdin });
    process.stdout.write(JSON.stringify({method:'startup/storagePath',params:{path:process.env.TEST_DB_PATH}})+'\\n');
    lines.once('line', () => {
      process.stdout.write(JSON.stringify({method:'startup/storagePrepared',params:{}})+'\\n', () => process.exit(0));
    });
  `;
  resolver.mockClear();
  try {
    await prepareSessionStorage({
      cwd: dir,
      env: { TEST_DB_PATH: join(dir, "explicit.sqlite") },
      storagePreparationEntryUrl: dataWorkerUrl(source),
      signal: new AbortController().signal,
      report: () => {},
      observePath: async () => {},
    });
    expect(resolver).not.toHaveBeenCalled();
    await expect(
      prepareSessionStorage({
        cwd: dir,
        storagePreparationEntryUrl: new URL("file:///tmp/session-entry.mjs"),
        signal: new AbortController().signal,
        report: () => {},
        observePath: async () => {},
      }),
    ).rejects.toThrow(/data: ESM URL/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
