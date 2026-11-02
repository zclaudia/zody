import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { NODE_REPL_BROWSER_BRIDGE_SYMBOL } from "../src/runtime-bridge.js";
import { D06_EXPECTED_NODE, isKnownMaskedModuleFailure, type D06CaseResult } from "./d06-policy.js";
import { runInspectorListenProbe } from "./d06-preflight.js";
import { runCase, runProbeCell, type D06ProbeContext } from "./d06-probe-runtime.js";
import { D06_CANARY_CONTENT, sha256File, waitForDead } from "./d06-resources.js";

export const SEATBELT_CASE_MANIFEST = [
  { id: "seatbelt-cell-health", expected: "allowed" },
  { id: "seatbelt-canary-read-denied", expected: "denied" },
  { id: "seatbelt-canary-write-denied", expected: "denied" },
  { id: "seatbelt-canary-import-denied", expected: "denied" },
  { id: "seatbelt-docs-read-only", expected: "allowed" },
  { id: "seatbelt-client-import-read-only", expected: "allowed" },
  { id: "seatbelt-tcp-denied", expected: "denied" },
  { id: "seatbelt-extra-unix-socket-denied", expected: "denied" },
  { id: "seatbelt-inspector-listen-denied", expected: "denied" },
  { id: "seatbelt-browser-fixture-allowed", expected: "allowed" },
  { id: "seatbelt-arbitrary-child-denied", expected: "denied" },
] as const;

const CLASSIFY = [
  "const d06Classify = (error) => {",
  '  const cause = error && typeof error === "object" ? error.cause : undefined;',
  '  const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : null;',
  '  const causeCode = cause && typeof cause === "object" && typeof cause.code === "string" ? cause.code : null;',
  '  const denial = code === "EPERM" || code === "EACCES" || causeCode === "EPERM" || causeCode === "EACCES";',
  '  return { outcome: denial ? "denied" : "error", code, causeCode, detail: error instanceof Error ? error.message : String(error) };',
  "};",
].join("\n");

export async function runSeatbeltProbes(context: D06ProbeContext): Promise<D06CaseResult[]> {
  // fork 反例会故意改写 canary；进入 seatbelt 写拒绝测试前恢复基准内容，避免跨组污染。
  await writeFile(context.paths.canaryWritePath, D06_CANARY_CONTENT, "utf8");
  return [
    await runCase("seatbelt-cell-health", "seatbelt", "allowed", async () => {
      const code = [
        'return { outcome: "allowed", data: { pid: process.pid, node: process.version, cwd: process.cwd(), value: 40 + 2, argv: process.argv, execArgv: process.execArgv } };',
      ].join("\n");
      const observed = await runProbeCell(context.seatbeltExecutor, code);
      const data = extractData(observed.raw);
      const pid = typeof data.pid === "number" ? data.pid : 0;
      const dead = pid > 0 ? await waitForDead(pid) : false;
      return {
        ...observed,
        checks: {
          "cell is a child process": pid > 0 && pid !== process.pid,
          "cell uses expected Node": data.node === `v${D06_EXPECTED_NODE}`,
          "cell cwd is canary root": data.cwd === context.paths.root,
          "cell code executed": data.value === 42,
          "cell direct process exited": dead,
          "cell has no execArgv": Array.isArray(data.execArgv) && data.execArgv.length === 0,
        },
      };
    }),
    await runCase(
      "seatbelt-canary-read-denied",
      "seatbelt",
      "denied",
      async () =>
        await runProbeCell(
          context.seatbeltExecutor,
          `${CLASSIFY}\ntry { const text = require("node:fs").readFileSync(${JSON.stringify(context.paths.canaryReadPath)}, "utf8"); return { outcome: "allowed", data: { text } }; } catch (error) { return d06Classify(error); }`,
        ),
    ),
    await runCase("seatbelt-canary-write-denied", "seatbelt", "denied", async () => {
      const observed = await runProbeCell(
        context.seatbeltExecutor,
        `${CLASSIFY}\ntry { require("node:fs").writeFileSync(${JSON.stringify(context.paths.canaryWritePath)}, "D06_SANDBOX_WRITE", "utf8"); return { outcome: "allowed" }; } catch (error) { return d06Classify(error); }`,
      );
      const disk = await readFile(context.paths.canaryWritePath, "utf8").catch(() => "");
      return { ...observed, checks: { "canary file unchanged": disk === D06_CANARY_CONTENT } };
    }),
    await runCase("seatbelt-canary-import-denied", "seatbelt", "denied", async () => {
      const moduleUrl = pathToFileURL(context.paths.importCanaryPath).href;
      const before = await sha256File(context.paths.importCanaryPath);
      const forkImport = await runProbeCell(
        context.forkExecutor,
        `${CLASSIFY}\ntry { const loaded = await import(${JSON.stringify(moduleUrl)}); return { outcome: "allowed", data: { marker: loaded.marker } }; } catch (error) { return d06Classify(error); }`,
      );
      const observed = await runProbeCell(
        context.seatbeltExecutor,
        [
          CLASSIFY,
          'const fs = require("node:fs");',
          "let readError = null;",
          `try { fs.readFileSync(${JSON.stringify(context.paths.importCanaryPath)}, "utf8"); } catch (error) { readError = d06Classify(error); }`,
          "let importResult = null;",
          "try {",
          `  const loaded = await import(${JSON.stringify(moduleUrl)});`,
          '  importResult = { outcome: "allowed", marker: loaded.marker ?? null };',
          "} catch (error) { importResult = d06Classify(error); }",
          'const readDenied = readError?.outcome === "denied" && (readError.code === "EPERM" || readError.code === "EACCES" || readError.causeCode === "EPERM" || readError.causeCode === "EACCES");',
          'const importDenied = importResult?.outcome === "denied" && (importResult.code === "EPERM" || importResult.code === "EACCES" || importResult.causeCode === "EPERM" || importResult.causeCode === "EACCES");',
          'const maskedNotFound = importResult?.outcome === "error" && importResult.code === "ERR_MODULE_NOT_FOUND";',
          'const outcome = readDenied && (importDenied || maskedNotFound) ? "denied" : "error";',
          'return { outcome, code: readError?.code ?? null, causeCode: readError?.causeCode ?? null, detail: "same-path fs denial plus masked dynamic import", data: { readError, importResult } };',
        ].join("\n"),
      );
      const after = await sha256File(context.paths.importCanaryPath);
      const data = extractData(observed.raw);
      const readError = (data.readError ?? {}) as Record<string, unknown>;
      const importResult = (data.importResult ?? {}) as Record<string, unknown>;
      const forkData = extractData(forkImport.raw);
      return {
        ...observed,
        checks: {
          "same path fs read denied":
            readError.outcome === "denied" && isDenialCode(readError.code, readError.causeCode),
          "same module fork import succeeds":
            forkImport.outcome === "allowed" && forkData.marker === "D06_DYNAMIC_IMPORT",
          "canary exists before probe": before.bytes > 0,
          "canary hash unchanged": before.sha256 === after.sha256,
          "import failed only with known masked code": isKnownMaskedModuleFailure(importResult),
          "import did not return a module":
            importResult.outcome !== "allowed" && importResult.marker === undefined,
        },
      };
    }),
    await runCase("seatbelt-docs-read-only", "seatbelt", "allowed", async () => {
      const code = [
        'const fs = require("node:fs");',
        "try {",
        `  const text = fs.readFileSync(${JSON.stringify(context.paths.docsFile)}, "utf8");`,
        "  let write;",
        `  try { fs.writeFileSync(${JSON.stringify(context.paths.docsFile)}, "tampered"); write = { outcome: "allowed" }; } catch (error) { write = d06Classify(error); }`,
        '  return { outcome: "allowed", data: { text, write } };',
        "} catch (error) { return d06Classify(error); }",
      ].join("\n");
      const observed = await runProbeCell(context.seatbeltExecutor, `${CLASSIFY}\n${code}`);
      const data = extractData(observed.raw);
      const write = (data.write ?? {}) as Record<string, unknown>;
      const disk = await readFile(context.paths.docsFile, "utf8").catch(() => "");
      return {
        ...observed,
        checks: {
          "synthetic docs readable":
            typeof data.text === "string" && data.text.includes("Synthetic Browser docs"),
          "synthetic docs write denied":
            write.outcome === "denied" && isDenialCode(write.code, write.causeCode),
          "synthetic docs unchanged":
            disk.includes("Synthetic Browser docs") && !disk.includes("tampered"),
        },
      };
    }),
    await runCase("seatbelt-client-import-read-only", "seatbelt", "allowed", async () => {
      const moduleUrl = pathToFileURL(context.paths.clientFile).href;
      const code = [
        'const fs = require("node:fs");',
        "try {",
        `  const loaded = await import(${JSON.stringify(moduleUrl)});`,
        "  let write;",
        `  try { fs.appendFileSync(${JSON.stringify(context.paths.clientFile)}, "// tampered\\n"); write = { outcome: "allowed" }; } catch (error) { write = d06Classify(error); }`,
        '  return { outcome: "allowed", data: { marker: loaded.marker, write } };',
        "} catch (error) { return d06Classify(error); }",
      ].join("\n");
      const observed = await runProbeCell(context.seatbeltExecutor, `${CLASSIFY}\n${code}`);
      const data = extractData(observed.raw);
      const write = (data.write ?? {}) as Record<string, unknown>;
      const disk = await readFile(context.paths.clientFile, "utf8").catch(() => "");
      return {
        ...observed,
        checks: {
          "synthetic client importable": data.marker === "D06_CLIENT_IMPORT",
          "synthetic client write denied":
            write.outcome === "denied" && isDenialCode(write.code, write.causeCode),
          "synthetic client unchanged": disk === "export const marker = 'D06_CLIENT_IMPORT';\n",
        },
      };
    }),
    await runCase("seatbelt-tcp-denied", "seatbelt", "denied", async () => {
      const before = context.stats.tcpAccepted;
      const observed = await runProbeCell(
        context.seatbeltExecutor,
        connectTcpCode(context.tcpPort),
      );
      return {
        ...observed,
        checks: { "synthetic TCP accepted zero": context.stats.tcpAccepted - before === 0 },
      };
    }),
    await runCase("seatbelt-extra-unix-socket-denied", "seatbelt", "denied", async () => {
      const before = context.stats.forbiddenUnixAccepted;
      const observed = await runProbeCell(
        context.seatbeltExecutor,
        connectUnixCode(context.paths.forbiddenSocketPath),
      );
      return {
        ...observed,
        checks: {
          "forbidden Unix socket accepted zero": context.stats.forbiddenUnixAccepted - before === 0,
        },
      };
    }),
    await (async () => {
      const probe = await runInspectorListenProbe({
        sandboxExec: "/usr/bin/sandbox-exec",
        nodePath: context.nodePath,
        profilePath: context.paths.profilePath,
        cwd: context.paths.root,
      });
      const result = await runCase(
        "seatbelt-inspector-listen-denied",
        "seatbelt",
        "denied",
        async () => probe.observation,
      );
      result.command = probe.command;
      return result;
    })(),
    await runCase("seatbelt-browser-fixture-allowed", "seatbelt", "allowed", async () => {
      const before = { ...context.stats };
      const symbol = Symbol.keyFor(NODE_REPL_BROWSER_BRIDGE_SYMBOL);
      const code = [
        `const bridge = globalThis[Symbol.for(${JSON.stringify(symbol)})];`,
        'if (!bridge) return { outcome: "error", detail: "Browser bridge missing" };',
        "try {",
        "  const browsers = await bridge.list();",
        '  return { outcome: "allowed", data: { browsers, documentationRoot: bridge.documentationRoot } };',
        "} catch (error) { return d06Classify(error); }",
      ].join("\n");
      const observed = await runProbeCell(context.seatbeltExecutor, `${CLASSIFY}\n${code}`);
      const data = extractData(observed.raw);
      return {
        ...observed,
        checks: {
          "bridge returned fixture list":
            Array.isArray(data.browsers) && data.browsers.length === 0,
          "bridge saw synthetic docs root": data.documentationRoot === context.paths.docsDir,
          "fixture received one request":
            context.stats.browserRequests - before.browserRequests === 1,
          "fixture validated token and schema":
            context.stats.browserValidRequests - before.browserValidRequests === 1,
          "fixture rejected nothing": context.stats.browserInvalidRequests === 0,
          "fixture method is list": context.stats.browserMethods.at(-1) === "list",
          "fixture matched synthetic token":
            context.stats.browserTokenMatches - before.browserTokenMatches === 1,
          "fixture schema valid":
            context.stats.browserSchemaValid - before.browserSchemaValid === 1,
          "fixture list method valid":
            context.stats.browserListMethods - before.browserListMethods === 1,
        },
      };
    }),
    await runCase(
      "seatbelt-arbitrary-child-denied",
      "seatbelt",
      "denied",
      async () =>
        await runProbeCell(
          context.seatbeltExecutor,
          `${CLASSIFY}\nconst { spawn } = require("node:child_process");\nlet child;\ntry { child = spawn("/usr/bin/true", [], { stdio: "ignore" }); } catch (error) { return d06Classify(error); }\nconst outcome = await new Promise((resolve) => { child.once("error", (error) => resolve(d06Classify(error))); child.once("exit", () => resolve({ outcome: "allowed" })); });\nreturn outcome;`,
        ),
    ),
  ];
}

function connectTcpCode(port: number): string {
  return `${CLASSIFY}\nconst net = require("node:net");\nreturn await new Promise((resolve) => { const socket = net.createConnection({ host: "127.0.0.1", port: ${port} }); let settled = false; const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(value); }; const timer = setTimeout(() => finish({ outcome: "error", detail: "TCP probe timeout" }), 1500); socket.once("connect", () => finish({ outcome: "allowed" })); socket.once("error", (error) => finish(d06Classify(error))); });`;
}

function connectUnixCode(path: string): string {
  return `${CLASSIFY}\nconst net = require("node:net");\nreturn await new Promise((resolve) => { const socket = net.createConnection(${JSON.stringify(path)}); let settled = false; const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(value); }; const timer = setTimeout(() => finish({ outcome: "error", detail: "Unix probe timeout" }), 1500); socket.once("connect", () => finish({ outcome: "allowed" })); socket.once("error", (error) => finish(d06Classify(error))); });`;
}

function isDenialCode(code: unknown, causeCode: unknown): boolean {
  return code === "EPERM" || code === "EACCES" || causeCode === "EPERM" || causeCode === "EACCES";
}

function extractData(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const data = (raw as Record<string, unknown>).data;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}
