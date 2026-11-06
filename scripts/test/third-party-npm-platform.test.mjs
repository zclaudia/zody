import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createInstallablePackageFilter,
  productionPackages,
  readLockfilePlatformConstraints,
} from "../third-party-npm.mjs";

const LOCKFILE = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      sharp:
        specifier: ^0.34.0
        version: 0.34.5

packages:

  '@emnapi/runtime@1.9.2':
    resolution: {integrity: sha512-a}

  '@img/sharp-linux-s390x@0.34.5':
    resolution: {integrity: sha512-b}
    cpu: [s390x]
    os: [linux]
    libc: [glibc]

  '@img/sharp-linuxmusl-x64@0.34.5':
    resolution: {integrity: sha512-c}
    cpu: [x64]
    os: [linux]
    libc: [musl]

  '@img/sharp-wasm32@0.34.5':
    resolution: {integrity: sha512-d}
    cpu: [wasm32]

  fsevents@2.3.3:
    resolution: {integrity: sha512-e}
    os: [darwin]

  not-windows@1.0.0:
    resolution: {integrity: sha512-f}
    os: ['!win32']

snapshots:

  '@img/sharp-wasm32@0.34.5':
    dependencies:
      '@emnapi/runtime': 1.9.2
    cpu: [arm]
`;

const TARGETS = { os: ["darwin", "linux", "win32"], cpu: ["arm64", "x64"], libc: null };

test("只读取 packages 段的 os/cpu/libc 约束，snapshots 段不参与", () => {
  const constraints = readLockfilePlatformConstraints(LOCKFILE);
  assert.deepEqual(constraints.get("@img/sharp-linux-s390x@0.34.5"), {
    cpu: ["s390x"],
    os: ["linux"],
    libc: ["glibc"],
  });
  assert.deepEqual(constraints.get("@img/sharp-wasm32@0.34.5"), { cpu: ["wasm32"] });
  assert.deepEqual(constraints.get("fsevents@2.3.3"), { os: ["darwin"] });
  assert.deepEqual(constraints.get("not-windows@1.0.0"), { os: ["!win32"] });
  assert.equal(constraints.has("@emnapi/runtime@1.9.2"), false);
});

test("与 pnpm 可安装规则一致：非目标 cpu/os 排除，libc 只在宿主 libc 已知时参与", () => {
  const constraints = readLockfilePlatformConstraints(LOCKFILE);
  const installable = createInstallablePackageFilter(constraints, TARGETS);
  assert.equal(installable("@img/sharp-linux-s390x", "0.34.5"), false);
  assert.equal(installable("@img/sharp-wasm32", "0.34.5"), false);
  assert.equal(installable("fsevents", "2.3.3"), true);
  // pnpm 的否定项语义：目标平台里只要有一个被否定，整个包就不安装。
  assert.equal(installable("not-windows", "1.0.0"), false);
  assert.equal(installable("@img/sharp-linuxmusl-x64", "0.34.5"), true);
  assert.equal(installable("@emnapi/runtime", "1.9.2"), true);

  const glibcHost = createInstallablePackageFilter(constraints, { ...TARGETS, libc: ["glibc"] });
  assert.equal(glibcHost("@img/sharp-linuxmusl-x64", "0.34.5"), false);

  const darwinOnly = createInstallablePackageFilter(constraints, { ...TARGETS, os: ["darwin"] });
  assert.equal(darwinOnly("not-windows", "1.0.0"), true);
  assert.equal(darwinOnly("fsevents", "2.3.3"), true);
  const linuxOnly = createInstallablePackageFilter(constraints, { ...TARGETS, os: ["linux"] });
  assert.equal(linuxOnly("fsevents", "2.3.3"), false);
});

test("不可安装的平台包及只经由它引入的依赖不进生产图", () => {
  const constraints = readLockfilePlatformConstraints(LOCKFILE);
  const installable = createInstallablePackageFilter(constraints, TARGETS);
  const wasm = {
    version: "0.34.5",
    dependencies: { "@emnapi/runtime": { version: "1.9.2" } },
  };
  const onlyViaWasm = [
    {
      name: "app",
      dependencies: {
        sharp: {
          version: "0.34.5",
          optionalDependencies: {
            "@img/sharp-wasm32": wasm,
            "@img/sharp-linux-s390x": { version: "0.34.5" },
          },
        },
      },
    },
  ];
  assert.deepEqual([...productionPackages(onlyViaWasm, installable).keys()], ["sharp@0.34.5"]);

  const alsoDirect = [
    { ...onlyViaWasm[0], optionalDependencies: { "@emnapi/runtime": { version: "1.9.2" } } },
  ];
  assert.deepEqual([...productionPackages(alsoDirect, installable).keys()].sort(), [
    "@emnapi/runtime@1.9.2",
    "sharp@0.34.5",
  ]);
});

test("带 peer 或 patch 后缀的版本按基础版本匹配锁文件约束", () => {
  const constraints = readLockfilePlatformConstraints(LOCKFILE);
  const installable = createInstallablePackageFilter(constraints, TARGETS);
  assert.equal(installable("@img/sharp-wasm32", "0.34.5(patch_hash=abc)"), false);
});

test("workspace 身份不按同名或同名同版本吞掉第三方生产依赖", async () => {
  const { prepareWorkspaceIdentity } = await import("../third-party-npm.mjs");
  const projects = [
    {
      name: "debug",
      version: "0.1.0",
      path: "/repo/workspace/debug",
      dependencies: {
        ownAlias: { name: "debug", version: "link:../debug", path: "/repo/workspace/debug" },
        debug: { name: "debug", version: "4.4.3", path: "/repo/node_modules/debug" },
        sameVersion: { name: "debug", version: "0.1.0", path: "/repo/node_modules/same" },
      },
    },
  ];
  const identity = await prepareWorkspaceIdentity(projects, projects, {
    canonicalize: async (p) => p,
  });
  const required = productionPackages(projects, () => true, identity);
  assert.deepEqual([...required.keys()].sort(), ["debug@0.1.0", "debug@4.4.3"]);
  assert.deepEqual([...productionPackages(projects, () => true, identity).keys()].sort(), [
    "debug@0.1.0",
    "debug@4.4.3",
  ]);
  assert.throws(
    () =>
      productionPackages(
        [{ ...projects[0], dependencies: { alien: { version: "link:../unknown" } } }],
        () => true,
        identity,
      ),
    /workspace|link|identity/i,
  );
});

test("安装扫描按真实路径排除 workspace，同时保留外部同名版本与所有副本", async (t) => {
  const { mkdtemp, mkdir, writeFile, symlink, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { scanInstalledPackages, collectInstalledLicenseRecords, verifyInstalledCopies } =
    await import("../third-party-npm.mjs");
  const root = await mkdtemp(join(tmpdir(), "zody-license-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const own = join(root, "workspace/debug");
  async function pkg(dir, name, version, license) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name, version, license: "MIT" }));
    await writeFile(join(dir, "LICENSE"), license);
  }
  await pkg(own, "debug", "0.1.0", "workspace license\n");
  await pkg(join(root, "node_modules/debug"), "debug", "4.4.3", "external 4\n");
  await pkg(join(root, "node_modules/alias-debug"), "debug", "0.1.0", "external same version\n");
  await pkg(join(own, "node_modules/debug"), "debug", "2.6.9", "external 2\n");
  await pkg(join(own, "node_modules/debug-copy"), "debug", "4.4.3", "external 4\n");
  await symlink(own, join(root, "node_modules/own-alias"), "dir");
  const result = await scanInstalledPackages(root, [
    { name: "debug", version: "0.1.0", path: own },
  ]);
  assert.deepEqual([...result.keys()].sort(), ["debug@0.1.0", "debug@2.6.9", "debug@4.4.3"]);
  assert.equal(result.get("debug@0.1.0").pkg.license, "MIT");
  assert.notEqual(result.get("debug@0.1.0").directory, own);
  assert.equal(
    await (
      await import("node:fs/promises")
    ).readFile(join(result.get("debug@0.1.0").directory, "LICENSE"), "utf8"),
    "external same version\n",
  );
  assert.deepEqual(
    result
      .get("debug@4.4.3")
      .copies.map((copy) => copy.directory)
      .sort(),
    (
      await Promise.all(
        [join(root, "node_modules/debug"), join(own, "node_modules/debug-copy")].map((p) =>
          import("node:fs/promises").then(({ realpath }) => realpath(p)),
        ),
      )
    ).sort(),
  );
  await verifyInstalledCopies("debug@4.4.3", result.get("debug@4.4.3"));
  const basic = await collectInstalledLicenseRecords(
    result,
    new Map([["debug@4.4.3", {}]]),
    (pkg) => pkg.license,
  );
  assert.equal(basic.get("debug@2.6.9").isProd, false);
  assert.equal(basic.get("debug@2.6.9").license, "MIT");
  assert.equal(basic.get("debug@4.4.3").isProd, true);
});

test("同名 workspace 不得让 npm debug 生产包消失", () => {
  const projects = [
    {
      name: "debug",
      path: "/repo/debug",
      dependencies: {
        debug: { name: "debug", version: "4.4.3", path: "/repo/node_modules/debug" },
      },
    },
  ];
  assert.deepEqual([...productionPackages(projects).keys()], ["debug@4.4.3"]);
});

test("锁图与安装图的多层 workspace link 使用相同父路径并核对冲突", async () => {
  const { prepareWorkspaceIdentity, assertProductionGraphs } =
    await import("../third-party-npm.mjs");
  const nested = {
    name: "nested",
    version: "link:../nested",
    dependencies: { external: { name: "external", version: "1.0.0" } },
  };
  const locked = [
    {
      name: "app",
      path: "/repo/app",
      dependencies: {
        alias: { name: "first", version: "link:../first", dependencies: { nested } },
      },
    },
    { name: "first", path: "/repo/first" },
    { name: "nested", path: "/repo/nested" },
  ];
  const actual = [
    {
      ...locked[0],
      dependencies: {
        alias: {
          ...locked[0].dependencies.alias,
          path: "/repo/first",
          dependencies: { nested: { ...nested, path: "/repo/nested" } },
        },
      },
    },
    ...locked.slice(1),
  ];
  const identity = await prepareWorkspaceIdentity(locked, actual, { canonicalize: async (p) => p });
  assert.deepEqual(
    [...assertProductionGraphs(locked, actual, () => true, identity).keys()],
    ["external@1.0.0"],
  );
  const conflicting = [
    {
      ...actual[0],
      dependencies: { alias: { ...actual[0].dependencies.alias, path: "/repo/nested" } },
    },
    ...actual.slice(1),
  ];
  const conflictIdentity = await prepareWorkspaceIdentity(locked, conflicting, {
    canonicalize: async (p) => p,
  });
  assert.throws(
    () => productionPackages(conflicting, () => true, conflictIdentity),
    /Conflicting workspace link identity/,
  );
});

test("外部 @zody 命名空间不会被当成 workspace", () => {
  const graph = [
    {
      name: "app",
      path: "/repo/app",
      dependencies: {
        "@zody/foreign": { version: "1.0.0", path: "/repo/node_modules/@zody/foreign" },
      },
    },
  ];
  assert.deepEqual([...productionPackages(graph).keys()], ["@zody/foreign@1.0.0"]);
});

test("真实符号链接与别名按目标区分 workspace 和第三方", async (t) => {
  const { mkdtemp, mkdir, symlink, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { prepareWorkspaceIdentity } = await import("../third-party-npm.mjs");
  const root = await mkdtemp(join(tmpdir(), "identity-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, "app"),
    own = join(root, "own"),
    external = join(root, "external");
  await Promise.all([app, own, external].map((dir) => mkdir(dir)));
  await symlink(own, join(root, "own-alias"), process.platform === "win32" ? "junction" : "dir");
  await symlink(
    external,
    join(root, "external-alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const graph = [
    {
      name: "app",
      path: app,
      dependencies: {
        ownAlias: { version: "link:../own-alias", path: join(root, "own-alias") },
        foreignAlias: { version: "1.0.0", path: join(root, "external-alias") },
      },
    },
    { name: "own", path: own },
  ];
  const identity = await prepareWorkspaceIdentity(graph, graph);
  assert.deepEqual(
    [...productionPackages(graph, () => true, identity).keys()],
    ["foreignAlias@1.0.0"],
  );
  const broken = [
    { ...graph[0], dependencies: { missingAlias: { version: "link:../missing" } } },
    graph[1],
  ];
  const brokenIdentity = await prepareWorkspaceIdentity(broken, broken);
  assert.throws(
    () => productionPackages(broken, () => true, brokenIdentity),
    (error) =>
      error.message.includes(app) &&
      error.message.includes("missingAlias") &&
      error.message.includes("missing"),
  );
  const alien = [
    { ...graph[0], dependencies: { alienAlias: { version: "link:../external", path: external } } },
    graph[1],
  ];
  const alienIdentity = await prepareWorkspaceIdentity(alien, alien);
  assert.throws(
    () => productionPackages(alien, () => true, alienIdentity),
    (error) =>
      error.message.includes(app) &&
      error.message.includes("alienAlias") &&
      error.message.includes(external),
  );
});
