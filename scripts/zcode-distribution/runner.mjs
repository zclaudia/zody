#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const runtimeNode = join(root, "runtime", process.platform === "win32" ? "node.exe" : "node");
const serverEntry = join(root, "server", "entry-http.js");
const webRoot = join(root, "web");
const agentEntry = join(root, "agent", "zcode.cjs");
const cliBinary = join(root, "bin", process.platform === "win32" ? "zody-cli.exe" : "zody-cli");
const runtimeToolsRoot = join(root, "runtime-tools");
const runtimeToolEnvNames = Object.freeze({
  bfs: "ZCODE_BFS_BINARY",
  ripgrep: "ZCODE_RG_BINARY",
  ugrep: "ZCODE_UGREP_BINARY",
});

function usage() {
  return `Usage:
  zody --web [--host <host>] [--port <port>] [--workspace <path>] [--open|--no-open] [--token <token>|--no-token]
  zody --version
`;
}

function readArgValue(argv, arg, index) {
  if (arg.includes("=")) {
    return { nextIndex: index, value: arg.slice(arg.indexOf("=") + 1) };
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${arg}`);
  }
  return { nextIndex: index + 1, value };
}

function parseArgs(argv) {
  const options = {
    command: "serve",
    host: "127.0.0.1",
    open: undefined,
    port: undefined,
    token: undefined,
    tokenEnabled: undefined,
    workspace: process.cwd(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.command = "help";
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      options.command = "version";
      continue;
    }
    if (arg === "--host" || arg.startsWith("--host=")) {
      const parsed = readArgValue(argv, arg, index);
      options.host = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--port" || arg.startsWith("--port=")) {
      const parsed = readArgValue(argv, arg, index);
      options.port = Number(parsed.value);
      if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
        throw new Error("--port must be an integer between 0 and 65535");
      }
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--workspace" || arg.startsWith("--workspace=")) {
      const parsed = readArgValue(argv, arg, index);
      options.workspace = resolve(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--open") {
      options.open = true;
      continue;
    }
    if (arg === "--no-open") {
      options.open = false;
      continue;
    }
    if (arg === "--token" || arg.startsWith("--token=")) {
      const parsed = readArgValue(argv, arg, index);
      options.token = parsed.value;
      options.tokenEnabled = true;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--no-token") {
      options.tokenEnabled = false;
      continue;
    }
    throw new Error(`Unknown option "${arg}".\n${usage()}`);
  }

  return options;
}

function isLocalHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function shouldProtectHost(host) {
  return !isLocalHost(host);
}

function createToken() {
  return randomBytes(24).toString("base64url");
}

function pickPort(host) {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

function formatUrl(host, port, token) {
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const base = `http://${displayHost}:${port}/`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

function networkUrls(port, token) {
  const urls = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") {
        continue;
      }
      const base = `http://${entry.address}:${port}/`;
      urls.push(token ? `${base}?token=${encodeURIComponent(token)}` : base);
    }
  }
  return urls;
}

function openBrowser(url) {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function assertRuntimeFiles() {
  for (const file of [serverEntry, agentEntry, webRoot]) {
    await access(file).catch((cause) => {
      throw new Error(`Missing runtime file: ${file}`, { cause });
    });
  }
}

async function serve(options) {
  if (shouldProtectHost(options.host) && options.tokenEnabled === false) {
    // 网络监听必须启用访问令牌，防止 --no-token 意外暴露 Agent 服务。
    throw new Error("--no-token is only allowed when --host is a loopback address.");
  }
  await assertRuntimeFiles();
  const runtimeToolEnv = await runtimeToolsEnvironment();
  const port = options.port && options.port > 0 ? options.port : await pickPort(options.host);
  const protect = options.tokenEnabled ?? shouldProtectHost(options.host);
  const token = protect ? (options.token ?? createToken()) : "";
  const open = options.open ?? isLocalHost(options.host);
  const localUrl = formatUrl(options.host, port, token);

  const child = spawn(runtimeNode, [serverEntry], {
    cwd: options.workspace,
    env: {
      ...process.env,
      ...runtimeToolEnv,
      PORT: String(port),
      ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([agentEntry, "app-server", "--stdio"]),
      ZCODE_AGENT_SERVER_COMMAND: runtimeNode,
      ZCODE_SERVER_HOST: options.host,
      ZCODE_SERVER_WORKSPACE: options.workspace,
      ZCODE_WEB_STATIC_ROOT: webRoot,
      // 显式关闭 token 时必须清空继承值，否则 --no-token 仍会开启后端鉴权。
      ZCODE_SERVER_AUTH_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let shuttingDown = false;
  child.on("error", (error) => {
    console.error(`Unable to start Web server: ${error.message}`);
    process.exit(1);
  });

  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      process.exit(0);
    }
    if (signal) {
      process.exit(1);
    }
    process.exit(code ?? 0);
  });

  console.log("");
  console.log("Zody Web is running");
  console.log(`Local:   ${localUrl}`);
  if (options.host === "0.0.0.0" || options.host === "::") {
    for (const url of networkUrls(port, token)) {
      console.log(`Network: ${url}`);
    }
  }
  console.log("Press Ctrl+C to stop.");
  console.log("");

  if (open) {
    setTimeout(() => openBrowser(localUrl), 500);
  }

  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    child.kill("SIGTERM");
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", (chunk) => {
      if (chunk.includes(3)) {
        shutdown();
      }
    });
    process.stdin.on("error", () => {
      if (!shuttingDown) {
        shutdown();
      }
    });
  }
}

async function runtimeToolsEnvironment() {
  const manifest = JSON.parse(await readFile(join(runtimeToolsRoot, "manifest.json"), "utf8"));
  const expectedTarget = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
  if (
    manifest.version !== 1 ||
    manifest.target !== expectedTarget ||
    !Array.isArray(manifest.tools)
  ) {
    throw new Error(`Invalid native runtime manifest for ${expectedTarget}`);
  }
  const env = {};
  for (const tool of manifest.tools) {
    const envName = runtimeToolEnvNames[tool.id];
    if (!envName || typeof tool.binaryName !== "string" || !/^[a-f0-9]{64}$/u.test(tool.sha256)) {
      throw new Error(`Invalid native runtime entry: ${JSON.stringify(tool)}`);
    }
    const binaryPath = join(runtimeToolsRoot, tool.id, tool.binaryName);
    const bytes = await readFile(binaryPath).catch((cause) => {
      throw new Error(`Missing native runtime tool ${tool.id}: ${binaryPath}`, { cause });
    });
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== tool.sha256) throw new Error(`Native runtime checksum mismatch for ${tool.id}`);
    if (!(await stat(binaryPath)).isFile())
      throw new Error(`Invalid native runtime tool ${tool.id}`);
    env[envName] = binaryPath;
  }
  return env;
}

function runCli(argv) {
  const child = spawn(cliBinary, argv, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  child.once("error", (error) => {
    console.error(`Unable to start Zody CLI: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
}

try {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && ["--version", "-v"].includes(argv[0])) {
    console.log(version);
  } else if (argv[0] === "--web") {
    const options = parseArgs(argv.slice(1));
    if (options.command === "help") console.log(usage());
    else if (options.command === "version") console.log(version);
    else await serve(options);
  } else {
    if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
      console.log("Web mode: zody --web [options] (zody --web --help for details)\n");
    }
    runCli(argv);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
