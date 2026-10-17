#!/usr/bin/env node

// F0.3 断网验收容器的官方请求 sink（specs/fork-official-deps-removal-tasks.md「F0.3」、
// specs/fork-official-deps-removal-plan.md 阶段 0.3）。
//
// scripts/test-desktop-e2e-container.sh --block-official 会把官方域名 --add-host 到
// 容器内 sink 地址（默认 127.0.0.1），并在容器内以命令覆盖方式先启动本进程再跑 E2E。
// 本进程在 80/443 上监听：HTTP 请求记录 Host 头、TLS 连接记录 ClientHello 的 SNI，
// 然后立即断开（不回包、不转发），使「官方不可达」成为可观测事件。记录逐行追加到
// official-requests.jsonl，供 scripts/assert-official-requests.mjs 按
// 「必须为空」或「仅白名单」断言。不记录请求路径、头部与载荷，只留主机名。
//
// 用法：
//   node scripts/official-request-sink.mjs [--output <path>] [--bind <addr>]
//       [--http-port <port>] [--tls-port <port>]
// 端口传 0 可让操作系统分配（测试用）；启动完成后向 stdout 输出一行
// JSON（{"event":"listening",...}），供脚本/测试确认已就绪。

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";

const MAX_CAPTURE_BYTES = 64 * 1024;
const IDLE_TIMEOUT_MS = 5000;

/** 80 端口连接：解析 HTTP 请求头里的 Host。 */
export function parseHttpRequestHost(buffer) {
  const head = buffer.toString("latin1");
  const crlf = head.indexOf("\r\n\r\n");
  const lf = head.indexOf("\n\n");
  let headerEnd = -1;
  if (crlf >= 0 && lf >= 0) {
    headerEnd = Math.min(crlf + 4, lf + 2);
  } else if (crlf >= 0) {
    headerEnd = crlf + 4;
  } else if (lf >= 0) {
    headerEnd = lf + 2;
  }
  if (headerEnd < 0) {
    return { status: "incomplete" };
  }
  const lines = head.slice(0, headerEnd).split(/\r?\n/u);
  // 请求行宽松校验：`METHOD SP TARGET SP HTTP/x[.y]`；不是该形态说明打到 80
  // 端口的不是 HTTP（例如误发的 TLS 字节），记为 invalid 而不是硬解。
  if (!/^\S+ \S+ HTTP\/\d(\.\d)?$/u.test(lines[0])) {
    return { status: "invalid", reason: "not-an-http-request-line" };
  }
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    if (line.slice(0, separator).trim().toLowerCase() === "host") {
      const value = line.slice(separator + 1).trim();
      return { status: "complete", host: value.length > 0 ? value : null };
    }
  }
  return { status: "complete", host: null };
}

/**
 * 443 端口连接：解析 TLS ClientHello 里的 SNI。
 * 仅处理单记录内的完整 ClientHello（现实中 SNI 都在首个记录）；跨记录分片
 * 或截断返回 incomplete，由连接关闭/超时路径记为 null SNI。
 */
export function parseClientHelloSni(buffer) {
  if (buffer.length < 1) {
    return { status: "incomplete" };
  }
  if (buffer[0] !== 0x16) {
    return { status: "invalid", reason: "not-a-tls-record" };
  }
  if (buffer.length < 5) {
    return { status: "incomplete" };
  }
  const recordLength = buffer.readUInt16BE(3);
  if (buffer.length < 5 + recordLength) {
    return { status: "incomplete" };
  }
  if (buffer[5] !== 0x01) {
    return { status: "invalid", reason: "not-a-client-hello" };
  }
  const handshakeLength = buffer.readUIntBE(6, 3);
  const bodyEnd = 9 + handshakeLength;
  if (buffer.length < bodyEnd) {
    return { status: "incomplete" };
  }
  let offset = 9 + 2 + 32; // client version(2) + random(32)
  if (offset + 1 > bodyEnd) {
    return { status: "invalid", reason: "truncated-client-hello" };
  }
  const sessionIdLength = buffer.readUInt8(offset);
  offset += 1 + sessionIdLength;
  if (offset + 2 > bodyEnd) {
    return { status: "invalid", reason: "truncated-session-id" };
  }
  const cipherSuitesLength = buffer.readUInt16BE(offset);
  offset += 2 + cipherSuitesLength;
  if (offset + 1 > bodyEnd) {
    return { status: "invalid", reason: "truncated-cipher-suites" };
  }
  const compressionMethodsLength = buffer.readUInt8(offset);
  offset += 1 + compressionMethodsLength;
  if (offset + 2 > bodyEnd) {
    // 无扩展块：老客户端不携带 SNI。
    return { status: "complete", host: null };
  }
  const extensionsLength = buffer.readUInt16BE(offset);
  offset += 2;
  const extensionsEnd = offset + extensionsLength;
  if (extensionsEnd > bodyEnd) {
    return { status: "invalid", reason: "truncated-extensions" };
  }
  while (offset + 4 <= extensionsEnd) {
    const extensionType = buffer.readUInt16BE(offset);
    const extensionLength = buffer.readUInt16BE(offset + 2);
    const dataStart = offset + 4;
    if (dataStart + extensionLength > extensionsEnd) {
      return { status: "invalid", reason: "truncated-extension" };
    }
    if (extensionType === 0x0000) {
      // server_name 扩展：list_length(2) + 若干 (name_type(1) + name_length(2) + name)。
      let cursor = dataStart;
      const dataEnd = dataStart + extensionLength;
      if (cursor + 2 > dataEnd) {
        return { status: "invalid", reason: "truncated-server-name-list" };
      }
      const listLength = buffer.readUInt16BE(cursor);
      cursor += 2;
      const listEnd = cursor + listLength;
      if (listEnd > dataEnd) {
        return { status: "invalid", reason: "truncated-server-name-list" };
      }
      while (cursor + 3 <= listEnd) {
        const nameType = buffer.readUInt8(cursor);
        const nameLength = buffer.readUInt16BE(cursor + 1);
        cursor += 3;
        if (cursor + nameLength > listEnd) {
          return { status: "invalid", reason: "truncated-server-name" };
        }
        if (nameType === 0) {
          return { status: "complete", host: buffer.toString("utf8", cursor, cursor + nameLength) };
        }
        cursor += nameLength;
      }
      return { status: "complete", host: null };
    }
    offset = dataStart + extensionLength;
  }
  return { status: "complete", host: null };
}

function parseArgs(argv) {
  const options = {
    output: "official-requests.jsonl",
    bind: "0.0.0.0",
    httpPort: 80,
    tlsPort: 443,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    const readPort = () => {
      const parsed = Number.parseInt(value ?? "", 10);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error(`${arg} expects a port number, got: ${value}`);
      }
      return parsed;
    };
    if (arg === "--output") {
      if (!value) {
        throw new Error("--output expects a path");
      }
      options.output = value;
      index += 1;
      continue;
    }
    if (arg === "--bind") {
      if (!value) {
        throw new Error("--bind expects an address");
      }
      options.bind = value;
      index += 1;
      continue;
    }
    if (arg === "--http-port") {
      options.httpPort = readPort();
      index += 1;
      continue;
    }
    if (arg === "--tls-port") {
      options.tlsPort = readPort();
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/official-request-sink.mjs [options]

Listens on 80/443, records the HTTP Host header / TLS ClientHello SNI of every
connection, then disconnects. Each record is appended as one JSON line.
Used by scripts/test-desktop-e2e-container.sh --block-official (F0.3).

Options:
  --output <path>     JSONL output path (default: ./official-requests.jsonl)
  --bind <addr>       listen address (default: 0.0.0.0)
  --http-port <port>  plain HTTP listener port (default: 80)
  --tls-port <port>   TLS/ClientHello listener port (default: 443)
  --help, -h          Show this help
`);
}

function startSink(options) {
  const outputPath = resolve(options.output);
  const sockets = new Set();
  let writeQueue = Promise.resolve();
  let shuttingDown = false;

  const appendRecord = (record) => {
    console.error(
      `[official-request-sink] intercepted kind=${record.kind} host=${record.host ?? "(none)"}` +
        (record.note ? ` note=${record.note}` : ""),
    );
    writeQueue = writeQueue
      .then(() => appendFile(outputPath, `${JSON.stringify(record)}\n`, "utf8"))
      .catch((error) => {
        console.error(`[official-request-sink] failed to write record: ${error.message}`);
        process.exitCode = 1;
      });
    return writeQueue;
  };

  /** 连接终态：解析已积累的字节并落盘，然后断开。 */
  const finalizeSocket = (socket, kind, state) => {
    if (state.finalized) {
      return;
    }
    state.finalized = true;
    const buffer = Buffer.concat(state.chunks);
    if (buffer.length === 0) {
      // 零字节探测连接（如端口扫描）无法归属到任何主机名，不记录。
      socket.destroy();
      return;
    }
    let record;
    if (kind === "http") {
      const result = parseHttpRequestHost(buffer);
      if (result.status === "complete") {
        record = { kind, host: result.host, note: result.host === null ? "no-host-header" : null };
      } else if (result.status === "invalid") {
        record = { kind, host: null, note: result.reason };
      } else {
        record = { kind, host: null, note: "incomplete-request" };
      }
    } else if (buffer[0] !== 0x16) {
      // 打到 443 的明文流量：尝试按 HTTP 解析拿 Host，便于归因。
      const result = parseHttpRequestHost(buffer);
      const note = result.status === "complete" ? "plaintext-http-on-tls-port" : "non-tls-on-tls-port";
      record = { kind, host: result.status === "complete" ? result.host : null, note };
    } else {
      const result = parseClientHelloSni(buffer);
      if (result.status === "complete") {
        record = { kind, host: result.host, note: result.host === null ? "no-sni" : null };
      } else if (result.status === "invalid") {
        record = { kind, host: null, note: result.reason };
      } else {
        record = { kind, host: null, note: "incomplete-clienthello" };
      }
    }
    appendRecord({
      timestamp: new Date().toISOString(),
      kind: record.kind,
      host: record.host,
      note: record.note,
    });
    socket.destroy();
  };

  const handleConnection = (socket, kind) => {
    const state = { chunks: [], finalized: false };
    sockets.add(socket);
    socket.setTimeout(IDLE_TIMEOUT_MS);
    socket.on("data", (chunk) => {
      if (state.finalized || shuttingDown) {
        socket.destroy();
        return;
      }
      state.chunks.push(chunk);
      const buffer = Buffer.concat(state.chunks);
      if (buffer.length > MAX_CAPTURE_BYTES) {
        // 超过采集上限仍无终态：按已有字节归档，防止病态对端撑爆内存。
        finalizeSocket(socket, kind, state);
        return;
      }
      // 够出终态就立即落盘断开，不等对端收尾。
      if (kind === "http") {
        const result = parseHttpRequestHost(buffer);
        if (result.status !== "incomplete") {
          finalizeSocket(socket, kind, state);
        }
        return;
      }
      if (buffer[0] !== 0x16) {
        finalizeSocket(socket, kind, state);
        return;
      }
      if (buffer.length >= 5) {
        const recordLength = buffer.readUInt16BE(3);
        if (buffer.length >= 5 + recordLength) {
          finalizeSocket(socket, kind, state);
        }
      }
    });
    socket.on("timeout", () => {
      finalizeSocket(socket, kind, state);
    });
    socket.on("close", () => {
      finalizeSocket(socket, kind, state);
      sockets.delete(socket);
    });
    socket.on("error", () => {
      // 对端在断开/复位时产生 ECONNRESET 等属正常；记录逻辑由 close/finalize 兜底。
      sockets.delete(socket);
    });
  };

  const listen = (port, kind) =>
    new Promise((resolveListen, rejectListen) => {
      const server = createServer((socket) => handleConnection(socket, kind));
      server.on("error", (error) => {
        rejectListen(error);
      });
      server.listen(port, options.bind, () => {
        resolveListen(server);
      });
    });

  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    for (const socket of sockets) {
      socket.destroy();
    }
    Promise.allSettled([httpServer, tlsServer]).then(async ([http, tls]) => {
      for (const entry of [http, tls]) {
        if (entry.status === "fulfilled") {
          entry.value.close();
        }
      }
      await writeQueue;
      console.error(`[official-request-sink] stopped (${signal})`);
      process.exit(process.exitCode ?? 0);
    });
  };

  let httpServer;
  let tlsServer;
  return (async () => {
    await mkdir(dirname(outputPath), { recursive: true });
    // 启动即截断创建输出文件：文件存在 = sink 已运行。零请求时留空文件，
    // 让断言工具的 empty 模式能区分「sink 跑了且无请求」（通过）与
    // 「sink 没跑」（文件缺失，fail-closed 判失败）。
    await writeFile(outputPath, "", "utf8");
    [httpServer, tlsServer] = await Promise.all([
      listen(options.httpPort, "http"),
      listen(options.tlsPort, "tls"),
    ]);
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    const httpPort = httpServer.address().port;
    const tlsPort = tlsServer.address().port;
    console.log(
      JSON.stringify({ event: "listening", bind: options.bind, httpPort, tlsPort, output: outputPath }),
    );
    return { httpPort, tlsPort, outputPath };
  })();
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  try {
    await startSink(options);
  } catch (error) {
    console.error(
      `[official-request-sink] failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

// 入口守卫：被测试导入时只暴露解析函数，不监听端口。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
