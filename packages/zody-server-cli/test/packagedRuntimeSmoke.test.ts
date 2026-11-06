import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const packageRequire = createRequire(join(packageRoot, "package.json"));

function isolatedEnv(home: string, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    TMPDIR: home,
    TEMP: home,
    TMP: home,
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home,
    XDG_DATA_HOME: home,
    PATH: source.PATH ?? "",
    ZODY_ENV: "production",
  };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}
const nodeBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

function inspectDynamicRequires(text: string) {
  const source = ts.createSourceFile(
    "bundle.js",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const bridgeImport = source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "node:module" &&
      statement.importClause?.namedBindings
        ?.getText(source)
        .includes("createRequire as __zodyCreateRequire"),
  );
  const targets: string[] = [];
  const unexpected: string[] = [];
  let bridgeDeclarations = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "require") {
      const parent = node.parent;
      if (ts.isVariableDeclaration(parent) && parent.name === node) {
        bridgeDeclarations++;
        if (parent.initializer?.getText(source) !== "__zodyCreateRequire(import.meta.url)")
          unexpected.push(parent.getText(source));
      } else {
        let ancestor: ts.Node | undefined = parent;
        while (ancestor && !ts.isVariableDeclaration(ancestor)) ancestor = ancestor.parent;
        if (!ancestor || !ts.isIdentifier(ancestor.name) || ancestor.name.text !== "__require")
          unexpected.push(parent.getText(source));
      }
    }
    if (ts.isIdentifier(node) && node.text === "__require") {
      const parent = node.parent;
      if (ts.isVariableDeclaration(parent) && parent.name === node) {
        // esbuild 的帮助器声明本身不是加载调用。
      } else if (
        ts.isCallExpression(parent) &&
        parent.expression === node &&
        parent.arguments.length === 1 &&
        ts.isStringLiteral(parent.arguments[0])
      ) {
        targets.push(parent.arguments[0].text);
      } else {
        unexpected.push(parent.getText(source));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return {
    bridgeImport,
    bridgeDeclarations,
    targets,
    unexpected,
    nonBuiltin: targets.filter((name) => !nodeBuiltins.has(name)),
  };
}

async function runEntry(file: string, home: string) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolvePromise, reject) => {
      const child = spawn(process.execPath, [file, "--version"], {
        cwd: home,
        env: isolatedEnv(home, process.env),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolvePromise({ code, stdout, stderr });
      });
    },
  );
}

describe("independent server production ESM bundles", () => {
  let temp = "";
  let bundle = "";
  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "zody-server-bundle-"));
    bundle = join(temp, "dist");
    // 单元验证只借用已安装依赖；发行 smoke 另在不回落仓库的目录核验完整闭包。
    await symlink(
      resolve(packageRoot, "../../node_modules"),
      join(temp, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const tsupManifestPath = packageRequire.resolve("tsup/package.json");
    const tsupManifest = JSON.parse(await readFile(tsupManifestPath, "utf8")) as {
      bin: Record<string, string>;
    };
    const tsupBin = resolve(dirname(tsupManifestPath), tsupManifest.bin.tsup);
    // 修复原因：真实 tsup 两入口隔离输出和环境，避免旧 dist、用户配置与并发写入干扰。
    await execFileAsync(process.execPath, [tsupBin, "--out-dir", bundle], {
      cwd: packageRoot,
      env: isolatedEnv(temp, process.env),
    });
  }, 120_000);
  afterAll(async () => {
    if (temp) await rm(temp, { force: true, recursive: true });
  });

  it("does not inherit provider or secret overrides into the build environment", () => {
    const env = isolatedEnv(temp, {
      PATH: "/controlled/bin",
      ZODY_ENV: "test",
      ZODY_BUILTIN_PROVIDER_CONFIG_FILE: "/user/provider.json",
      OPENAI_API_KEY: "not-a-real-key",
      SystemRoot: "C:\\Windows",
    });
    expect(env.ZODY_ENV).toBe("production");
    expect(env.ZODY_BUILTIN_PROVIDER_CONFIG_FILE).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.HOME).toBe(temp);
    expect(env.SystemRoot).toBe("C:\\Windows");
  });

  for (const entry of ["server-cli.js", "server-core.js"]) {
    it(`${entry} has only explicit builtin dynamic require targets`, async () => {
      const source = await readFile(join(bundle, entry), "utf8");
      const inspected = inspectDynamicRequires(source);
      expect(inspected.bridgeImport).toBe(true);
      expect(inspected.bridgeDeclarations).toBe(1);
      expect(inspected.targets.length).toBeGreaterThan(0);
      expect(inspected.unexpected).toEqual([]);
      expect(inspected.nonBuiltin).toEqual([]);
    });
  }

  it("rejects unknown, computed and aliased dynamic require targets", async () => {
    const source = await readFile(join(bundle, "server-cli.js"), "utf8");
    expect(source).toContain('__require("fs")');
    expect(
      inspectDynamicRequires(source.replace('__require("fs")', '__require("not-a-node-builtin")'))
        .nonBuiltin,
    ).toEqual(["not-a-node-builtin"]);
    expect(
      inspectDynamicRequires(
        source.replace('__require("fs")', "__require(globalThis.unknownTarget)"),
      ).unexpected,
    ).not.toEqual([]);
    expect(
      inspectDynamicRequires(source + "\nconst escaped = __require;\n").unexpected,
    ).not.toEqual([]);
  });

  it("initializes the real CLI before command delegation", async () => {
    const result = await runEntry(join(bundle, "server-cli.js"), temp);
    expect(result.stderr).not.toContain('Dynamic require of "fs" is not supported');
    expect(result.stderr).not.toContain("ReferenceError: require is not defined");
    // 测试输出目录仅有 bundle；已抵达未 staging 时的命令委派分支。
    expect(result.stdout).toContain("Unknown command: --version");
    expect(result.code).toBe(1);
  });
});
