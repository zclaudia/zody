import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractAppAsar, packAppAsar } from "../scripts/lib/normal-host-candidate-asar.mjs";
import { writeNormalHostBuildEvidence } from "../scripts/lib/normal-host-candidate-evidence.mjs";
import { copyNormalHostAppBundle } from "../scripts/lib/normal-host-candidate-app-copy.mjs";

const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zody-normal-host-asar-"));
  createdRoots.push(root);
  return root;
}

describe("normal Host candidate asar assembly", () => {
  it("uses copy-on-write for app copies and retries without it when unsupported", async () => {
    const root = createRoot();
    const calls: Array<Record<string, unknown>> = [];
    const cpImpl = async (
      _source: string,
      _destination: string,
      options: Record<string, unknown>,
    ) => {
      calls.push(options);
      if (calls.length === 1) {
        throw Object.assign(new Error("clone unsupported"), { code: "ENOTSUP" });
      }
    };

    await copyNormalHostAppBundle(join(root, "source.app"), join(root, "copy.app"), { cpImpl });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      recursive: true,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      mode: fsConstants.COPYFILE_FICLONE,
    });
    expect(calls[1]).not.toHaveProperty("mode");
  });

  it("round-trips app.asar and keeps native modules in app.asar.unpacked", async () => {
    const root = createRoot();
    const sourceDir = join(root, "app");
    mkdirSync(join(sourceDir, "out", "renderer"), { recursive: true });
    mkdirSync(join(sourceDir, "node_modules", "node-pty", "prebuilds", "darwin-arm64"), {
      recursive: true,
    });
    mkdirSync(join(sourceDir, "node_modules", "ssh2", "lib", "protocol", "crypto"), {
      recursive: true,
    });
    writeFileSync(join(sourceDir, "package.json"), '{"main":"out/main/index.js"}\n');
    writeFileSync(join(sourceDir, "out", "renderer", "index.html"), "<html>normal host</html>\n");
    writeFileSync(
      join(sourceDir, "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper"),
      "native-helper",
    );
    writeFileSync(
      join(sourceDir, "node_modules", "ssh2", "lib", "protocol", "crypto", "sshcrypto.node"),
      "native-module",
    );

    const archivePath = join(root, "app.asar");
    const first = await packAppAsar({
      sourceDir,
      appAsarPath: archivePath,
      targetPlatformKey: "darwin-arm64",
    });
    expect(first.sha256).toBe(sha256(readFileSync(archivePath)));
    expect(
      existsSync(
        join(
          root,
          "app.asar.unpacked",
          "node_modules",
          "node-pty",
          "prebuilds",
          "darwin-arm64",
          "spawn-helper",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          root,
          "app.asar.unpacked",
          "node_modules",
          "ssh2",
          "lib",
          "protocol",
          "crypto",
          "sshcrypto.node",
        ),
      ),
    ).toBe(true);

    const extractedDir = join(root, "extracted");
    await extractAppAsar({ appAsarPath: archivePath, destinationDir: extractedDir });
    expect(readFileSync(join(extractedDir, "out", "renderer", "index.html"), "utf8")).toContain(
      "normal host",
    );
    expect(
      readFileSync(
        join(extractedDir, "node_modules", "ssh2", "lib", "protocol", "crypto", "sshcrypto.node"),
        "utf8",
      ),
    ).toBe("native-module");
  });

  it("reads app.asar entries through the API without writing into cwd", async () => {
    const root = createRoot();
    const sourceDir = join(root, "app");
    mkdirSync(join(sourceDir, "node_modules", "node-pty", "prebuilds", "darwin-arm64"), {
      recursive: true,
    });
    writeFileSync(join(sourceDir, "package.json"), '{"main":"out/main/index.js"}\n');
    writeFileSync(
      join(sourceDir, "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper"),
      "native-helper",
    );
    const archivePath = join(root, "app.asar");
    await packAppAsar({
      sourceDir,
      appAsarPath: archivePath,
      targetPlatformKey: "darwin-arm64",
    });

    const sentinelDir = join(root, "sentinel-cwd");
    mkdirSync(sentinelDir);
    writeFileSync(join(sentinelDir, "sentinel.txt"), "unchanged\n");
    const moduleUrl = new URL("../scripts/lib/normal-host-candidate-asar.mjs", import.meta.url)
      .href;
    const script = `
import { readAppAsarFile } from ${JSON.stringify(moduleUrl)};
const bytes = readAppAsarFile({
  appAsarPath: process.env.ZODY_TEST_ASAR_PATH,
  filePath: "package.json",
});
if (bytes.toString("utf8") !== '{"main":"out/main/index.js"}\\n') process.exit(2);
`;
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: sentinelDir,
      env: { ...process.env, ZODY_TEST_ASAR_PATH: archivePath },
      stdio: "pipe",
    });

    expect(readdirSync(sentinelDir)).toEqual(["sentinel.txt"]);
    expect(readFileSync(join(sentinelDir, "sentinel.txt"), "utf8")).toBe("unchanged\n");
  });
});

describe("normal Host candidate build evidence", () => {
  function metafileFor(inputPath: string) {
    return {
      inputs: { [inputPath]: { bytes: 1, imports: [] } },
      outputs: {},
    };
  }

  function metafileWithInputs(inputPaths: string[]) {
    return {
      inputs: Object.fromEntries(
        inputPaths.map((inputPath) => [inputPath, { bytes: 1, imports: [] }]),
      ),
      outputs: {},
    };
  }

  function buildsFor(inputs: {
    main: string;
    host: string;
    scheduler: string;
  }): Array<{ name: string; metafile: unknown; defines?: Record<string, string> }> {
    return [
      { name: "main", metafile: metafileFor(inputs.main) },
      { name: "host", metafile: metafileFor(inputs.host) },
      { name: "scheduler", metafile: metafileFor(inputs.scheduler) },
    ];
  }

  it("writes metafiles and hashes the actual repo-relative inputs", async () => {
    const root = createRoot();
    const evidenceDir = join(root, "build-evidence");
    const result = await writeNormalHostBuildEvidence({
      evidenceDir,
      builds: buildsFor({
        main: "src/main/index.ts",
        host: "src/host/index.ts",
        scheduler: "src/scheduler/index.ts",
      }),
    });

    expect(existsSync(result.inputsPath)).toBe(true);
    for (const name of ["main", "host", "scheduler"]) {
      expect(existsSync(join(evidenceDir, `${name}.metafile.json`))).toBe(true);
    }
    const index = JSON.parse(readFileSync(result.inputsPath, "utf8"));
    const repoRoot = join(import.meta.dirname, "../../..");
    const hostInput = index.inputs.find(
      (entry: { path: string }) => entry.path === "packages/desktop/src/host/index.ts",
    );
    expect(hostInput).toMatchObject({
      path: "packages/desktop/src/host/index.ts",
      buildPath: join(repoRoot, "packages/desktop/src/host/index.ts"),
      sha256: sha256(readFileSync(join(repoRoot, "packages/desktop/src/host/index.ts"))),
      builds: ["host"],
    });
    expect(index.builds.main.metafileSha256).toBe(
      sha256(readFileSync(join(evidenceDir, "main.metafile.json"))),
    );
    expect(result.builds.host.inputs.map((entry: { path: string }) => entry.path)).toEqual([
      "packages/desktop/src/host/index.ts",
    ]);
  });

  it("rejects workspace dist inputs instead of labeling them source-rebuilt", async () => {
    const root = createRoot();
    await expect(
      writeNormalHostBuildEvidence({
        evidenceDir: join(root, "build-evidence"),
        builds: buildsFor({
          main: "src/main/index.ts",
          host: "../../packages/shared/dist/index.js",
          scheduler: "src/scheduler/index.ts",
        }),
      }),
    ).rejects.toMatchObject({ code: "candidate-stale-workspace-dist" });
  });

  it("records generated esbuild define inputs without reading files or dumping expressions", async () => {
    const root = createRoot();
    const evidenceDir = join(root, "build-evidence");
    const defineName = "__ZODY_PACKAGED_AGENT_TELEMETRY_ENV__";
    const expression = JSON.stringify({ token: "must-not-be-archived" });
    const builds = buildsFor({
      main: "src/main/index.ts",
      host: "src/host/index.ts",
      scheduler: "src/scheduler/index.ts",
    });
    builds[0] = {
      ...builds[0],
      metafile: metafileWithInputs(["src/main/index.ts", `<define:${defineName}>`]),
      defines: { [defineName]: expression },
    };

    const result = await writeNormalHostBuildEvidence({ evidenceDir, builds });
    const index = JSON.parse(readFileSync(result.inputsPath, "utf8"));
    const virtualInput = index.inputs.find(
      (entry: { path: string }) => entry.path === `<define:${defineName}>`,
    );
    expect(virtualInput).toMatchObject({
      path: `<define:${defineName}>`,
      kind: "esbuild-define",
      name: defineName,
      bytes: Buffer.byteLength(expression, "utf8"),
      sha256: sha256(expression),
      builds: ["main"],
    });
    expect(virtualInput).not.toHaveProperty("buildPath");
    expect(readFileSync(result.inputsPath, "utf8")).not.toContain("must-not-be-archived");
    expect(readFileSync(join(evidenceDir, "main.metafile.json"), "utf8")).not.toContain(
      "must-not-be-archived",
    );
  });

  it("rejects generated define inputs without an exact supplied expression", async () => {
    const root = createRoot();
    const defineName = "__ZODY_PACKAGED_AGENT_TELEMETRY_ENV__";
    const builds = buildsFor({
      main: "src/main/index.ts",
      host: "src/host/index.ts",
      scheduler: "src/scheduler/index.ts",
    });
    builds[0] = {
      ...builds[0],
      metafile: metafileWithInputs(["src/main/index.ts", `<define:${defineName}>`]),
      defines: {},
    };

    await expect(
      writeNormalHostBuildEvidence({ evidenceDir: join(root, "build-evidence"), builds }),
    ).rejects.toMatchObject({ code: "candidate-evidence-unresolved-define" });
  });

  it("rejects unknown virtual inputs instead of treating them as files", async () => {
    const root = createRoot();
    const builds = buildsFor({
      main: "src/main/index.ts",
      host: "src/host/index.ts",
      scheduler: "src/scheduler/index.ts",
    });
    builds[0] = {
      ...builds[0],
      metafile: metafileWithInputs(["src/main/index.ts", "<virtual:unknown>"]),
      defines: {},
    };

    await expect(
      writeNormalHostBuildEvidence({ evidenceDir: join(root, "build-evidence"), builds }),
    ).rejects.toMatchObject({ code: "candidate-evidence-unknown-virtual-input" });
  });
});
