import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const originalElectron = Object.getOwnPropertyDescriptor(process.versions, "electron");
const originalResources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
const originalCommand = process.env.ZODY_AGENT_SERVER_COMMAND;
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  if (originalElectron) Object.defineProperty(process.versions, "electron", originalElectron);
  else delete process.versions.electron;
  if (originalResources) Object.defineProperty(process, "resourcesPath", originalResources);
  else delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (originalCommand === undefined) delete process.env.ZODY_AGENT_SERVER_COMMAND;
  else process.env.ZODY_AGENT_SERVER_COMMAND = originalCommand;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

it("uses packaged Electron CLI for storage even when cwd contains unbuilt development source", async () => {
  const root = mkdtempSync(join(tmpdir(), "zody-packaged-cwd-"));
  roots.push(root);
  const resources = join(root, "App.app/Contents/Resources");
  const bundle = join(resources, "glm/zody.cjs");
  const source = join(root, "repo/apps/zody-cli/packages/cli/src/main.ts");
  const tsx = join(root, "repo/node_modules/.bin/tsx");
  for (const path of [bundle, source, tsx]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "// controlled fixture\n");
  }
  Object.defineProperty(process.versions, "electron", {
    configurable: true,
    value: "41.0.3",
  });
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: resources,
  });
  delete process.env.ZODY_AGENT_SERVER_COMMAND;
  vi.spyOn(process, "cwd").mockReturnValue(join(root, "repo"));
  vi.resetModules();
  const { resolveDefaultZodyAgentCommand } =
    await import("../src/zody-agent/zodyAgentProcessManager.js");
  const command = resolveDefaultZodyAgentCommand({
    workspacePath: root,
    workspaceKey: root,
  });
  expect(command?.command).toBe(process.execPath);
  expect(command?.args?.[0]).toBe(bundle);
  expect(command?.storagePreparationEntry).toBe(bundle);
  expect(command?.supportsStorageStartup).toBe(true);
});

it("keeps development source ahead of staged bundles when packaged Electron CLI is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "zody-electron-dev-"));
  roots.push(root);
  const repo = join(root, "repo");
  const source = join(repo, "apps/zody-cli/packages/cli/src/main.ts");
  const tsx = join(repo, "node_modules/.bin/tsx");
  const staged = join(
    repo,
    "bundled-agents",
    `${process.platform}-${process.arch}`,
    "glm/zody.cjs",
  );
  for (const path of [source, tsx, staged]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "// controlled fixture\n");
  }
  Object.defineProperty(process.versions, "electron", {
    configurable: true,
    value: "41.0.3",
  });
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: join(root, "missing-resources"),
  });
  delete process.env.ZODY_AGENT_SERVER_COMMAND;
  vi.spyOn(process, "cwd").mockReturnValue(repo);
  vi.resetModules();
  const { resolveDefaultZodyAgentCommand } =
    await import("../src/zody-agent/zodyAgentProcessManager.js");
  const command = resolveDefaultZodyAgentCommand({
    workspacePath: root,
    workspaceKey: root,
  });
  expect(command?.command).toBe(tsx);
  expect(command?.args?.[0]).toBe(source);
});
