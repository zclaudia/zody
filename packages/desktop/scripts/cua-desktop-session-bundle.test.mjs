import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  auditEntry,
  bundleEntry,
  findWebAssemblyReferences,
  loadUnsupportedNativeModules,
  staleWorkspaceDistInputs,
  validateEntryPins,
  workspaceSourceCounterpart,
} from "./lib/cua-desktop-session-bundle.mjs";
import {
  APP_ICON_FILE,
  APP_ICON_SOURCE,
  ENTRY_NAMES,
  REPO_ROOT,
} from "./lib/cua-desktop-session-config.mjs";
import { appInfoPlist } from "./lib/cua-desktop-session-pins.mjs";
import { sha256File } from "./lib/cua-desktop-session-toolchain.mjs";
import { createWorkspaceSourcePlugin } from "./lib/cua-desktop-session-workspace-source.mjs";

function pinEntries() {
  return ENTRY_NAMES.map((name, index) => ({
    name,
    sha256: String(index + 1).repeat(64),
    bytes: 100 + index,
    maxBytes: 1024,
  }));
}

test("entry pins stay bound to their own name and hash", () => {
  const pins = validateEntryPins(pinEntries());
  assert.deepEqual(Object.keys(pins), ENTRY_NAMES);

  const wrongName = pinEntries();
  wrongName[0].name = "fixture-entry.mjs";
  assert.throws(
    () => validateEntryPins(wrongName),
    (error) => {
      assert.equal(error.code, "entry-pin-name-mismatch");
      return true;
    },
  );

  const sameHash = pinEntries();
  sameHash[1].sha256 = sameHash[0].sha256;
  assert.throws(
    () => validateEntryPins(sameHash),
    (error) => {
      assert.equal(error.code, "entry-pin-hash-collision");
      return true;
    },
  );
});

test("unsupported native shim must match its fixed hash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cua-session-pins-"));
  try {
    const shim = join(dir, "shim.cjs");
    await writeFile(shim, "throw new Error('unsupported');\n");
    const pins = join(dir, "pins.json");
    await writeFile(
      pins,
      JSON.stringify({
        modules: {
          "node-pty": { file: "shim.cjs", sha256: "0".repeat(64), capability: "terminal" },
        },
      }),
    );
    await assert.rejects(
      () => loadUnsupportedNativeModules(pins),
      (error) => {
        assert.equal(error.code, "unsupported-shim-mismatch");
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspace dist inputs map to current source behind workspace exports", async () => {
  const mapped = await workspaceSourceCounterpart(
    "apps/zody-cli/packages/bootstrap/dist/app/create-app.js",
  );
  assert.equal(mapped, join(REPO_ROOT, "apps/zody-cli/packages/bootstrap/src/app/create-app.ts"));
  assert.deepEqual(
    staleWorkspaceDistInputs({
      inputs: {
        "apps/zody-cli/packages/bootstrap/dist/app/create-app.js": {},
        "apps/zody-cli/packages/contracts/dist/no-source-counterpart.js": {},
        "node_modules/example/dist/index.js": {},
        "apps/zody-cli/packages/adapters/node_modules/agent-base/dist/index.js": {},
      },
    }),
    [
      "apps/zody-cli/packages/bootstrap/dist/app/create-app.js",
      "apps/zody-cli/packages/contracts/dist/no-source-counterpart.js",
    ],
  );
  assert.equal(await workspaceSourceCounterpart("node_modules/example/dist/index.js"), undefined);
  assert.equal(
    await workspaceSourceCounterpart(
      "apps/zody-cli/packages/adapters/node_modules/agent-base/dist/index.js",
    ),
    undefined,
  );
});

test("workspace source resolver restores caller pluginData", async () => {
  const plugin = createWorkspaceSourcePlugin();
  let resolver;
  const resolutions = [];
  plugin.setup({
    onResolve(_filter, callback) {
      resolver = callback;
    },
    async resolve(path, options) {
      resolutions.push({ path, options });
      return {
        path:
          path === "@zody/bootstrap/app/create-app"
            ? join(REPO_ROOT, "apps/zody-cli/packages/bootstrap/dist/app/create-app.js")
            : join(REPO_ROOT, "apps/zody-cli/packages/contracts/dist/no-source-counterpart.js"),
        namespace: "file",
        errors: [],
        warnings: [],
        external: false,
        sideEffects: true,
        pluginData: options.pluginData,
      };
    },
  });

  const callerPluginData = { caller: "test" };
  const resolveArgs = (path) => ({
    path,
    importer: join(REPO_ROOT, "apps/zody-cli/packages/bootstrap/src/app/create-app.ts"),
    namespace: "file",
    resolveDir: join(REPO_ROOT, "apps/zody-cli/packages/bootstrap/src/app"),
    kind: "import-statement",
    pluginData: callerPluginData,
  });

  const mapped = await resolver(resolveArgs("@zody/bootstrap/app/create-app"));
  assert.equal(resolutions[0].options.pluginData.cuaWorkspaceSourceResolving, true);
  assert.equal(
    mapped.path,
    join(REPO_ROOT, "apps/zody-cli/packages/bootstrap/src/app/create-app.ts"),
  );
  assert.equal(mapped.pluginData, callerPluginData);

  const normal = await resolver(resolveArgs("@zody/contracts/no-source-counterpart"));
  assert.equal(
    normal.path,
    join(REPO_ROOT, "apps/zody-cli/packages/contracts/dist/no-source-counterpart.js"),
  );
  assert.equal(normal.pluginData, callerPluginData);
  assert.equal(normal.pluginData.cuaWorkspaceSourceResolving, undefined);
});

test("sealed entry audit rejects runtime package resolution and records wasm references", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cua-session-audit-"));
  try {
    const metafile = join(dir, "metafile.json");
    await writeFile(metafile, JSON.stringify({ inputs: {}, outputs: {} }));
    const output = join(dir, "entry.mjs");

    await writeFile(output, "const value = __require('left-pad');\n");
    await assert.rejects(
      () =>
        auditEntry({
          name: "host-entry.mjs",
          output,
          metafilePath: metafile,
          maxBytes: 1024 * 1024,
        }),
      (error) => {
        assert.equal(error.code, "entry-runtime-require");
        return true;
      },
    );

    await writeFile(output, "const mod = await WebAssembly.compile(bytes);\n");
    const audit = await auditEntry({
      name: "host-entry.mjs",
      output,
      metafilePath: metafile,
      maxBytes: 1024 * 1024,
    });
    assert.deepEqual(audit.runtimeExternals, []);
    assert.equal(audit.webAssemblyReferences.count, 1);
    assert.equal(audit.webAssemblyReferences.matches[0].line, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sealed entry audit rejects both workspace scopes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cua-session-scopes-"));
  try {
    const output = join(dir, "entry.mjs");
    const metafilePath = join(dir, "metafile.json");
    await writeFile(metafilePath, JSON.stringify({ inputs: {}, outputs: {} }));
    for (const scope of ["zcode", "zody"]) {
      for (const source of [
        `import value from "@${scope}/shared";`,
        `await import("@${scope}/shared");`,
      ]) {
        await writeFile(output, source);
        await assert.rejects(
          () => auditEntry({ name: "host-entry.mjs", output, metafilePath }),
          (error) => error.code === "entry-external-package",
        );
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sealed entry rejects actual workspace side-effect imports and require calls only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cua-session-syntax-"));
  try {
    const output = join(dir, "entry.mjs");
    const metafilePath = join(dir, "metafile.json");
    await writeFile(metafilePath, JSON.stringify({ inputs: {}, outputs: {} }));
    for (const scope of ["zcode", "zody"]) {
      for (const source of [
        `import "@${scope}/shared";`,
        `await import(\`@${scope}/shared\`, { with: { type: "json" } });`,
        `await import("@${scope}/shared", { with: { type: "json" } });`,
        `require(\`@${scope}/shared\`);`,
        `require("@${scope}/shared");`,
        `__require("@${scope}/shared");`,
      ]) {
        await writeFile(output, source);
        await assert.rejects(
          () => auditEntry({ name: "host-entry.mjs", output, metafilePath }),
          (error) => error.code === "entry-external-package",
        );
      }
    }
    await writeFile(
      output,
      `// import "@zody/shared";
const text = 'require("@zcode/shared")';
import "node:fs";
`,
    );
    await auditEntry({ name: "host-entry.mjs", output, metafilePath });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sealed entry audit rejects stale workspace dist inputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cua-session-stale-dist-"));
  try {
    const metafile = join(dir, "metafile.json");
    const output = join(dir, "entry.mjs");
    await writeFile(output, "const value = 1;\n");
    await writeFile(
      metafile,
      JSON.stringify({
        inputs: { "apps/zody-cli/packages/bootstrap/dist/app/create-app.js": {} },
        outputs: {},
      }),
    );
    await assert.rejects(
      () =>
        auditEntry({
          name: "host-entry.mjs",
          output,
          metafilePath: metafile,
        }),
      (error) => {
        assert.equal(error.code, "entry-stale-workspace-dist");
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("webassembly scan reports the import-time line", () => {
  const scan = findWebAssemblyReferences("first\n  WebAssembly.compile(x)\nlast\n");
  assert.equal(scan.count, 1);
  assert.equal(scan.matches[0].line, 2);
});

test("embedded bundle import.meta.url is pinned to a fixed file URL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cua-session-module-url-"));
  try {
    const entry = join(dir, "entry.mjs");
    await writeFile(
      entry,
      'import { createRequire } from "node:module";\n' +
        "const require = createRequire(import.meta.url);\n" +
        "export const here = import.meta.url;\n" +
        'export const fsType = typeof require("node:fs").readFileSync;\n',
    );
    const output = join(dir, "entry.bundle.mjs");
    const metafilePath = join(dir, "entry.metafile.json");
    await bundleEntry({
      entry,
      output,
      metafilePath,
      unsupportedModules: { fixture: { path: join(dir, "shim.cjs") } },
      moduleUrl: true,
    });
    const text = await readFile(output, "utf8");
    assert.doesNotMatch(text, /import\.meta\.url/);
    assert.match(text, /__cuaModuleUrl/);
    assert.match(text, /__cuaPathToFileURL\(process\.execPath\)/);
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(text, "utf8").toString("base64")}`
    );
    assert.match(module.here, /^file:\/\//);
    assert.equal(module.fsType, "function");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fixture helper keeps hashing through the fixed toolchain module", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cua-session-hash-"));
  try {
    const file = join(dir, "bytes");
    await writeFile(file, "sealed");
    assert.match(await sha256File(file), /^[0-9a-f]{64}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("app bundle declares the fixed icon and the source icns stays present", async () => {
  const plist = appInfoPlist();
  assert.match(plist, new RegExp(`<key>CFBundleIconFile</key><string>${APP_ICON_FILE}</string>`));
  // 图标源是 git 追踪的主应用图标；builder preflight 缺失即失败，这里守住同一合同。
  const info = await stat(APP_ICON_SOURCE);
  assert.equal(info.isFile(), true);
  const magic = (await readFile(APP_ICON_SOURCE)).subarray(0, 4).toString("latin1");
  assert.equal(magic, "icns");
});
