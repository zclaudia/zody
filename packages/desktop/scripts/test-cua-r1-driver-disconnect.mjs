import { attach } from "webdriverio";
import { captureR1DriverBinding, reattachR1Driver } from "./lib/cua-r1-driver-reattach.mjs";
import http from "node:http";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
const argumentsMap = new Map();
const allowed = new Set(["--output", "--electron", "--driver", "--inspector", "--origin-addon"]);
if (process.argv.includes("--help")) {
  console.log(
    "node scripts/test-cua-r1-driver-disconnect.mjs --output <fresh absolute dir> --electron <absolute exe> --driver <absolute chromedriver> --inspector <absolute inspect-driver-fixture> --origin-addon <absolute quit-origin.node>",
  );
  process.exit(0);
}
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i],
    value = process.argv[i + 1];
  if (!allowed.has(key) || !value || !isAbsolute(value) || argumentsMap.has(key))
    throw Error("Expected unique absolute diagnostic arguments");
  argumentsMap.set(key, value);
}
if (process.platform !== "darwin" || argumentsMap.size !== 5)
  throw Error("Requires macOS and all five diagnostic paths");
const base = argumentsMap.get("--output"),
  electron = argumentsMap.get("--electron"),
  driver = argumentsMap.get("--driver"),
  inspector = argumentsMap.get("--inspector"),
  originAddon = argumentsMap.get("--origin-addon");
const fixture = fileURLToPath(
  new URL("../native/macos-cua-observation-fixture/driver_disconnect_fixture.cjs", import.meta.url),
);
await mkdir(base);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function free() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function json(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function wait(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await pause(50);
  }
  throw Error("Regression stage timeout");
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
const results = [];
for (const detach of [false, true]) {
  const run = join(base, detach ? "detached" : "owned");
  await mkdir(run);
  const real = await free(),
    proxyPort = await free(),
    driverPort = await free();
  let blocked = false,
    app,
    identity;
  const sockets = new Set();
  const proxy = http.createServer((request, response) => {
    if (blocked) {
      response.writeHead(503);
      response.end();
      return;
    }
    const up = http.request(
      {
        host: "127.0.0.1",
        port: real,
        path: request.url,
        method: request.method,
        headers: request.headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.from(
            Buffer.concat(chunks)
              .toString()
              .replaceAll(":" + real, ":" + proxyPort),
          );
          const headers = { ...res.headers, "content-length": body.length };
          delete headers["transfer-encoding"];
          response.writeHead(res.statusCode, headers);
          response.end(body);
        });
      },
    );
    up.on("error", () => {
      response.writeHead(502);
      response.end();
    });
    request.pipe(up);
  });
  proxy.on("upgrade", (request, socket, head) => {
    if (blocked) {
      socket.destroy();
      return;
    }
    const upstream = net.connect(real, "127.0.0.1", () => {
      upstream.write(
        `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n` +
          Object.entries(request.headers)
            .map(([k, v]) => `${k}: ${v}\r\n`)
            .join("") +
          "\r\n",
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    sockets.add(socket);
    sockets.add(upstream);
    socket.on("close", () => sockets.delete(socket));
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  await new Promise((r) => proxy.listen(proxyPort, "127.0.0.1", r));
  const child = spawn(driver, [`--port=${driverPort}`, "--allowed-ips=127.0.0.1"], {
    stdio: "ignore",
    env: {
      ...process.env,
      R1_DRIVER_FIXTURE_DIR: run,
      R1_DRIVER_REAL_PORT: String(real),
      R1_DRIVER_ORIGIN_ADDON: originAddon,
    },
  });
  const api = async (path, method = "GET", body) => {
    if ((method === "GET" || method === "HEAD") && body !== undefined)
      throw new Error("Read-only WebDriver request cannot carry a body");
    const init = {
      method,
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(40000),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const r = await fetch(`http://127.0.0.1:${driverPort}${path}`, init);
    return { status: r.status, ...(await r.json()) };
  };
  try {
    await wait(async () => {
      try {
        return (await api("/status")).value.ready;
      } catch {
        return false;
      }
    });
    const session = await api("/session", "POST", {
      capabilities: {
        alwaysMatch: {
          browserName: "chrome",
          "goog:chromeOptions": {
            binary: electron,
            args: [
              `--app=${fixture}`,
              `--remote-debugging-port=${proxyPort}`,
              `--user-data-dir=${join(run, "profile")}`,
            ],
            detach,
          },
        },
      },
    });
    if (session.status !== 200)
      throw Error("Driver initialization failed: " + JSON.stringify(session.value));
    app = await wait(() => json(join(run, "ready.json")));
    if (app.pid !== session.value.capabilities["goog:processID"])
      throw Error("Driver process identity mismatch");
    identity = JSON.parse(
      (await exec(inspector, [String(app.pid), electron, "com.github.Electron"])).stdout,
    );
    if (identity.ok !== true) throw Error("Exact fixture identity failed");
    const id = session.value.sessionId;
    const inspectProcess = async (pid) =>
      JSON.parse((await exec(inspector, [String(pid), electron, "com.github.Electron"])).stdout);
    const validationClient = detach
      ? await attach({
          sessionId: id,
          capabilities: session.value.capabilities,
          options: {
            protocol: "http",
            hostname: "127.0.0.1",
            port: driverPort,
            path: "/",
            logLevel: "error",
            connectionRetryCount: 0,
          },
        })
      : null;
    const binding = detach
      ? await captureR1DriverBinding({ browser: validationClient, pid: app.pid, inspectProcess })
      : null;
    const before = await api(`/session/${id}/execute/sync`, "POST", {
      script: "return document.title;",
      args: [],
    });
    if (before.value !== "R1 driver disconnect regression") throw Error("Wrong regression target");
    blocked = true;
    for (const socket of sockets) socket.destroy();
    const failed = await api(`/session/${id}/execute/sync`, "POST", {
      script: "return document.title;",
      args: [],
    });
    if (failed.status < 400) throw Error("Transport loss did not fail");
    await pause(250);
    if (!detach) await wait(() => !alive(app.pid), 5000);
    const survived = alive(app.pid),
      quit = await json(join(run, "quit.json"));
    const b = await readFile(join(run, "signals.bin"));
    const frames = [];
    for (let i = 0; i + 24 <= b.length; i += 24)
      frames.push({ signal: b.readInt32LE(i), senderPid: b.readInt32LE(i + 4) });
    const row = {
      detach,
      fixturePid: app.pid,
      driverPid: child.pid,
      transportFailure: failed.value.error,
      survived,
      beforeCleanupFrames: frames,
      quitOrigin: quit
        ? { signal: quit.signalOrigin, eventClass: quit.eventClass, eventId: quit.eventId }
        : null,
    };
    await writeFile(join(run, "result.json"), JSON.stringify(row, null, 2));
    results.push(row);
    if (detach) {
      blocked = false;
      row.rebind = await reattachR1Driver({ browser: validationClient, binding, inspectProcess });
      row.recoveredTitle = await validationClient.getTitle();
      if (row.recoveredTitle !== "R1 driver disconnect regression")
        throw Error("Existing validation client did not recover the same candidate");
      await writeFile(join(run, "result.json"), JSON.stringify(row, null, 2));
    }
    if (survived !== detach) throw Error("Driver lifetime contract not reproduced");
    if (!detach && !frames.some((f) => f.signal === 15 && f.senderPid === child.pid))
      throw Error("Old profile did not reproduce driver SIGTERM");
    if (detach && frames.length) throw Error("Detached profile still signaled target");
  } finally {
    if (app && alive(app.pid) && identity) {
      const current = JSON.parse(
        (await exec(inspector, [String(app.pid), electron, "com.github.Electron"])).stdout,
      );
      if (
        current.ok === true &&
        JSON.stringify(current.launchDate) === JSON.stringify(identity.launchDate)
      )
        process.kill(app.pid, "SIGTERM");
    }
    child.kill("SIGTERM");
    for (const s of sockets) s.destroy();
    await new Promise((r) => proxy.close(r));
  }
}
await writeFile(
  join(base, "driver-disconnect-regression.json"),
  JSON.stringify(
    {
      results,
      passed: true,
      syntheticTransportFault: true,
      noSystemSleep: true,
      R2Unblocked: false,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(results));
