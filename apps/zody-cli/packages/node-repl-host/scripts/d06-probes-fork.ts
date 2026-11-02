import { open, readFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { D06CaseResult } from "./d06-policy.js";
import { runCase, runProbeCell, type D06ProbeContext } from "./d06-probe-runtime.js";
import { D06_CANARY_CONTENT, errorText, waitForDead } from "./d06-resources.js";

const CLASSIFY = [
  "const d06Classify = (error) => {",
  '  const cause = error && typeof error === "object" ? error.cause : undefined;',
  '  const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : null;',
  '  const causeCode = cause && typeof cause === "object" && typeof cause.code === "string" ? cause.code : null;',
  '  const denial = code === "EPERM" || code === "EACCES" || causeCode === "EPERM" || causeCode === "EACCES";',
  '  return { outcome: denial ? "denied" : "error", code, causeCode, detail: error instanceof Error ? error.message : String(error) };',
  "};",
].join("\n");

export async function runForkProbes(context: D06ProbeContext): Promise<D06CaseResult[]> {
  return [
    await runCase("fork-canary-read-write", "fork", "allowed", async () => {
      const code = [
        'const fs = require("node:fs");',
        "try {",
        `  const before = fs.readFileSync(${JSON.stringify(context.paths.canaryReadPath)}, "utf8");`,
        `  fs.writeFileSync(${JSON.stringify(context.paths.canaryWritePath)}, "D06_FORK_WRITE", "utf8");`,
        `  const after = fs.readFileSync(${JSON.stringify(context.paths.canaryWritePath)}, "utf8");`,
        '  return { outcome: "allowed", data: { before, after } };',
        "} catch (error) { return d06Classify(error); }",
      ].join("\n");
      const observed = await runProbeCell(context.forkExecutor, `${CLASSIFY}\n${code}`);
      const disk = await readFile(context.paths.canaryWritePath, "utf8").catch(() => "");
      const data = extractData(observed.raw);
      return {
        ...observed,
        checks: {
          "trusted canary read": data.before === D06_CANARY_CONTENT,
          "trusted canary write": data.after === "D06_FORK_WRITE" && disk === "D06_FORK_WRITE",
        },
      };
    }),
    await runCase("fork-dynamic-import", "fork", "allowed", async () => {
      const moduleUrl = pathToFileURL(context.paths.importCanaryPath).href;
      const code = [
        "try {",
        `  const loaded = await import(${JSON.stringify(moduleUrl)});`,
        '  return { outcome: "allowed", data: { marker: loaded.marker } };',
        "} catch (error) { return d06Classify(error); }",
      ].join("\n");
      const observed = await runProbeCell(context.forkExecutor, `${CLASSIFY}\n${code}`);
      return {
        ...observed,
        checks: {
          "dynamic import executed": extractData(observed.raw).marker === "D06_DYNAMIC_IMPORT",
        },
      };
    }),
    await runCase("fork-child-bounded", "fork", "allowed", async () => {
      const pidFile = join(context.paths.root, "fork-child.pid");
      const code = [
        'const fs = require("node:fs");',
        'const { spawn } = require("node:child_process");',
        "try {",
        `  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 250)"], { stdio: "ignore" });`,
        `  fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid ?? ""), "utf8");`,
        "  const exit = await new Promise((resolve) => {",
        '    child.once("error", (error) => resolve({ code: error.code ?? null }));',
        '    child.once("exit", (code, signal) => resolve({ code, signal }));',
        "  });",
        '  return { outcome: "allowed", data: { childPid: child.pid ?? null, exit } };',
        "} catch (error) { return d06Classify(error); }",
      ].join("\n");
      let childPid: number | undefined;
      try {
        const observed = await runProbeCell(context.forkExecutor, `${CLASSIFY}\n${code}`);
        const data = extractData(observed.raw);
        childPid = typeof data.childPid === "number" ? data.childPid : undefined;
        const exit = data.exit as { code?: number | null } | undefined;
        const dead = childPid ? await waitForDead(childPid) : false;
        return {
          ...observed,
          checks: {
            "short-lived child exited": exit?.code === 0,
            "short-lived child reclaimed": dead,
          },
        };
      } finally {
        // 子进程只运行 250ms 且 cell 已 await exit；这里只等待可关联的 pid 消失，
        // 不对已退出或可能被复用的 pid 发信号。
        const filePid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
        if (Number.isInteger(filePid) && filePid > 0) await waitForDead(filePid, 3_000);
      }
    }),
    await runCase("fork-env-secret-stripped", "fork", "allowed", async () => {
      const observed = await runProbeCell(
        context.forkExecutor,
        'return { outcome: "allowed", data: { env: process.env, execArgv: process.execArgv } };',
      );
      const data = extractData(observed.raw);
      const env = (data.env ?? {}) as Record<string, string>;
      const execArgv = Array.isArray(data.execArgv) ? data.execArgv : ["unexpected"];
      return {
        ...observed,
        checks: {
          "synthetic ZCODE secret absent": !Object.keys(env).some((key) =>
            key.startsWith("ZCODE_"),
          ),
          "synthetic cloud secret absent": env.AWS_SECRET_ACCESS_KEY === undefined,
          "NODE_OPTIONS absent": env.NODE_OPTIONS === undefined,
          "execArgv empty": execArgv.length === 0,
        },
      };
    }),
    await runCase("fork-parent-extra-fd-not-inherited", "fork", "allowed", async () => {
      const extraFd = await openExtraFd(context.paths.canaryReadPath);
      try {
        const parentStat = await extraFd.handle.stat({ bigint: true });
        const code = [
          'const fs = require("node:fs");',
          "try {",
          `  const stat = fs.fstatSync(${extraFd.handle.fd}, { bigint: true });`,
          '  return { outcome: "allowed", data: { stat: { dev: String(stat.dev), ino: String(stat.ino) } } };',
          "} catch (error) {",
          '  return { outcome: "allowed", data: { error: { code: error.code ?? null, message: String(error.message) } } };',
          "}",
        ].join("\n");
        const observed = await runProbeCell(context.forkExecutor, code);
        const data = extractData(observed.raw);
        const childStat = (data.stat ?? {}) as Record<string, unknown>;
        const childError = (data.error ?? {}) as Record<string, unknown>;
        const sameIdentity =
          childStat.dev === String(parentStat.dev) && childStat.ino === String(parentStat.ino);
        const notInherited = data.stat !== undefined ? !sameIdentity : childError.code === "EBADF";
        return {
          ...observed,
          checks: {
            "probe fd is outside stdio range": extraFd.handle.fd > 4,
            "parent canary fd not inherited": notInherited,
            "child fd evidence is EBADF or different identity": notInherited,
          },
        };
      } finally {
        await extraFd.closeAll().catch((error: unknown) => {
          throw new Error(`failed to close parent canary fds: ${errorText(error)}`);
        });
      }
    }),
  ];
}

function extractData(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const data = (raw as Record<string, unknown>).data;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

async function openExtraFd(
  path: string,
): Promise<{ handle: FileHandle; closeAll(): Promise<void> }> {
  const handles: FileHandle[] = [];
  const closeAll = async () => {
    await Promise.all(handles.map((handle) => handle.close()));
  };
  try {
    // 保留低编号句柄，避免关闭后立刻被下一次 open 复用；最多 5 次，超限明确失败。
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const handle = await open(path, "r");
      handles.push(handle);
      if (handle.fd > 4) return { handle, closeAll };
    }
    throw new Error("could not open a parent canary fd above stdio range");
  } catch (error) {
    await closeAll().catch(() => undefined);
    throw error;
  }
}
