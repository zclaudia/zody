import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const root = resolve(import.meta.dirname, "../..");
const run = promisify(execFile);
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const exists = (path) =>
  access(resolve(root, path)).then(
    () => true,
    () => false,
  );

async function command(args) {
  return (
    await run(pnpm, args, {
      cwd: root,
      maxBuffer: 20 * 1024 * 1024,
      shell: process.platform === "win32",
    })
  ).stdout;
}

function parseTurbo(output) {
  const start = output.search(/^\{/m);
  assert.notEqual(start, -1, "Turbo dry-run JSON was not emitted");
  return JSON.parse(output.slice(start));
}

test("CLI installation is owned by root workspace", async () => {
  assert.equal(await exists("pnpm-workspace.yaml"), true);
  assert.equal(await exists("pnpm-lock.yaml"), true);
  assert.equal(await exists("apps/zody-cli/pnpm-workspace.yaml"), false);
  assert.equal(await exists("apps/zody-cli/pnpm-lock.yaml"), false);
  assert.equal(await exists("turbo.json"), true);
});

test("CLI lint entry and SEA build select only CLI packages", async () => {
  const members = JSON.parse(await command(["-r", "list", "--depth", "-1", "--json"]));
  const cliRoot = resolve(root, "apps/zody-cli") + sep;
  const expected = members
    .filter((member) => member.path.startsWith(cliRoot))
    .map((member) => member.name)
    .sort();
  assert.ok(expected.includes("@zody/cli"));
  const lint = parseTurbo(await command(["--dir", "apps/zody-cli", "lint", "--dry=json"]));
  assert.deepEqual([...lint.packages].sort(), expected);
  assert.ok(lint.tasks.every((task) => expected.includes(task.package)));
  const sea = parseTurbo(
    await command([
      "exec",
      "turbo",
      "run",
      "build",
      "--filter={./apps/zody-cli/packages/*}",
      "--filter={./apps/zody-cli/tools/*}",
      "--filter=!@zody/cli",
      "--force",
      "--dry=json",
    ]),
  );
  assert.deepEqual(
    [...sea.packages].sort(),
    expected.filter((name) => name !== "@zody/cli"),
  );
  assert.ok(sea.tasks.every((task) => task.package !== "@zody/cli"));
});

test(
  "compact Docker command resolves its Dockerfile and repository context from its actual cwd",
  { skip: process.platform === "win32" },
  async (t) => {
    const { mkdtemp, mkdir, writeFile, readFile, chmod, rm, realpath } =
      await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(resolve(tmpdir(), "zody-docker-args-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const bin = resolve(dir, "bin");
    const result = resolve(dir, "args.json");
    await mkdir(bin);
    const fakeDocker = resolve(bin, "docker");
    await writeFile(
      fakeDocker,
      `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > "$ZODY_TEST_DOCKER_ARGS"\n`,
    );
    await chmod(fakeDocker, 0o755);
    await run(pnpm, ["--dir", "apps/zody-cli/e2e/compact-microcompact", "docker:build"], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
        ZODY_TEST_DOCKER_ARGS: result,
      },
    });
    const [cwd, ...args] = (await readFile(result, "utf8")).trim().split("\n");
    assert.equal(args[0], "build");
    const file = args[args.indexOf("-f") + 1];
    assert.equal(
      await realpath(resolve(cwd, file)),
      await realpath(resolve(root, "apps/zody-cli/e2e/compact-microcompact/Dockerfile")),
    );
    assert.equal(await realpath(resolve(cwd, args.at(-1))), await realpath(root));
  },
);

test("compact install selects CLI workspace and its dependency closure without desktop", async () => {
  const members = JSON.parse(await command(["-r", "list", "--depth", "-1", "--json"]));
  const cliRoot = resolve(root, "apps/zody-cli") + sep;
  const cliPackages = members
    .filter((member) => member.path.startsWith(cliRoot))
    .map((member) => member.name);
  const build = parseTurbo(
    await command([
      "exec",
      "turbo",
      "run",
      "build",
      "--filter={./apps/zody-cli/packages/*}",
      "--filter={./apps/zody-cli/tools/*}",
      "--dry=json",
    ]),
  );
  const dependencies = build.tasks
    .filter((task) => !task.directory?.startsWith("apps/zody-cli/"))
    .map((task) => task.package);
  const dockerfile = await readFile(
    resolve(root, "apps/zody-cli/e2e/compact-microcompact/Dockerfile"),
    "utf8",
  );
  const install = dockerfile.match(/pnpm (--filter[\s\S]*?) install --frozen-lockfile/);
  assert.ok(install, "filtered frozen install not found in Dockerfile");
  const filters = [...install[1].matchAll(/--filter\s+(?:'([^']+)'|(\S+))/g)].map(
    (match) => match[1] ?? match[2],
  );
  const selected = JSON.parse(
    await command([
      "-r",
      ...filters.flatMap((filter) => ["--filter", filter]),
      "list",
      "--depth",
      "-1",
      "--json",
    ]),
  );
  assert.deepEqual(
    selected.map((member) => member.name).sort(),
    [...new Set([...cliPackages, ...dependencies, "zody", "zody-cli"])].sort(),
  );
  assert.ok(!selected.some((member) => member.name === "@zody/desktop"));
});
