// F0.3 断网验收容器 sink 与断言工具的定向测试
// （specs/fork-official-deps-removal-tasks.md「F0.3」）。
// 覆盖：HTTP Host 解析、TLS ClientHello SNI 解析（含无 SNI / 截断 / 非 TLS）、
// 断言工具的 empty / whitelist / report 语义，以及 sink 真实监听下的端到端行为。
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

import {
  parseClientHelloSni,
  parseHttpRequestHost,
} from "./official-request-sink.mjs";
import {
  evaluateRecords,
  isHostAllowed,
  loadRecords,
  normalizeHost,
} from "./assert-official-requests.mjs";

/** 构造一个最小但结构合法的 ClientHello 报文。 */
function buildClientHello({ sni = null, includeExtensions = true } = {}) {
  const extensions = [];
  if (includeExtensions) {
    if (sni !== null) {
      const name = Buffer.from(sni, "utf8");
      const entry = Buffer.alloc(3 + name.length);
      entry[0] = 0x00; // name_type: host_name
      entry.writeUInt16BE(name.length, 1);
      name.copy(entry, 3);
      const list = Buffer.alloc(2 + entry.length);
      list.writeUInt16BE(entry.length, 0);
      entry.copy(list, 2);
      const extension = Buffer.alloc(4 + list.length);
      extension.writeUInt16BE(0x0000, 0); // extension_type: server_name
      extension.writeUInt16BE(list.length, 2);
      list.copy(extension, 4);
      extensions.push(extension);
    }
    const data = Buffer.from([0x00]);
    const dummy = Buffer.alloc(4 + data.length);
    dummy.writeUInt16BE(0x000b, 0); // ec_point_formats
    dummy.writeUInt16BE(data.length, 2);
    data.copy(dummy, 4);
    extensions.push(dummy);
  }
  const extensionsBytes = Buffer.concat(extensions);
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]), // client_version TLS1.2
    Buffer.alloc(32, 0xaa), // random
    Buffer.from([0x00]), // session_id: 空
    Buffer.from([0x00, 0x02, 0x13, 0x01]), // cipher_suites: 1 个
    Buffer.from([0x01, 0x00]), // compression_methods: null
    ...(includeExtensions
      ? [
          (() => {
            const length = Buffer.alloc(2);
            length.writeUInt16BE(extensionsBytes.length, 0);
            return length;
          })(),
          extensionsBytes,
        ]
      : []),
  ]);
  const handshake = Buffer.alloc(4);
  handshake[0] = 0x01; // ClientHello
  handshake.writeUIntBE(body.length, 1, 3);
  const record = Buffer.alloc(5);
  record[0] = 0x16; // handshake record
  record[1] = 0x03;
  record[2] = 0x01;
  record.writeUInt16BE(handshake.length + body.length, 3);
  return Buffer.concat([record, handshake, body]);
}

describe("parseHttpRequestHost", () => {
  it("解析 Host 头（保留端口原样）", () => {
    const request = "GET /probe HTTP/1.1\r\nHost: api.z.ai:443\r\nUser-Agent: t\r\n\r\n";
    expect(parseHttpRequestHost(Buffer.from(request))).toEqual({
      status: "complete",
      host: "api.z.ai:443",
    });
  });

  it("小写头名与裸主机名", () => {
    expect(parseHttpRequestHost(Buffer.from("POST /a HTTP/1.1\r\nhost: z.ai\r\n\r\n"))).toEqual({
      status: "complete",
      host: "z.ai",
    });
  });

  it("仅 LF 行尾也能解析", () => {
    expect(parseHttpRequestHost(Buffer.from("GET / HTTP/1.1\nHost: z.ai\n\n"))).toEqual({
      status: "complete",
      host: "z.ai",
    });
  });

  it("无 Host 头记 complete + null", () => {
    expect(parseHttpRequestHost(Buffer.from("GET / HTTP/1.0\r\n\r\n"))).toEqual({
      status: "complete",
      host: null,
    });
  });

  it("头未收完返回 incomplete", () => {
    expect(parseHttpRequestHost(Buffer.from("GET / HTTP/1.1\r\nHost: api.z.ai"))).toEqual({
      status: "incomplete",
    });
  });

  it("非 HTTP 请求行返回 invalid", () => {
    // 打到 80 端口的 TLS 字节（带完整头块终止符）：请求行不是 HTTP 形态。
    expect(parseHttpRequestHost(Buffer.from("\x16\x03\x01\x00\x05junk\r\n\r\n"))).toEqual({
      status: "invalid",
      reason: "not-an-http-request-line",
    });
  });
});

describe("parseClientHelloSni", () => {
  it("解析带 SNI 的 ClientHello", () => {
    expect(parseClientHelloSni(buildClientHello({ sni: "api.z.ai" }))).toEqual({
      status: "complete",
      host: "api.z.ai",
    });
    expect(parseClientHelloSni(buildClientHello({ sni: "zcode.z.ai" }))).toEqual({
      status: "complete",
      host: "zcode.z.ai",
    });
  });

  it("带扩展但无 server_name 时 SNI 为 null", () => {
    expect(parseClientHelloSni(buildClientHello({ sni: null }))).toEqual({
      status: "complete",
      host: null,
    });
  });

  it("完全无扩展块（老客户端）SNI 为 null", () => {
    expect(parseClientHelloSni(buildClientHello({ includeExtensions: false }))).toEqual({
      status: "complete",
      host: null,
    });
  });

  it("截断的 ClientHello 返回 incomplete，等待更多字节", () => {
    const full = buildClientHello({ sni: "api.z.ai" });
    expect(parseClientHelloSni(full.subarray(0, 20))).toEqual({ status: "incomplete" });
    expect(parseClientHelloSni(Buffer.alloc(0))).toEqual({ status: "incomplete" });
  });

  it("非 TLS 记录返回 invalid", () => {
    expect(parseClientHelloSni(Buffer.from("GET / HTTP/1.1\r\n\r\n"))).toEqual({
      status: "invalid",
      reason: "not-a-tls-record",
    });
    // TLS 记录但握手类型不是 ClientHello（0x02 为 ServerHello）。
    const serverHello = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x04, 0x02, 0x00, 0x00, 0x00]);
    expect(parseClientHelloSni(serverHello)).toEqual({
      status: "invalid",
      reason: "not-a-client-hello",
    });
  });
});

describe("断言工具纯函数", () => {
  it("normalizeHost 去端口、去空白、转小写", () => {
    expect(normalizeHost(" API.Z.AI:443 ")).toBe("api.z.ai");
    expect(normalizeHost("z.ai")).toBe("z.ai");
    expect(normalizeHost("")).toBeNull();
    expect(normalizeHost(null)).toBeNull();
  });

  it("isHostAllowed 白名单含子域语义", () => {
    expect(isHostAllowed("api.z.ai", ["z.ai"])).toBe(true);
    expect(isHostAllowed("z.ai", ["api.z.ai"])).toBe(false);
    expect(isHostAllowed("evil.com", ["z.ai"])).toBe(false);
    expect(isHostAllowed(null, ["z.ai"])).toBe(false);
  });

  it("loadRecords 解析 JSONL 并跳过空行", () => {
    const text = '{"host":"z.ai"}\n\n{"host":"api.z.ai"}\n';
    expect(loadRecords(text)).toEqual([{ host: "z.ai" }, { host: "api.z.ai" }]);
  });

  it("loadRecords 对坏行抛错（不给假通过）", () => {
    expect(() => loadRecords('{"host":"z.ai"}\nnot-json\n')).toThrow(/line 2/);
  });

  it("empty 模式：必须为空", () => {
    expect(evaluateRecords([], { mode: "empty" }).pass).toBe(true);
    const failing = evaluateRecords([{ host: "api.z.ai:443" }, { host: "API.Z.AI" }], {
      mode: "empty",
    });
    // 带端口的 Host 归一化后合并计数。
    expect(failing.pass).toBe(false);
    expect(failing.offenders).toEqual({ "api.z.ai": 2 });
  });

  it("whitelist 模式：仅白名单（含子域）通过，无 SNI 记录判失败", () => {
    const records = [{ host: "api.z.ai" }, { host: "zcode.z.ai" }, { host: null }];
    const result = evaluateRecords(records, { mode: "whitelist", allow: ["api.z.ai"] });
    expect(result.pass).toBe(false);
    expect(result.offenders).toEqual({ "(unknown)": 1, "zcode.z.ai": 1 });
    expect(
      evaluateRecords([{ host: "api.z.ai" }, { host: null }], {
        mode: "whitelist",
        allow: ["api.z.ai"],
      }).pass,
    ).toBe(false);
    expect(
      evaluateRecords([{ host: "open.bigmodel.cn" }], {
        mode: "whitelist",
        allow: ["api.z.ai", "open.bigmodel.cn"],
      }).pass,
    ).toBe(true);
  });

  it("report 模式恒通过，只出摘要", () => {
    const result = evaluateRecords([{ host: "z.ai" }, { host: "z.ai" }], { mode: "report" });
    expect(result.pass).toBe(true);
    expect(result.summary).toEqual({ total: 2, byHost: { "z.ai": 2 } });
  });
});

describe("sink 端到端（真实监听）", () => {
  it("记录 HTTP Host / TLS SNI / 明文打 443，空连接不记录，SIGTERM 后冲刷退出", async () => {
    const directory = await mkdtemp(join(tmpdir(), "official-request-sink-"));
    const output = join(directory, "official-requests.jsonl");
    const sinkPath = fileURLToPath(new URL("./official-request-sink.mjs", import.meta.url));
    const child = spawn(
      process.execPath,
      [sinkPath, "--output", output, "--bind", "127.0.0.1", "--http-port", "0", "--tls-port", "0"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      const listening = await new Promise((resolvePromise, rejectPromise) => {
        let stdoutText = "";
        const onData = (chunk) => {
          stdoutText += chunk.toString();
          const newline = stdoutText.indexOf("\n");
          if (newline < 0) {
            return;
          }
          cleanup();
          try {
            resolvePromise(JSON.parse(stdoutText.slice(0, newline)));
          } catch (error) {
            rejectPromise(error);
          }
        };
        const onExit = (code) => {
          cleanup();
          rejectPromise(new Error(`sink exited before listening: ${code}`));
        };
        const cleanup = () => {
          child.stdout.off("data", onData);
          child.off("exit", onExit);
        };
        child.stdout.on("data", onData);
        child.on("exit", onExit);
      });
      expect(listening.event).toBe("listening");
      expect(listening.httpPort).toBeGreaterThan(0);
      expect(listening.tlsPort).toBeGreaterThan(0);
      // 启动即截断创建输出文件：零请求时留空文件，empty 模式断言
      // 由此区分「sink 跑了且无请求」（通过）与「sink 没跑」（文件缺失）。
      expect(await readFile(output, "utf8")).toBe("");

      const onceClosed = (socket) =>
        new Promise((resolvePromise) => {
          socket.on("close", resolvePromise);
          socket.on("error", () => {});
        });

      // HTTP：带官方 Host 头。
      const httpRequest = netConnect(listening.httpPort, "127.0.0.1", () => {
        httpRequest.write("GET /probe HTTP/1.1\r\nHost: api.z.ai:443\r\nConnection: close\r\n\r\n");
      });
      await onceClosed(httpRequest);
      // 空连接（零字节探测）：不应产生记录。
      const emptyProbe = netConnect(listening.httpPort, "127.0.0.1", () => {
        emptyProbe.end();
      });
      await onceClosed(emptyProbe);
      // TLS：带 SNI 的 ClientHello（sink 无证书，握手必失败，SNI 已被记录）。
      await onceClosed(
        tlsConnect({
          host: "127.0.0.1",
          port: listening.tlsPort,
          servername: "zcode.z.ai",
          rejectUnauthorized: false,
        }),
      );
      // 明文 HTTP 打到 TLS 端口：按 Host 归因。
      const plaintext = netConnect(listening.tlsPort, "127.0.0.1", () => {
        plaintext.write("GET /x HTTP/1.1\r\nHost: z.ai\r\n\r\n");
      });
      await onceClosed(plaintext);

      child.kill("SIGTERM");
      const exitCode = await new Promise((resolvePromise) => {
        child.on("exit", (code) => resolvePromise(code));
      });
      expect(exitCode).toBe(0);

      const records = loadRecords(await readFile(output, "utf8"));
      expect(records).toHaveLength(3);
      expect(records[0]).toMatchObject({ kind: "http", host: "api.z.ai:443" });
      expect(records[0].timestamp).toEqual(expect.any(String));
      expect(records[1]).toMatchObject({ kind: "tls", host: "zcode.z.ai" });
      expect(records[2]).toMatchObject({
        kind: "tls",
        host: "z.ai",
        note: "plaintext-http-on-tls-port",
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
