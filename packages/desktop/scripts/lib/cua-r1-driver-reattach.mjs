export function sameR1ProcessIdentity(before, after, pid) {
  const birth = before?.launchDate;
  const validBirth =
    typeof birth === "number"
      ? Number.isFinite(birth) && birth > 0
      : Array.isArray(birth) &&
        birth.length === 2 &&
        Number.isSafeInteger(birth[0]) &&
        birth[0] > 0 &&
        Number.isSafeInteger(birth[1]) &&
        birth[1] >= 0 &&
        birth[1] < 1_000_000;
  return (
    Number.isSafeInteger(pid) &&
    pid > 0 &&
    validBirth &&
    before?.ok === true &&
    after?.ok === true &&
    before.pid === pid &&
    after.pid === pid &&
    JSON.stringify(before.launchDate) === JSON.stringify(after.launchDate)
  );
}
export function r1LoopbackDebugger(address) {
  if (typeof address !== "string" || !/^(localhost|127\.0\.0\.1):[1-9]\d{0,4}$/.test(address))
    throw new Error("R1 debugger binding must be exact loopback host:port");
  const url = new URL(`http://${address}`);
  if (Number(url.port) > 65535) throw new Error("Invalid debugger port");
  return url;
}
async function debuggerPid(address) {
  const url = r1LoopbackDebugger(address);
  const response = await fetch(new URL("/json/version", url), {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("R1 debugger metadata unavailable");
  const metadata = await response.json();
  const socketUrl = new URL(metadata.webSocketDebuggerUrl);
  if (
    socketUrl.protocol !== "ws:" ||
    !["localhost", "127.0.0.1"].includes(socketUrl.hostname) ||
    socketUrl.port !== url.port ||
    !/^\/devtools\/browser\/[^/]+$/.test(socketUrl.pathname) ||
    socketUrl.username ||
    socketUrl.password ||
    socketUrl.search ||
    socketUrl.hash
  )
    throw new Error("Unexpected R1 debugger socket binding");
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("R1 process metadata timed out"));
    }, 5000);
    const fail = () => {
      clearTimeout(timer);
      reject(new Error("R1 debugger metadata connection failed"));
    };
    socket.addEventListener("error", fail, { once: true });
    socket.addEventListener(
      "open",
      () => socket.send(JSON.stringify({ id: 1, method: "SystemInfo.getProcessInfo" })),
      { once: true },
    );
    socket.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(String(event.data));
        if (data.id !== 1) return;
        clearTimeout(timer);
        socket.close();
        const processes = data.result?.processInfo?.filter((x) => x.type === "browser");
        if (
          !Array.isArray(processes) ||
          processes.length !== 1 ||
          !Number.isSafeInteger(processes[0].id)
        )
          throw new Error("R1 browser PID not uniquely available");
        resolve(processes[0].id);
      } catch (error) {
        clearTimeout(timer);
        socket.close();
        reject(error);
      }
    });
  });
}
export async function captureR1DriverBinding({ browser, pid, inspectProcess }) {
  const debuggerAddress = browser.capabilities["goog:chromeOptions"]?.debuggerAddress;
  r1LoopbackDebugger(debuggerAddress);
  const options = browser.options;
  if (
    options.protocol !== "http" ||
    !["localhost", "127.0.0.1"].includes(options.hostname) ||
    !Number.isSafeInteger(options.port) ||
    options.port <= 0 ||
    options.port > 65535 ||
    ![undefined, "/"].includes(options.path)
  )
    throw new Error("Unexpected R1 driver endpoint");
  const identity = await inspectProcess(pid);
  if (
    !sameR1ProcessIdentity(identity, identity, pid) ||
    (await debuggerPid(debuggerAddress)) !== pid
  )
    throw new Error("Initial R1 debugger process mismatch");
  return {
    pid,
    identity,
    debuggerAddress,
    driver: { hostname: "127.0.0.1", port: options.port, protocol: "http", path: "/" },
  };
}
export async function reattachR1Driver({ browser, binding, inspectProcess }) {
  if (
    !sameR1ProcessIdentity(binding.identity, await inspectProcess(binding.pid), binding.pid) ||
    (await debuggerPid(binding.debuggerAddress)) !== binding.pid
  )
    throw new Error("R1 candidate changed; refusing debugger rebind");
  const { remote } = await import("webdriverio");
  // 中文原因：睡眠会删除 ChromeDriver session；只 attach 原进程，不能调用会退出/重启应用的 reloadSession。
  const attached = await remote({
    ...binding.driver,
    logLevel: "error",
    connectionRetryCount: 0,
    connectionRetryTimeout: 10_000,
    capabilities: {
      browserName: "chrome",
      "wdio:enforceWebDriverClassic": true,
      "goog:chromeOptions": { debuggerAddress: binding.debuggerAddress },
    },
  });
  const oldSessionId = browser.sessionId;
  const driverPid = browser.capabilities["wdio:driverPID"];
  // 与本地 WebDriver.reloadSession 的公开实例字段更新一致；保留原 hooks/commands，既不删除旧 session，也不重放 UI。
  browser.sessionId = attached.sessionId;
  browser.capabilities = {
    ...attached.capabilities,
    ...(driverPid ? { "wdio:driverPID": driverPid } : {}),
  };
  if (
    !sameR1ProcessIdentity(binding.identity, await inspectProcess(binding.pid), binding.pid) ||
    (await debuggerPid(binding.debuggerAddress)) !== binding.pid
  )
    throw new Error("R1 process changed while attaching");
  return {
    beforeSessionId: oldSessionId,
    afterSessionId: browser.sessionId,
    pid: binding.pid,
    sameProcess: true,
    applicationRestarted: false,
  };
}
