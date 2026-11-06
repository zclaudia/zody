import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const runnerSource = new URL("./zody-distribution/runner.mjs", import.meta.url);

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "zcode-distribution-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "zcode");
  for (const name of ["bin", "agent", "web", "server", "runtime", "runtime-tools/ripgrep"]) {
    await mkdir(join(root, name), { recursive: true });
  }
  const bundledNode = join(root, "runtime", process.platform === "win32" ? "node.exe" : "node");
  await symlink(process.execPath, bundledNode);
  const toolBytes = Buffer.from("fixture ripgrep");
  await writeFile(join(root, "runtime-tools/ripgrep/rg"), toolBytes);
  await writeFile(
    join(root, "runtime-tools/manifest.json"),
    JSON.stringify({
      version: 1,
      target: `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`,
      tools: [
        {
          id: "ripgrep",
          binaryName: "rg",
          sha256: createHash("sha256").update(toolBytes).digest("hex"),
        },
      ],
    }),
  );
  await cp(runnerSource, join(root, "bin/zcode.mjs"));
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", version: "1.2.3" }));
  await writeFile(
    join(root, "agent/zody.cjs"),
    `
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), entry: process.argv[1], cwd: process.cwd(), execPath: process.execPath }));
process.exitCode = Number(process.env.FIXTURE_EXIT_CODE || 0);
`,
  );
  if (process.platform !== "win32") {
    const cliStub = join(root, "bin/zody-cli");
    await writeFile(
      cliStub,
      `#!${bundledNode}\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2), entry: ${JSON.stringify(join(root, "agent/zody.cjs"))}, cwd: process.cwd() }));\nprocess.exitCode = Number(process.env.FIXTURE_EXIT_CODE || 0);\n`,
    );
    await chmod(cliStub, 0o755);
  }
  await writeFile(
    join(root, "server/entry-http.js"),
    `
import { writeFile } from 'node:fs/promises';
await writeFile(process.env.FIXTURE_WEB_RESULT, JSON.stringify({
  cwd: process.cwd(), port: process.env.PORT, host: process.env.ZODY_SERVER_HOST,
  workspace: process.env.ZODY_SERVER_WORKSPACE, staticRoot: process.env.ZODY_WEB_STATIC_ROOT,
  command: process.env.ZODY_AGENT_SERVER_COMMAND, args: JSON.parse(process.env.ZODY_AGENT_SERVER_ARGS_JSON),
  token: process.env.ZODY_SERVER_AUTH_TOKEN, ripgrep: process.env.ZODY_RG_BINARY,
}));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`,
  );
  return { directory, root, runner: join(root, "bin/zcode.mjs") };
}

test("default launch and CLI arguments invoke the bundled CLI without starting Web", async (t) => {
  if (process.platform === "win32") return t.skip("runner executable fixture uses a POSIX shebang");
  const { runner, root, directory } = await fixture(t);
  for (const args of [[], ["tui"], ["--prompt", "--web"], ["app-server", "--stdio"]]) {
    const result = await exec(process.execPath, [runner, ...args], { cwd: directory });
    assert.deepEqual(JSON.parse(result.stdout), {
      argv: args,
      entry: join(root, "agent/zody.cjs"),
      cwd: directory,
    });
  }
  await assert.rejects(
    exec(process.execPath, [runner], { env: { ...process.env, FIXTURE_EXIT_CODE: "17" } }),
    (error) => error.code === 17,
  );
});

test("help exposes Web mode and preserves CLI help; version uses the distribution", async (t) => {
  const { runner } = await fixture(t);
  assert.equal((await exec(process.execPath, [runner, "--version"])).stdout.trim(), "1.2.3");
  const help = (await exec(process.execPath, [runner, "--help"])).stdout;
  assert.match(help, /zody --web/);
  assert.match(help, /"argv":\["--help"\]/);
  const webHelp = (await exec(process.execPath, [runner, "--web", "--help"])).stdout;
  assert.match(webHelp, /--workspace/);
  assert.doesNotMatch(webHelp, /"argv"/);
  await assert.rejects(exec(process.execPath, [runner, "--web", "--unknown"]), /Unknown option/);
  await assert.rejects(
    exec(process.execPath, [runner, "--web", "--port", "NaN"]),
    /--port must be an integer/,
  );
});

test("Web startup errors preserve a failing exit code", async (t) => {
  const { runner, directory, root } = await fixture(t);
  await assert.rejects(
    exec(process.execPath, [
      runner,
      "--web",
      "--workspace",
      join(directory, "missing"),
      "--no-open",
    ]),
    /Unable to start Web server/,
  );
  await rm(join(root, "server/entry-http.js"));
  await assert.rejects(
    exec(process.execPath, [runner, "--web", "--no-open"]),
    /Missing runtime file/,
  );
});

test("Web mode refuses an unauthenticated network listener", async (t) => {
  const { runner, root } = await fixture(t);
  await rm(join(root, "runtime-tools/manifest.json"));
  await assert.rejects(
    exec(process.execPath, [runner, "--web", "--host", "0.0.0.0", "--no-token", "--no-open"]),
    /--no-token is only allowed when --host is a loopback address/,
  );
});

test("Web mode passes its runtime configuration and terminates its child on shutdown", async (t) => {
  const { directory, runner, root } = await fixture(t);
  const resultPath = join(directory, "web-result.json");
  const child = spawn(
    process.execPath,
    [
      runner,
      "--web",
      "--workspace",
      directory,
      "--host",
      "127.0.0.1",
      "--port",
      "3041",
      "--no-open",
      "--no-token",
    ],
    {
      env: {
        ...process.env,
        FIXTURE_WEB_RESULT: resultPath,
        ZODY_SERVER_AUTH_TOKEN: "stale-token",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  let result;
  for (let attempt = 0; attempt < 100; attempt++) {
    result = await readFile(resultPath, "utf8")
      .then(JSON.parse)
      .catch(() => undefined);
    if (result) break;
    await setTimeout(20);
  }
  assert.deepEqual(result, {
    cwd: directory,
    port: "3041",
    host: "127.0.0.1",
    workspace: directory,
    staticRoot: join(root, "web"),
    command: join(root, "runtime", process.platform === "win32" ? "node.exe" : "node"),
    args: [join(root, "agent/zody.cjs"), "app-server", "--stdio"],
    token: "",
    ripgrep: join(root, "runtime-tools/ripgrep/rg"),
  });
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
});

test("Web runtime rejects a changed target-native binary before starting the server", async (t) => {
  const { runner, root } = await fixture(t);
  await writeFile(join(root, "runtime-tools/ripgrep/rg"), "tampered");
  await assert.rejects(exec(process.execPath, [runner, "--web", "--no-open"]), /checksum mismatch/);
});
