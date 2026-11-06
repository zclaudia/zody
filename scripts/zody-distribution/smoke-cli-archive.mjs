#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { buildLaunchCommand } from "./command.mjs";
import { waitForWebResponse } from "./http-smoke.mjs";

const exec = promisify(execFile);
const archive = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!archive) throw new Error("Usage: smoke-cli-archive.mjs <zody-cli-<version>-<target>.tar.gz>");
const directory = await mkdtemp(join(tmpdir(), "zody smoke path-"));
const isolatedPath =
  process.platform === "win32" ? `${process.env.SystemRoot}\\System32` : "/usr/bin:/bin";
const env = { ...process.env, PATH: isolatedPath };
let webChild;

try {
  await exec("tar", ["-xzf", archive, "-C", directory]);
  const packageRoot = join(directory, "zody");
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const currentTarget = `${process.platform === "win32" ? "win32" : process.platform}-${process.arch}`;
  assert.equal(
    metadata.target,
    currentTarget,
    `archive target ${metadata.target} does not match ${currentTarget}`,
  );
  const launcher = join(packageRoot, "bin", process.platform === "win32" ? "zody.cmd" : "zody");
  const run = async (args) => {
    const launch = buildLaunchCommand(launcher, args, process.platform, env);
    return exec(launch.command, launch.args, { cwd: directory, env, windowsHide: true });
  };
  const version = await run(["--version"]);
  assert.equal(version.stdout.trim(), metadata.version);
  const help = await run(["--help"]);
  assert.match(help.stdout, /Web mode:/u);

  const workspace = join(directory, "workspace with spaces");
  await mkdir(workspace);
  const lines = [];
  const webLaunch = buildLaunchCommand(
    launcher,
    [
      "--web",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--workspace",
      workspace,
      "--no-open",
      "--no-token",
    ],
    process.platform,
    env,
  );
  webChild = spawn(webLaunch.command, webLaunch.args, {
    cwd: workspace,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: webLaunch.shell,
  });
  webChild.stdout.setEncoding("utf8");
  webChild.stderr.setEncoding("utf8");
  webChild.stdout.on("data", (chunk) => lines.push(chunk));
  webChild.stderr.on("data", (chunk) => lines.push(chunk));
  webChild.once("error", (error) => {
    webChild.spawnError = error;
  });
  const address = await waitForWebAddress(webChild, lines);
  const response = await waitForWebResponse(webChild, address, lines);
  assert.equal(response.status, 200, `Web smoke returned HTTP ${response.status}`);
  if (process.platform === "win32") {
    await exec(join(process.env.SystemRoot, "System32", "taskkill.exe"), [
      "/PID",
      String(webChild.pid),
      "/T",
      "/F",
    ]);
    await waitForExit(webChild, { allowFailure: true });
  } else {
    if (!webChild.kill("SIGTERM")) throw new Error("Unable to stop Web smoke process");
    await waitForExit(webChild);
  }
  console.log(`CLI/Web archive smoke passed: ${metadata.target} (${metadata.version})`);
} finally {
  if (webChild && webChild.exitCode === null) webChild.kill();
  await rm(directory, { recursive: true, force: true });
}

async function waitForWebAddress(child, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const text = output.join("");
    if (child.spawnError) throw child.spawnError;
    const match = text.match(/Local:\s+(http:\/\/127\.0\.0\.1:\d+\/)/u);
    if (match) return match[1];
    if (child.exitCode !== null) throw new Error(`Web runner exited ${child.exitCode}: ${text}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for Web server startup: ${output.join("")}`);
}

async function waitForExit(child, { allowFailure = false } = {}) {
  if (child.exitCode !== null) return;
  await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code) =>
      code === 0 || allowFailure
        ? resolveExit()
        : rejectExit(new Error(`Web runner exited ${code}`)),
    );
  });
}
