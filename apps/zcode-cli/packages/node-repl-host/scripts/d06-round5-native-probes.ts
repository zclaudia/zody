import { readFile, writeFile } from "node:fs/promises";
import { D06_CANARY_CONTENT } from "./d06-resources.js";
import type { D06Round5Observation } from "./d06-round5-policy.js";
import {
  CELL_CLASSIFY,
  asRecord,
  extractData,
  stageOf,
  type D06Round5ProbeContext,
} from "./d06-round5-probe-common.js";
import { sha256File, type D06Round5Paths } from "./d06-round5-resources.js";
import { runProbeCell } from "./d06-probe-runtime.js";

export const D06_FFI_OPEN_FLAGS = 0x1 | 0x200 | 0x400;

export async function runNativeAddonProbe(
  context: D06Round5ProbeContext,
  addon: { path: string; sha256: string; bytes: number },
): Promise<D06Round5Observation> {
  await writeFile(context.paths.nativeWritePath, D06_CANARY_CONTENT, "utf8");
  await writeFile(context.paths.canaryWritePath, D06_CANARY_CONTENT, "utf8");
  const addonBefore = await sha256File(addon.path);
  const fork = await runProbeCell(
    context.forkExecutor,
    nativeCellCode(context.paths, addon.path, "control"),
  );
  const isolated = await runProbeCell(
    context.seatbeltExecutor,
    nativeCellCode(context.paths, addon.path, "isolated"),
  );
  const addonAfter = await sha256File(addon.path);
  const control = extractData(fork.raw);
  const isolatedData = extractData(isolated.raw);
  const diskNative = await readFile(context.paths.nativeWritePath, "utf8").catch(() => "");
  const diskIsolated = await readFile(context.paths.canaryWritePath, "utf8").catch(() => "");
  const controlRead = asRecord(control.read);
  const controlWrite = asRecord(control.write);
  const controlAfter = asRecord(control.after);
  const controlSpawn = asRecord(control.spawn);
  const isolatedRead = asRecord(isolatedData.read);
  const isolatedWrite = asRecord(isolatedData.write);
  const isolatedSpawn = asRecord(isolatedData.spawn);
  const isolatedStage = stageOf(isolated);
  return {
    outcome: isolated.outcome === "blocked" ? "blocked" : "allowed",
    stage:
      isolatedStage === "load-denied" || isolatedStage === "not-loaded" ? isolatedStage : "loaded",
    checks: {
      "native include exists": true,
      "clang executed": true,
      "addon compiled": true,
      "control addon loaded": controlStageOk(fork, control),
      "control POSIX read allowed":
        controlRead.ok === true && controlRead.data === D06_CANARY_CONTENT,
      "control POSIX write allowed":
        controlWrite.ok === true &&
        controlAfter.data === "D06_NATIVE_WRITE" &&
        diskNative === "D06_NATIVE_WRITE",
      "control POSIX spawn allowed": controlSpawn.ok === true && controlSpawn.status === 0,
      "isolated addon loaded": isolatedStage === "loaded",
      "isolated POSIX read denied": nativeDenied(isolatedRead),
      "isolated POSIX write denied": nativeDenied(isolatedWrite),
      "isolated write canary unchanged": diskIsolated === D06_CANARY_CONTENT,
      "isolated POSIX spawn denied": nativeSpawnDenied(isolatedSpawn),
      "control and isolated share addon hash":
        addonBefore.sha256 === addonAfter.sha256 && addonAfter.sha256 === addon.sha256,
    },
    raw: {
      control,
      isolated: { stage: isolatedStage, data: isolatedData },
      addonHashes: { before: addonBefore.sha256, after: addonAfter.sha256 },
    },
  };
}

export async function runFfiProbe(
  context: D06Round5ProbeContext,
  koffi: {
    indexPath: string;
    nativePath: string;
    indexSha256: string;
    nativeSha256: string;
  },
): Promise<D06Round5Observation> {
  await writeFile(context.paths.ffiWritePath, D06_CANARY_CONTENT, "utf8");
  await writeFile(context.paths.canaryWritePath, D06_CANARY_CONTENT, "utf8");
  const indexBefore = await sha256File(koffi.indexPath);
  const nativeBefore = await sha256File(koffi.nativePath);
  const fork = await runProbeCell(
    context.forkExecutor,
    ffiCellCode(context.paths, koffi.indexPath, "control"),
  );
  const isolated = await runProbeCell(
    context.seatbeltExecutor,
    ffiCellCode(context.paths, koffi.indexPath, "isolated"),
  );
  const indexAfter = await sha256File(koffi.indexPath);
  const nativeAfter = await sha256File(koffi.nativePath);
  const control = extractData(fork.raw);
  const isolatedData = extractData(isolated.raw);
  const diskFfi = await readFile(context.paths.ffiWritePath, "utf8").catch(() => "");
  const diskCanary = await readFile(context.paths.canaryWritePath, "utf8").catch(() => "");
  const controlRead = asRecord(control.read);
  const controlWrite = asRecord(control.write);
  const isolatedRead = asRecord(isolatedData.read);
  const isolatedWrite = asRecord(isolatedData.write);
  const isolatedStage = stageOf(isolated);
  return {
    outcome: isolated.outcome === "blocked" ? "blocked" : "allowed",
    stage:
      isolatedStage === "load-denied" || isolatedStage === "not-loaded" ? isolatedStage : "loaded",
    checks: {
      "koffi index fixed hash": fixedHashMatches(
        indexBefore.sha256,
        indexAfter.sha256,
        koffi.indexSha256,
      ),
      "koffi native fixed hash": fixedHashMatches(
        nativeBefore.sha256,
        nativeAfter.sha256,
        koffi.nativeSha256,
      ),
      "control FFI loaded": controlStageOk(fork, control),
      "control libc read allowed":
        controlRead.ok === true && controlRead.data === D06_CANARY_CONTENT,
      "control libc write allowed": ffiControlWriteAllowed(controlWrite, diskFfi, "D06_FFI_WRITE"),
      "isolated FFI loaded": isolatedStage === "loaded",
      "isolated libc read denied": ffiDenied(isolatedRead),
      "isolated libc write denied": ffiDenied(isolatedWrite),
      "isolated write canary unchanged": diskCanary === D06_CANARY_CONTENT,
      "control and isolated share koffi hash":
        fixedHashMatches(indexBefore.sha256, indexAfter.sha256, koffi.indexSha256) &&
        fixedHashMatches(nativeBefore.sha256, nativeAfter.sha256, koffi.nativeSha256),
    },
    raw: {
      control,
      isolated: { stage: isolatedStage, data: isolatedData },
      koffiHashes: {
        expected: { index: koffi.indexSha256, native: koffi.nativeSha256 },
        index: { before: indexBefore.sha256, after: indexAfter.sha256 },
        native: { before: nativeBefore.sha256, after: nativeAfter.sha256 },
      },
      disk: {
        ffi: diskFfi,
        ffiBytes: Buffer.byteLength(diskFfi),
        canary: diskCanary,
      },
    },
  };
}

function nativeCellCode(
  paths: D06Round5Paths,
  addonPath: string,
  mode: "control" | "isolated",
): string {
  const writePath = mode === "control" ? paths.nativeWritePath : paths.canaryWritePath;
  const writeValue = mode === "control" ? "D06_NATIVE_WRITE" : "D06_SANDBOX_NATIVE_WRITE";
  return [
    CELL_CLASSIFY,
    `const addonPath = ${JSON.stringify(addonPath)};`,
    "let addon;",
    "try { addon = require(addonPath); } catch (error) { return d06LoadError(error); }",
    `const read = d06Parse(addon.readPath(${JSON.stringify(paths.canaryReadPath)}));`,
    `const write = d06Parse(addon.writePath(${JSON.stringify(writePath)}, ${JSON.stringify(writeValue)}));`,
    `const after = d06Parse(addon.readPath(${JSON.stringify(writePath)}));`,
    "const spawn = d06Parse(addon.spawnTrue());",
    'return { outcome: "allowed", stage: "loaded", data: { read, write, after, spawn } };',
  ].join("\n");
}

function ffiCellCode(
  paths: D06Round5Paths,
  koffiIndex: string,
  mode: "control" | "isolated",
): string {
  const writePath = mode === "control" ? paths.ffiWritePath : paths.canaryWritePath;
  const writeValue = mode === "control" ? "D06_FFI_WRITE" : "D06_SANDBOX_FFI_WRITE";
  return [
    CELL_CLASSIFY,
    `let koffi; try { koffi = require(${JSON.stringify(koffiIndex)}); } catch (error) { return d06LoadError(error); }`,
    "const libc = koffi.load('/usr/lib/libSystem.B.dylib');",
    "const open = libc.func('int open(const char *path, int flags, int mode)');",
    "const read = libc.func('long read(int fd, void *buf, unsigned long count)');",
    "const write = libc.func('long write(int fd, const void *buf, unsigned long count)');",
    "const close = libc.func('int close(int fd)');",
    `let fd = open(${JSON.stringify(paths.canaryReadPath)}, 0, 0);`,
    "const readResult = fd < 0 ? { ok: false, errno: koffi.errno() } : (() => { const buffer = koffi.alloc('uint8', 32); const count = read(fd, buffer, 32); const errno = koffi.errno(); close(fd); return count < 0 ? { ok: false, errno } : { ok: true, data: Buffer.from(koffi.decode(buffer, 'uint8', count)).toString('utf8') }; })();",
    `// Darwin O_WRONLY | O_CREAT | O_TRUNC：截断旧 canary，避免 payload 尾部残留。`,
    `fd = open(${JSON.stringify(writePath)}, ${D06_FFI_OPEN_FLAGS}, 0);`,
    `const writeResult = fd < 0 ? { ok: false, errno: koffi.errno() } : (() => { const payload = Buffer.from(${JSON.stringify(writeValue)}); const count = write(fd, payload, payload.length); const errno = koffi.errno(); close(fd); return count < 0 ? { ok: false, errno } : { ok: true, bytes: count, expectedBytes: payload.length, flags: ${D06_FFI_OPEN_FLAGS} }; })();`,
    'return { outcome: "allowed", stage: "loaded", data: { read: readResult, write: writeResult } };',
  ].join("\n");
}

export function fixedHashMatches(before: string, after: string, expected: string): boolean {
  return /^[a-f0-9]{64}$/u.test(expected) && before === expected && after === expected;
}

export function ffiControlWriteAllowed(
  value: Record<string, unknown>,
  disk: string,
  expected: string,
): boolean {
  return value.ok === true && value.bytes === Buffer.byteLength(expected) && disk === expected;
}

function controlStageOk(result: D06Round5Observation, data: Record<string, unknown>): boolean {
  return stageOf(result) === "loaded" && data.read !== undefined;
}

function nativeDenied(value: Record<string, unknown>): boolean {
  return value.ok === false && (value.errno === 1 || value.errno === 13);
}

function nativeSpawnDenied(value: Record<string, unknown>): boolean {
  return value.ok === false && value.stage === "spawn" && (value.errno === 1 || value.errno === 13);
}

function ffiDenied(value: Record<string, unknown>): boolean {
  return value.ok === false && (value.errno === 1 || value.errno === 13);
}
