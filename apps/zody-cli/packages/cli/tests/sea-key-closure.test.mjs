import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { readNativeSearchNotices } from "../../../../../scripts/third-party-notices.mjs";
import { hostTarget } from "../scripts/sea-targets.mjs";
import { collectSeaTuiAssets } from "../scripts/sea-tui-assets.mjs";
import { collectSeaPlaywrightAssets } from "../scripts/sea-playwright-assets.mjs";
import { collectSeaRuntimeToolAssets } from "../scripts/sea-runtime-tool-assets.mjs";
import { collectSeaBundledSkillAssets } from "../scripts/sea-bundled-skill-assets.mjs";
import { collectSeaOfficialPluginAssets } from "../scripts/sea-official-plugin-assets.mjs";

const cliRoot = resolve(import.meta.dirname, "../../..");
const repoRoot = resolve(cliRoot, "../..");
const source = (path) => pathToFileURL(join(cliRoot, "packages", path)).href;
const cases = [
  ["tui", "tui-runtime", "cli/src/tui-runtime-loader.ts"],
  ["playwright", "playwright-runtime", "cli/src/sea-playwright-runtime.ts"],
  ["tools", "runtime-tools", "cli/src/sea-runtime-tools.ts"],
  ["skills", "bundled-skills", "bootstrap/src/app/bundled-skills.ts"],
  ["plugins", "official-plugins", "bootstrap/src/app/bundled-plugins.ts"],
];

const consumer = `
  import assert from "node:assert/strict";
  import { createRequire, syncBuiltinESMExports } from "node:module";
  import { readFileSync, existsSync, statSync, rmSync } from "node:fs";
  import { join } from "node:path";
  const [payloadPath, moduleUrl, kind, home] = process.argv.slice(1);
  const { assets, manifest, prefix } = JSON.parse(readFileSync(payloadPath, "utf8"));
  let rawReads = 0; const missing = [];
  const bytes = (key) => { if (!(key in assets)) { missing.push(key); throw new Error("missing SEA key " + key); } return readFileSync(assets[key]); };
  const sea = createRequire(import.meta.url)("node:sea");
  sea.isSea = () => true;
  sea.getAsset = (key) => bytes(key).toString("utf8");
  sea.getRawAsset = (key) => { rawReads++; return Uint8Array.from(bytes(key)).buffer; };
  syncBuiltinESMExports();
  const originalBuiltin = process.getBuiltinModule;
  process.getBuiltinModule = (name) => name === "node:sea" ? sea : originalBuiltin(name);
  globalThis.__CLI_VERSION__ = "fixture";
  const mod = await import(moduleUrl);
  let run; let pluginFile;
  if (kind === "tui") run = async () => assert.equal(typeof (await mod.loadTuiRuntime()).runTui, "function");
  if (kind === "playwright") run = async () => assert.ok((await mod.loadCliPlaywrightChromium()).chromium);
  if (kind === "tools") run = async () => { const vars = await mod.ensureSeaRuntimeTools({ sea, storageRoot: join(home, "storage"), platform: process.platform, arch: process.arch, env: {} }); assert.ok(Object.keys(vars).length); for (const value of Object.values(vars)) assert.ok(existsSync(value)); };
  if (kind === "skills") run = async () => { const roots = mod.resolveBundledSkillRoots({ cliStorageRoot: join(home, "storage") }); assert.equal(roots.length, 1); assert.ok(roots[0].path.startsWith(join(home, "storage"))); assert.ok(existsSync(join(roots[0].path, "dynamic-workflows", "SKILL.md"))); };
  if (kind === "plugins") run = async () => { mod.resolveOfficialPluginRoots({ storageRoot: join(home, "storage"), env: {} }); const plugin = manifest.plugins.find(p => p.name === "visualize"); assert.ok(plugin); pluginFile = join(home, "storage", "cache", plugin.marketplace, plugin.name, plugin.version, ".zcode-plugin", "plugin.json"); assert.ok(existsSync(pluginFile)); };
  const manifestKey = prefix + "manifest.json"; const manifestFile = assets[manifestKey]; delete assets[manifestKey];
  try { await run(); } catch {} // Consumers differ in their documented missing-manifest behavior.
  assert.ok(missing.includes(manifestKey), "missing manifest key must be observed even when fallback is allowed");
  rmSync(join(home, "storage"), { recursive: true, force: true }); assets[manifestKey] = manifestFile; missing.length = 0; rawReads = 0;
  await run(); assert.deepEqual(missing, []); assert.ok(rawReads > 0, "must extract collector assets");
  if (kind === "playwright") {
    const base = process.platform === "darwin" ? join(home, "Library", "Caches", "zody", "sea-assets") : process.platform === "win32" ? join(home, "zody", "Cache", "sea-assets") : join(home, "zody", "sea-assets");
    const runtime = join(base, "fixture", manifest.target, \`playwright-\${manifest.packageVersion}-\${manifest.hash}\`);
    assert.equal(createRequire(join(runtime, "zcode-playwright-loader.cjs")).resolve("playwright-core"), createRequire(join(runtime, "zody-playwright-loader.cjs")).resolve("playwright-core"));
  }
  const first = rawReads; const firstInode = pluginFile && statSync(pluginFile).ino; await run(); assert.deepEqual(missing, []); if (kind === "plugins") assert.equal(statSync(pluginFile).ino, firstInode, "complete plugin cache must be reused"); else assert.equal(rawReads, first, "unchanged cache must be reused");
`;

for (const [kind, suffix, modulePath] of cases) {
  test(`SEA ${kind} collector assets are consumed with the new exact keys and reused`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `zody-sea-closure-${kind}-`));
    try {
      const target = hostTarget();
      const stage = join(directory, "stage");
      let result;
      if (kind === "tui")
        result = await collectSeaTuiAssets({ root: cliRoot, stagingDirectory: stage, target });
      if (kind === "playwright")
        result = await collectSeaPlaywrightAssets({
          root: cliRoot,
          stagingDirectory: stage,
          target,
        });
      if (kind === "skills")
        result = await collectSeaBundledSkillAssets({ root: cliRoot, stagingDirectory: stage });
      if (kind === "plugins")
        result = await collectSeaOfficialPluginAssets({ root: cliRoot, stagingDirectory: stage });
      if (kind === "tools") {
        const root = join(directory, "tool-root");
        const platformKey = `${process.platform}-${process.arch}`;
        for (const [id, binary] of [
          ["bfs", "bfs"],
          ["ripgrep", "rg"],
          ["ugrep", "ugrep"],
        ]) {
          const file = join(
            root,
            "packages/desktop/bundled-tools",
            platformKey,
            id,
            `${binary}${process.platform === "win32" ? ".exe" : ""}`,
          );
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, `fixture-${id}`);
        }
        await cp(
          join(repoRoot, "third-party/native-search"),
          join(root, "third-party/native-search"),
          { recursive: true },
        );
        result = await collectSeaRuntimeToolAssets({ root, stagingDirectory: stage, target });
      }
      const prefix = `zody-${suffix}/`;
      const payload = join(directory, "payload.json");
      await writeFile(
        payload,
        JSON.stringify({ assets: result.assets, manifest: result.manifest, prefix }),
      );
      await promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          consumer,
          payload,
          source(modulePath),
          kind,
          directory,
        ],
        {
          cwd: join(cliRoot, "packages/cli"),
          env: {
            ...process.env,
            HOME: directory,
            USERPROFILE: directory,
            XDG_CACHE_HOME: directory,
            LOCALAPPDATA: directory,
          },
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      if (kind === "tools") {
        assert.deepEqual(
          await readFile(result.assets[`${prefix}THIRD-PARTY-NOTICES.txt`]),
          (await readNativeSearchNotices(repoRoot)).bytes,
        );
        assert.deepEqual(
          await readFile(result.assets[`${prefix}SOURCES.json`]),
          await readFile(join(repoRoot, "third-party/native-search/sources.json")),
        );
      }
      assert.ok(
        result.assets[`${prefix}manifest.json`],
        "collector must publish approved manifest key",
      );
      assert.ok(
        Object.keys(result.assets).every((key) => key.startsWith(prefix)),
        "all collector asset keys use approved prefix",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
