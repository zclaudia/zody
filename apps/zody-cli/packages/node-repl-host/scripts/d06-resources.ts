import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nodeReplBrowserBrokerRequestSchema } from "@zody/shared/node-repl-browser-broker";

export const D06_CANARY_CONTENT = "D06_TRUSTED_CANARY";
export const D06_BROWSER_TOKEN = "d06-synthetic-browser-token-0000000001";

export interface D06Paths {
  root: string;
  bundlePath: string;
  profilePath: string;
  canaryReadPath: string;
  canaryWritePath: string;
  importCanaryPath: string;
  docsDir: string;
  docsFile: string;
  clientDir: string;
  clientFile: string;
  browserSocketPath: string;
  forbiddenSocketPath: string;
}

export interface D06FixtureServers {
  tcpPort: number;
  stats: {
    tcpAccepted: number;
    forbiddenUnixAccepted: number;
    browserRequests: number;
    browserValidRequests: number;
    browserInvalidRequests: number;
    browserTokenMatches: number;
    browserSchemaValid: number;
    browserListMethods: number;
    browserMethods: string[];
  };
  close(): Promise<void>;
}

export async function createD06Workspace(): Promise<D06Paths> {
  const base = await realpath(tmpdir());
  const root = await mkdtemp(join(base, "zcode-d06-"));
  const docsDir = join(root, "docs");
  const clientDir = join(root, "client");
  await Promise.all([mkdir(docsDir), mkdir(clientDir)]);

  const paths: D06Paths = {
    root,
    bundlePath: join(root, "server.mjs"),
    profilePath: join(root, "d06.sb"),
    canaryReadPath: join(root, "canary-read.txt"),
    canaryWritePath: join(root, "canary-write.txt"),
    importCanaryPath: join(root, "canary-import.mjs"),
    docsDir,
    docsFile: join(docsDir, "guide.md"),
    clientDir,
    clientFile: join(clientDir, "browser-client.mjs"),
    browserSocketPath: join(root, "browser-broker.sock"),
    forbiddenSocketPath: join(root, "forbidden-broker.sock"),
  };

  await Promise.all([
    writeFile(paths.canaryReadPath, D06_CANARY_CONTENT, "utf8"),
    writeFile(paths.canaryWritePath, D06_CANARY_CONTENT, "utf8"),
    writeFile(paths.importCanaryPath, "export const marker = 'D06_DYNAMIC_IMPORT';\n", "utf8"),
    writeFile(paths.docsFile, "# Synthetic Browser docs\n\nD06 read-only fixture.\n", "utf8"),
    writeFile(paths.clientFile, "export const marker = 'D06_CLIENT_IMPORT';\n", "utf8"),
  ]);
  return paths;
}

export async function startD06FixtureServers(paths: D06Paths): Promise<D06FixtureServers> {
  const sockets = new Set<Socket>();
  const stats: D06FixtureServers["stats"] = {
    tcpAccepted: 0,
    forbiddenUnixAccepted: 0,
    browserRequests: 0,
    browserValidRequests: 0,
    browserInvalidRequests: 0,
    browserTokenMatches: 0,
    browserSchemaValid: 0,
    browserListMethods: 0,
    browserMethods: [],
  };
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };

  const browser = createServer((socket) => {
    track(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        stats.browserRequests += 1;
        const request = JSON.parse(buffer.slice(0, newline)) as {
          id?: string;
          op?: string;
          token?: string;
        };
        stats.browserMethods.push(request.op ?? "missing");
        const parsed = nodeReplBrowserBrokerRequestSchema.safeParse(request);
        if (request.token === D06_BROWSER_TOKEN) stats.browserTokenMatches += 1;
        if (parsed.success) stats.browserSchemaValid += 1;
        if (parsed.success && request.op === "list") stats.browserListMethods += 1;
        if (!parsed.success || request.token !== D06_BROWSER_TOKEN || request.op !== "list") {
          stats.browserInvalidRequests += 1;
          socket.end(
            `${JSON.stringify({ id: request.id, ok: false, error: "invalid synthetic request" })}\n`,
          );
          return;
        }
        stats.browserValidRequests += 1;
        socket.end(`${JSON.stringify({ id: request.id, ok: true, browsers: [] })}\n`);
      } catch {
        socket.destroy();
      }
    });
  });
  const forbiddenUnix = createServer((socket) => {
    stats.forbiddenUnixAccepted += 1;
    track(socket);
  });
  const tcp = createServer((socket) => {
    stats.tcpAccepted += 1;
    track(socket);
  });

  try {
    await listenUnix(browser, paths.browserSocketPath);
    await listenUnix(forbiddenUnix, paths.forbiddenSocketPath);
    await listenTcp(tcp);
  } catch (error) {
    await closeServer(browser, sockets);
    await closeServer(forbiddenUnix, sockets);
    await closeServer(tcp, sockets);
    throw error;
  }
  const address = tcp.address();
  if (!address || typeof address === "string")
    throw new Error("synthetic TCP listener has no port");

  return {
    tcpPort: address.port,
    stats,
    async close() {
      await Promise.all([
        closeServer(browser, sockets),
        closeServer(forbiddenUnix, sockets),
        closeServer(tcp, sockets),
      ]);
    },
  };
}

export async function writeD06Profile(paths: D06Paths, profile: string): Promise<void> {
  await writeFile(paths.profilePath, profile, "utf8");
}

export async function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  const contents = await readFile(path);
  return {
    sha256: createHash("sha256").update(contents).digest("hex"),
    bytes: contents.byteLength,
  };
}

export async function cleanupD06Workspace(
  paths: D06Paths | undefined,
  servers: D06FixtureServers | undefined,
): Promise<{ removed: boolean; error?: string }> {
  const errors: string[] = [];
  if (servers) {
    await servers.close().catch((error: unknown) => errors.push(errorText(error)));
  }
  if (paths) {
    await rm(paths.root, { force: true, recursive: true }).catch((error: unknown) =>
      errors.push(errorText(error)),
    );
  }
  return errors.length === 0 ? { removed: true } : { removed: false, error: errors.join("; ") };
}

export async function waitForDead(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("cause" in error && error.cause && typeof error.cause === "object") {
    if ("code" in error.cause && typeof error.cause.code === "string") return error.cause.code;
  }
  return null;
}

function listenUnix(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function listenTcp(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

export function dirnameOf(path: string): string {
  return dirname(path);
}
