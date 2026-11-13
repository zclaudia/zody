#!/usr/bin/env node
// Local test-only TLS gateway proxy. Credentials remain in the mode-0600 output env file.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { request } from "node:http";
import { connect } from "node:net";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const dir = process.argv[2];
const source = process.argv[3];
if (!dir || !source || !isAbsolute(dir) || !isAbsolute(source))
  throw new Error("usage: proxy <absolute-output-directory> <absolute-gateway-env>");
await mkdir(dir, { recursive: true, mode: 0o700 });
const run = promisify(execFile);
const caKey = join(dir, "ca.key");
const ca = join(dir, "ca.pem");
const key = join(dir, "localhost.key");
const csr = join(dir, "localhost.csr");
const cert = join(dir, "localhost.pem");
const ext = join(dir, "localhost.ext");
await writeFile(ext, "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n", {
  mode: 0o600,
});
await run(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKey,
    "-out",
    ca,
    "-days",
    "1",
    "-subj",
    "/CN=Zody CUA test CA",
  ],
  { maxBuffer: 1024 * 1024 },
);
await run(
  "openssl",
  ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", "/CN=localhost"],
  { maxBuffer: 1024 * 1024 },
);
await run("openssl", [
  "x509",
  "-req",
  "-in",
  csr,
  "-CA",
  ca,
  "-CAkey",
  caKey,
  "-CAcreateserial",
  "-out",
  cert,
  "-days",
  "1",
  "-extfile",
  ext,
]);
const values = Object.fromEntries(
  (await readFile(source, "utf8"))
    .split(/\r?\n/u)
    .map((line) => line.match(/^([A-Z_]+)=(.*)$/u))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^['"]|['"]$/gu, "")]),
);
const get = (suffix) => values[`ZODY_GATEWAY_${suffix}`] || values[`ZCODE_GATEWAY_${suffix}`];
const upstream = new URL(get("IT_URL"));
if (upstream.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(upstream.hostname))
  throw new Error("upstream must be local HTTP gateway");
const backend = get("BACKEND_CREDENTIAL");
const device = get("DEVICE_CREDENTIAL");
if (!backend || !device) throw new Error("gateway credentials missing");
const server = createServer(
  { key: await readFile(key), cert: await readFile(cert) },
  (req, res) => {
    const upstreamRequest = request(
      {
        hostname: upstream.hostname,
        port: upstream.port || 80,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: upstream.host },
      },
      (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        upstreamResponse.pipe(res);
      },
    );
    upstreamRequest.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstreamRequest);
  },
);
server.on("upgrade", (req, socket, head) => {
  const target = connect(Number(upstream.port || 80), upstream.hostname, () => {
    const headers = Object.entries(req.headers).flatMap(([name, value]) =>
      value === undefined ? [] : [`${name}: ${Array.isArray(value) ? value.join(", ") : value}`],
    );
    target.write(
      `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers.join("\r\n")}\r\n\r\n`,
    );
    if (head.length) target.write(head);
    socket.pipe(target).pipe(socket);
  });
  target.on("error", () => socket.destroy());
  socket.on("error", () => target.destroy());
});
server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TLS proxy failed to bind");
  const env = [
    `ZODY_GATEWAY_IT_URL='https://127.0.0.1:${address.port}'`,
    `ZODY_GATEWAY_NAMESPACE='${get("NAMESPACE") || "zody"}'`,
    `ZODY_GATEWAY_BACKEND_CREDENTIAL='${backend}'`,
    `ZODY_GATEWAY_DEVICE_CREDENTIAL='${device}'`,
    "",
  ].join("\n");
  await writeFile(join(dir, "gateway.env"), env, { mode: 0o600 });
  process.stdout.write(`TLS proxy ready; CA and gateway.env in ${dir}\n`);
});
