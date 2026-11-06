import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Socket } from "node:net";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const coreDirectory = join(repoRoot, "apps/zody-cli/packages/core");
const corePackagePath = join(coreDirectory, "package.json");
const entryPath = join(
  repoRoot,
  "packages/desktop/native/macos-cua-helper-round11/authority-entry.mjs",
);
const responseTimeoutMs = 10_000;
const buildTimeoutMs = 120_000;

interface AuthorityFrame {
  requestId: string | null;
  method: string;
  result: Record<string, unknown>;
}

interface AuthorityRequest {
  requestId: string;
  method: string;
  payload: Record<string, unknown>;
}

interface AuthorityRef {
  submissionLineageId: string;
  authorizationRevision: number;
  appIncarnation: string;
  hostInstanceId: string;
  runtimeInstanceId: string;
  sessionId: string;
  workspaceKey: string;
}

class AuthorityClient {
  readonly #child: ChildProcess;
  readonly #socket: Socket;
  readonly #frames: AuthorityFrame[] = [];
  #buffer = "";
  #nextRequest = 1;
  #stderr = "";
  #exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  constructor(bundlePath: string, environment: NodeJS.ProcessEnv) {
    this.#child = spawn(process.execPath, [bundlePath], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    this.#socket = this.#child.stdio[3] as Socket;
    this.#socket.setEncoding("utf8");
    this.#socket.on("data", (chunk: string) => this.#read(chunk));
    this.#socket.on("error", () => undefined);
    this.#child.stderr?.setEncoding("utf8");
    this.#child.stderr?.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });
    this.#child.once("exit", (code, signal) => {
      this.#exit = { code, signal };
    });
  }

  async request(method: string, payload: Record<string, unknown>): Promise<AuthorityFrame> {
    const requestId = `request-${this.#nextRequest++}`;
    const request: AuthorityRequest = { requestId, method, payload };
    this.#write(request);
    return this.waitFor((frame) => frame.requestId === requestId);
  }

  sendRaw(line: string): void {
    this.#writeRaw(line);
  }

  pauseResponses(): void {
    this.#socket.pause();
  }

  async waitFor(predicate: (frame: AuthorityFrame) => boolean): Promise<AuthorityFrame> {
    const deadline = Date.now() + responseTimeoutMs;
    while (Date.now() < deadline) {
      const index = this.#frames.findIndex(predicate);
      if (index >= 0) return this.#frames.splice(index, 1)[0]!;
      if (this.#exit) {
        throw new Error(
          `authority entry exited before a matching frame: ${JSON.stringify(this.#exit)}; stderr=${this.#stderr}`,
        );
      }
      await new Promise((resolveWake) => setTimeout(resolveWake, 10));
    }
    throw new Error(`timed out waiting for authority frame; stderr=${this.#stderr}`);
  }

  endInput(): void {
    this.#socket.end();
  }

  async waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.#exit) return this.#exit;
    return new Promise((resolveExit, reject) => {
      const timer = setTimeout(
        () => reject(new Error("authority entry did not exit")),
        responseTimeoutMs,
      );
      this.#child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolveExit({ code, signal });
      });
      this.#child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async kill(): Promise<void> {
    if (this.#exit) return;
    this.#child.kill("SIGKILL");
    await this.waitForExit().catch(() => undefined);
  }

  diagnostics(): string {
    return this.#stderr;
  }

  #read(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length > 0) {
        try {
          this.#frames.push(JSON.parse(line) as AuthorityFrame);
        } catch {
          throw new Error(`authority entry emitted invalid JSON: ${line}`);
        }
      }
      newline = this.#buffer.indexOf("\n");
    }
  }

  #write(frame: AuthorityRequest): void {
    this.#writeRaw(JSON.stringify(frame));
  }

  #writeRaw(line: string): void {
    this.#socket.write(`${line}\n`);
  }
}

function bootstrapPayload(traceId: string): Record<string, unknown> {
  return {
    traceId,
    appIncarnation: "app-r11-authority",
    hostInstanceId: "host-r11-authority",
    runtimeInstanceId: "runtime-r11-authority",
    sessionId: "session-r11-authority",
    workspaceKey: "/workspace/r11-authority",
    sourceCommandId: "command-r11-authority",
    queueItemId: "queue-r11-authority",
    producerIncarnation: "producer-r11-authority",
    runId: "run-r11-authority",
    turnId: "turn-r11-authority",
  };
}

function checkPayload(
  traceId: string,
  ref: AuthorityRef,
  overrides: Partial<Record<"producerIncarnation" | "runId" | "turnId", string>> = {},
): Record<string, unknown> {
  return {
    traceId,
    ref,
    producerIncarnation: "producer-r11-authority",
    runId: "run-r11-authority",
    turnId: "turn-r11-authority",
    ...overrides,
  };
}

function refOf(frame: AuthorityFrame): AuthorityRef {
  const ref = frame.result.ref;
  if (!ref || typeof ref !== "object")
    throw new Error(`response did not contain a ref: ${JSON.stringify(frame)}`);
  return ref as AuthorityRef;
}

describe("macOS CUA R11 real CuaSubmissionAuthority entry", () => {
  let directory = "";
  let bundlePath = "";
  const clients: AuthorityClient[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "zcode-cua-r11-authority-"));
    const packageJson = JSON.parse(await readFile(corePackagePath, "utf8")) as {
      exports?: Record<string, { import?: string; types?: string }>;
    };
    const publicExport = packageJson.exports?.["./cua-submission"];
    if (!publicExport?.import || !publicExport.types) {
      throw new Error("@zody/core does not expose the ./cua-submission public entry");
    }

    const tscPath = resolve(repoRoot, "node_modules/typescript/bin/tsc");
    await execFileAsync(process.execPath, [tscPath, "-p", join(coreDirectory, "tsconfig.json")], {
      cwd: repoRoot,
      timeout: buildTimeoutMs,
    });

    const publicEntry = resolve(coreDirectory, publicExport.import);
    bundlePath = join(directory, "authority-entry.mjs");
    await build({
      alias: { "@zody/core/cua-submission": publicEntry },
      bundle: true,
      entryPoints: [entryPath],
      format: "esm",
      logLevel: "silent",
      outfile: bundlePath,
      platform: "node",
      target: "node24",
    });
  }, buildTimeoutMs);

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.kill()));
    if (directory) await rm(directory, { force: true, recursive: true });
  });

  function startClient(): AuthorityClient {
    const client = new AuthorityClient(bundlePath, { ...process.env });
    clients.push(client);
    return client;
  }

  it("admits one full ref, rejects bad associations, and emits revocation before closing", async () => {
    const client = startClient();
    const traceId = "trace-r11-authority-fixed";
    const bootstrapped = await client.request("bootstrap", bootstrapPayload(traceId));
    expect(bootstrapped).toMatchObject({
      requestId: "request-1",
      method: "bootstrap",
      result: {
        ok: true,
        traceId,
        producerIncarnation: "producer-r11-authority",
        runId: "run-r11-authority",
        turnId: "turn-r11-authority",
        projection: { status: "candidate", nativeFence: "unknown", mobileDelivery: "unknown" },
      },
    });
    const ref = refOf(bootstrapped);
    expect(ref).toMatchObject({
      authorizationRevision: 1,
      appIncarnation: "app-r11-authority",
      hostInstanceId: "host-r11-authority",
      runtimeInstanceId: "runtime-r11-authority",
      sessionId: "session-r11-authority",
      workspaceKey: "/workspace/r11-authority",
    });
    expect(bootstrapped.result).not.toHaveProperty("approved");
    expect(bootstrapped.result).not.toHaveProperty("leaseGranted");

    const duplicate = await client.request("bootstrap", bootstrapPayload(traceId));
    expect(duplicate.result).toMatchObject({ ok: false, reason: "duplicate_bootstrap" });

    const checked = await client.request("check", checkPayload(traceId, ref));
    expect(checked.result).toMatchObject({
      ok: true,
      ref,
      projection: { status: "candidate", ref },
    });

    const wrongRef = await client.request(
      "check",
      checkPayload(traceId, { ...ref, sessionId: "session-wrong" }),
    );
    expect(wrongRef.result).toMatchObject({ ok: false, reason: "ref_mismatch" });

    const staleRevision = await client.request(
      "check",
      checkPayload(traceId, { ...ref, authorizationRevision: ref.authorizationRevision + 1 }),
    );
    expect(staleRevision.result).toMatchObject({ ok: false, reason: "ref_mismatch" });

    const wrongTurn = await client.request(
      "check",
      checkPayload(traceId, ref, { turnId: "turn-wrong" }),
    );
    expect(wrongTurn.result).toMatchObject({ ok: false, reason: "association_mismatch" });

    const revokedPromise = client.request("revoke", { traceId, ref });
    const revocationEvent = await client.waitFor((frame) => frame.method === "revoked");
    expect(revocationEvent.result).toMatchObject({
      ok: true,
      traceId,
      projection: {
        status: "revoked",
        revocationReason: "user-stop",
        nativeFence: "unknown",
        mobileDelivery: "unknown",
      },
    });
    const revoked = await revokedPromise;
    expect(revoked.result).toMatchObject({ ok: true, traceId });
    expect(revoked.result.revocation).toMatchObject({
      status: "revoked",
      revocationReason: "user-stop",
      idempotent: false,
    });

    const afterRevoke = await client.request("check", checkPayload(traceId, ref));
    expect(afterRevoke.result).toMatchObject({ ok: false, reason: "not_candidate" });

    const readmit = await client.request("bootstrap", bootstrapPayload(traceId));
    expect(readmit.result).toMatchObject({ ok: false, reason: "duplicate_bootstrap" });

    const closed = await client.request("close", {});
    expect(closed.result).toMatchObject({ ok: true, closed: true });
    await expect(client.waitForExit()).resolves.toMatchObject({ code: 0, signal: null });
    expect(client.diagnostics()).toBe("");
  });

  it("uses producerLost on FD3 EOF and exits without readmission", async () => {
    const client = startClient();
    const traceId = "trace-r11-authority-eof";
    const bootstrapped = await client.request("bootstrap", bootstrapPayload(traceId));
    expect(bootstrapped.result).toMatchObject({ ok: true });

    client.endInput();
    await expect(client.waitForExit()).resolves.toMatchObject({ code: 0, signal: null });
  });

  it("rejects malformed JSON without creating authority state", async () => {
    const client = startClient();
    client.sendRaw("{not-json");
    const rejected = await client.waitFor((frame) => frame.method === "error");
    expect(rejected).toMatchObject({
      requestId: null,
      result: { ok: false, reason: "invalid_json" },
    });

    const bootstrapped = await client.request(
      "bootstrap",
      bootstrapPayload("trace-r11-authority-after-error"),
    );
    expect(bootstrapped.result).toMatchObject({ ok: true });
    const closed = await client.request("close", {});
    expect(closed.result).toMatchObject({ ok: true, closed: true });
    await expect(client.waitForExit()).resolves.toMatchObject({ code: 0, signal: null });
  });

  it("rejects an oversized NDJSON frame and closes the private transport", async () => {
    const client = startClient();
    client.sendRaw("x".repeat(17 * 1024));
    await expect(client.waitForExit()).resolves.toMatchObject({ code: 0, signal: null });
  });

  it("invalidates instead of buffering unbounded check responses", async () => {
    const client = startClient();
    const traceId = "trace-r11-authority-backpressure";
    const bootstrapped = await client.request("bootstrap", bootstrapPayload(traceId));
    const ref = refOf(bootstrapped);
    const payload = checkPayload(traceId, ref);

    client.pauseResponses();
    for (let index = 0; index < 10_000; index += 1) {
      client.sendRaw(JSON.stringify({ requestId: `load-${index}`, method: "check", payload }));
    }

    await expect(client.waitForExit()).resolves.toMatchObject({ code: 0, signal: null });
  });
});
