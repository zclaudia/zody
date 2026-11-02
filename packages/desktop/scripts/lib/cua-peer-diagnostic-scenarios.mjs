import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, PeerDiagnosticFailureError } from "./cua-peer-diagnostic-core.mjs";
import { runBoundedCommand, spawnCollected } from "./cua-peer-diagnostic-command.mjs";

const FIXTURES = join(
  REPO_ROOT,
  "packages",
  "desktop",
  "test",
  "fixtures",
  "macosCuaPeerDiagnostic",
);
export const CLIENT_DEADLINE_MS = 15_000;
export const SERVER_DEADLINE_MS = 20_000;

export function parseJsonOutput(result, label) {
  const text = result.stdout.trim();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new PeerDiagnosticFailureError(`cannot parse ${label} JSON output`, {
      exitCode: result.exitCode,
      stdout: text.slice(0, 4_000),
      stderr: result.stderr.slice(0, 4_000),
      error: error.message,
    });
  }
}

export function childDetails(result) {
  return result
    ? {
        command: result.command,
        args: result.args,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        stdout: result.stdout.slice(0, 4_000),
        stderr: result.stderr.slice(0, 4_000),
      }
    : null;
}

export async function makeWorkdir(prefix = "zody-cua-peer-r10-") {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await chmod(directory, 0o700);
  return directory;
}

export async function writeFixtureObject(directory, name, value) {
  const path = join(directory, name);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export async function fixtureJson(name) {
  return JSON.parse(await readFile(join(FIXTURES, name), "utf8"));
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function waitForJsonLine(child, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const failure = (message, exitCode, signal) => {
      cleanup();
      const details = {
        pid: child.pid ?? null,
        exitCode: exitCode ?? child.exitCode ?? null,
        signal: signal ?? child.signalCode ?? null,
        bufferedStdout: buffer.slice(0, 4_000),
      };
      const error = new Error(
        `${message} (pid=${details.pid}, exit=${details.exitCode}, signal=${details.signal}, buffered=${JSON.stringify(details.bufferedStdout)})`,
      );
      error.details = details;
      reject(error);
    };
    const timer = setTimeout(() => {
      failure("timed out waiting for child JSON line");
    }, timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            const parsed = JSON.parse(line);
            if (predicate(parsed)) {
              cleanup();
              resolve(parsed);
              return;
            }
          } catch {
            // Child diagnostics may include non-JSON stderr; keep scanning.
          }
        }
        newline = buffer.indexOf("\n");
      }
    };
    const onClose = (exitCode, signal) => {
      failure("child closed before expected JSON line", exitCode, signal);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("close", onClose);
    };
    child.stdout.on("data", onData);
    child.on("close", onClose);
  });
}

export async function waitForPath(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await lstat(path);
    } catch {
      await sleep(20);
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function runServeCommand({
  binary,
  workdir,
  profilePath,
  expectedPid,
  expectedUid,
  timeoutMs,
}) {
  const server = spawnCollected(
    binary,
    [
      "serve",
      "--workdir",
      workdir,
      "--profile",
      profilePath,
      "--expect-pid",
      String(expectedPid),
      "--expect-uid",
      String(expectedUid),
      "--timeout-ms",
      String(timeoutMs),
    ],
    { timeoutMs: timeoutMs + 5_000, maxBuffer: 64 * 1024 },
  );
  const result = await server.result;
  return { server, result, response: parseJsonOutput(result, "serve") };
}

export async function runPeerScenario({ binary, profilePath, id, pidOffset = 0, uidOffset = 0 }) {
  const workdir = await makeWorkdir();
  const socketPath = join(workdir, "peer.sock");
  try {
    const client = spawnCollected(
      binary,
      ["connect", "--socket", socketPath, "--timeout-ms", String(CLIENT_DEADLINE_MS)],
      { timeoutMs: SERVER_DEADLINE_MS + 5_000, maxBuffer: 64 * 1024 },
    );
    const actualPid = client.pid;
    const actualUid = process.geteuid();
    const expectedPid = actualPid + pidOffset;
    const expectedUid = actualUid + uidOffset;
    const { result: serverResult, response } = await runServeCommand({
      binary,
      workdir,
      profilePath,
      expectedPid,
      expectedUid,
      timeoutMs: SERVER_DEADLINE_MS,
    });
    const clientResult = await client.result;
    return {
      id,
      kind: "real-native",
      command: serverResult.args,
      expected: { pid: expectedPid, uid: expectedUid },
      actual: { pid: actualPid, uid: actualUid },
      exitCode: serverResult.exitCode,
      clientExitCode: clientResult.exitCode,
      clientTimedOut: clientResult.timedOut,
      response,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

export async function runDefaultBlocked({ binary }) {
  const workdir = await makeWorkdir();
  try {
    const result = await runBoundedCommand(
      binary,
      [
        "serve",
        "--workdir",
        workdir,
        "--expect-pid",
        String(process.pid),
        "--expect-uid",
        String(process.geteuid()),
      ],
      { timeoutMs: 10_000, maxBuffer: 64 * 1024 },
    );
    return {
      id: "default-blocked",
      kind: "blocked-precondition",
      command: result.args,
      exitCode: result.exitCode,
      response: parseJsonOutput(result, "default-blocked server"),
    };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

export async function runPolicyScenario({ binary, profilePath, factsPath, id }) {
  const result = await runBoundedCommand(
    binary,
    ["pure-policy-check", "--pure-test-only", "--profile", profilePath, "--facts", factsPath],
    { timeoutMs: 10_000, maxBuffer: 64 * 1024 },
  );
  return {
    id,
    kind: "synthetic-policy-only",
    command: result.args,
    exitCode: result.exitCode,
    response: parseJsonOutput(result, `${id} pure-policy-check`),
  };
}

export async function runExistingSocketScenario({ binary, profilePath }) {
  const workdir = await makeWorkdir();
  const socketPath = join(workdir, "peer.sock");
  const holder = spawnCollected(
    binary,
    ["hold-socket", "--socket", socketPath, "--hold-ms", "5000"],
    {
      timeoutMs: 10_000,
    },
  );
  try {
    let before;
    try {
      before = await waitForPath(socketPath, 3_000);
    } catch (error) {
      holder.child.kill("SIGKILL");
      const holderResult = await holder.result.catch(() => undefined);
      throw new PeerDiagnosticFailureError("existing socket holder did not create the socket", {
        path: socketPath,
        cause: error.message,
        holder: childDetails(holderResult),
      });
    }
    const server = await runServeCommand({
      binary,
      workdir,
      profilePath,
      expectedPid: process.pid,
      expectedUid: process.geteuid(),
      timeoutMs: 2_000,
    });
    const after = await lstat(socketPath);
    return {
      id: "existing-socket-retained",
      kind: "real-native-socket",
      command: server.result.args,
      exitCode: server.result.exitCode,
      before: { inode: before.ino, device: before.dev },
      after: { inode: after.ino, device: after.dev },
      retained: before.ino === after.ino && before.dev === after.dev,
      response: server.response,
    };
  } finally {
    holder.child.kill("SIGKILL");
    await holder.result.catch(() => undefined);
    await rm(workdir, { recursive: true, force: true });
  }
}

export async function runReplacementScenario({ binary, profilePath }) {
  const workdir = await makeWorkdir();
  const socketPath = join(workdir, "peer.sock");
  const client = spawnCollected(
    binary,
    ["connect-replace", "--socket", socketPath, "--hold-ms", "1500", "--timeout-ms", "5000"],
    { timeoutMs: 15_000, maxBuffer: 64 * 1024 },
  );
  try {
    // 中文原因：client 必须先连上原 server 才可能替换 socket 并发出 ready。
    // 因此先启动 server promise（不 await），再等待 client ready，最后收 server 结果，
    // 避免双方互相等待；ready 监听在 spawn server 前已挂好，避免丢失首行事件。
    const serverPromise = runServeCommand({
      binary,
      workdir,
      profilePath,
      expectedPid: client.pid,
      expectedUid: process.geteuid(),
      timeoutMs: 5000,
    });
    let ready;
    try {
      ready = await waitForJsonLine(
        client.child,
        (line) => line.status === "replacement-bound",
        5_000,
      );
    } catch (error) {
      client.child.kill("SIGKILL");
      const clientResult = await client.result.catch(() => undefined);
      await serverPromise.catch(() => undefined);
      throw new PeerDiagnosticFailureError("replacement client did not become ready", {
        cause: error.message,
        waitDetails: error.details ?? null,
        client: childDetails(clientResult),
      });
    }
    const server = await serverPromise;
    const retained = await lstat(socketPath);
    const clientResult = await client.result;
    let cleaned = false;
    try {
      await lstat(socketPath);
    } catch {
      cleaned = true;
    }
    return {
      id: "replaced-socket-retained",
      kind: "real-native-socket",
      command: server.result.args,
      exitCode: server.result.exitCode,
      clientExitCode: clientResult.exitCode,
      replacement: { inode: ready.inode, device: ready.device },
      retained: retained.ino === ready.inode && retained.dev === ready.device,
      clientCleanedReplacement: cleaned,
      response: server.response,
    };
  } finally {
    client.child.kill("SIGKILL");
    await client.result.catch(() => undefined);
    await rm(workdir, { recursive: true, force: true });
  }
}

export async function runPartialFrameScenario({ binary, profilePath }) {
  const workdir = await makeWorkdir();
  const socketPath = join(workdir, "peer.sock");
  const client = spawnCollected(
    binary,
    [
      "connect-partial",
      "--socket",
      socketPath,
      "--declared-bytes",
      "100",
      "--send-bytes",
      "3",
      "--hold-ms",
      "1000",
      "--timeout-ms",
      "3000",
    ],
    { timeoutMs: 10_000, maxBuffer: 64 * 1024 },
  );
  try {
    const server = await runServeCommand({
      binary,
      workdir,
      profilePath,
      expectedPid: client.pid,
      expectedUid: process.geteuid(),
      timeoutMs: 500,
    });
    const clientResult = await client.result;
    return {
      id: "partial-frame-timeout",
      kind: "real-native-socket",
      command: server.result.args,
      exitCode: server.result.exitCode,
      clientExitCode: clientResult.exitCode,
      response: server.response,
    };
  } finally {
    client.child.kill("SIGKILL");
    await client.result.catch(() => undefined);
    await rm(workdir, { recursive: true, force: true });
  }
}
