import { access, constants } from "node:fs";
import { chmod, copyFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { D06Round5Observation } from "./d06-round5-policy.js";
import {
  runBoundedCommand,
  sha256File,
  type BoundedCommandResult,
  type D06Round5Paths,
} from "./d06-round5-resources.js";

const accessAsync = promisify(access);
const CLANG_PATH = "/usr/bin/clang";
const COMPILE_TIMEOUT_MS = 30_000;

export const D06_NATIVE_C_SOURCE = String.raw`
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static void d06_json(napi_env env, napi_value *result, const char *text) {
  napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, result);
}

static napi_value d06_read_path(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  char path[4096];
  size_t length = 0;
  napi_value result;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1 || napi_get_value_string_utf8(env, argv[0], path, sizeof(path), &length) != napi_ok) {
    d06_json(env, &result, "{\"ok\":false,\"errno\":22}");
    return result;
  }
  int fd = open(path, O_RDONLY);
  if (fd < 0) {
    char buffer[64];
    snprintf(buffer, sizeof(buffer), "{\"ok\":false,\"errno\":%d}", errno);
    d06_json(env, &result, buffer);
    return result;
  }
  char data[65];
  ssize_t count = read(fd, data, 64);
  int read_errno = errno;
  close(fd);
  if (count < 0) {
    char buffer[64];
    snprintf(buffer, sizeof(buffer), "{\"ok\":false,\"errno\":%d}", read_errno);
    d06_json(env, &result, buffer);
    return result;
  }
  data[count] = 0;
  for (ssize_t index = 0; index < count; index += 1) {
    unsigned char value = (unsigned char)data[index];
    if (value < 32 || value > 126) data[index] = '?';
  }
  char buffer[256];
  snprintf(buffer, sizeof(buffer), "{\"ok\":true,\"bytes\":%ld,\"data\":\"%s\"}", (long)count, data);
  d06_json(env, &result, buffer);
  return result;
}

static napi_value d06_write_path(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  char path[4096];
  char data[4096];
  size_t path_length = 0;
  size_t data_length = 0;
  napi_value result;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2 ||
      napi_get_value_string_utf8(env, argv[0], path, sizeof(path), &path_length) != napi_ok ||
      napi_get_value_string_utf8(env, argv[1], data, sizeof(data), &data_length) != napi_ok) {
    d06_json(env, &result, "{\"ok\":false,\"errno\":22}");
    return result;
  }
  int fd = open(path, O_WRONLY | O_TRUNC);
  if (fd < 0) {
    char buffer[64];
    snprintf(buffer, sizeof(buffer), "{\"ok\":false,\"errno\":%d}", errno);
    d06_json(env, &result, buffer);
    return result;
  }
  ssize_t count = write(fd, data, data_length);
  int write_errno = errno;
  close(fd);
  if (count < 0) {
    char buffer[64];
    snprintf(buffer, sizeof(buffer), "{\"ok\":false,\"errno\":%d}", write_errno);
    d06_json(env, &result, buffer);
    return result;
  }
  char buffer[64];
  snprintf(buffer, sizeof(buffer), "{\"ok\":true,\"bytes\":%ld}", (long)count);
  d06_json(env, &result, buffer);
  return result;
}

static napi_value d06_spawn_true(napi_env env, napi_callback_info info) {
  napi_value result;
  char *argv[] = {"/usr/bin/true", NULL};
  pid_t pid;
  int status = 0;
  int spawned = posix_spawn(&pid, "/usr/bin/true", NULL, NULL, argv, environ);
  if (spawned != 0) {
    char buffer[64];
    snprintf(buffer, sizeof(buffer), "{\"ok\":false,\"errno\":%d,\"stage\":\"spawn\"}", spawned);
    d06_json(env, &result, buffer);
    return result;
  }
  if (waitpid(pid, &status, 0) < 0) {
    char buffer[64];
    snprintf(buffer, sizeof(buffer), "{\"ok\":false,\"errno\":%d,\"stage\":\"wait\"}", errno);
    d06_json(env, &result, buffer);
    return result;
  }
  int exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
  char buffer[80];
  snprintf(buffer, sizeof(buffer), "{\"ok\":%s,\"status\":%d}", exit_code == 0 ? "true" : "false", exit_code);
  d06_json(env, &result, buffer);
  return result;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "readPath", NAPI_AUTO_LENGTH, d06_read_path, NULL, &fn);
  napi_set_named_property(env, exports, "readPath", fn);
  napi_create_function(env, "writePath", NAPI_AUTO_LENGTH, d06_write_path, NULL, &fn);
  napi_set_named_property(env, exports, "writePath", fn);
  napi_create_function(env, "spawnTrue", NAPI_AUTO_LENGTH, d06_spawn_true, NULL, &fn);
  napi_set_named_property(env, exports, "spawnTrue", fn);
  return exports;
}
`;

export interface D06NativeBuildResult {
  status: "compiled" | "failed" | "blocked";
  observation: D06Round5Observation;
  command: string[];
  includeHeader?: string;
  addon?: { path: string; sha256: string; bytes: number };
  compile?: BoundedCommandResult;
}

export async function buildNativeProbe(input: {
  paths: D06Round5Paths;
  nodePath: string;
  clangPath?: string;
}): Promise<D06NativeBuildResult> {
  const clangPath = input.clangPath ?? CLANG_PATH;
  const includeHeader = resolve(dirname(input.nodePath), "..", "include", "node", "node_api.h");
  const command = [
    clangPath,
    "-dynamiclib",
    "-undefined",
    "dynamic_lookup",
    "-I",
    dirname(includeHeader),
    "-o",
    input.paths.nativeAddonPath,
    input.paths.nativeSourcePath,
  ];
  await mkdir(dirname(input.paths.nativeSourcePath), { recursive: true });
  await writeFile(input.paths.nativeSourcePath, D06_NATIVE_C_SOURCE, "utf8");
  try {
    await accessAsync(includeHeader, constants.R_OK);
  } catch {
    return {
      status: "blocked",
      observation: {
        outcome: "blocked",
        stage: "not-loaded",
        code: "ENOENT",
        detail: `node_api.h missing at ${includeHeader}`,
      },
      command,
      includeHeader,
    };
  }
  try {
    await accessAsync(clangPath, constants.X_OK);
  } catch {
    return {
      status: "blocked",
      observation: {
        outcome: "blocked",
        stage: "not-loaded",
        code: "ENOENT",
        detail: `clang unavailable at ${clangPath}`,
      },
      command,
      includeHeader,
    };
  }
  const compile = await runBoundedCommand(clangPath, command.slice(1), {
    cwd: input.paths.root,
    env: {
      PATH: dirname(input.nodePath),
      HOME: input.paths.root,
      TMPDIR: input.paths.root,
      LANG: "C",
    },
    timeoutMs: COMPILE_TIMEOUT_MS,
  });
  if (compile.spawnError) {
    return {
      status: "blocked",
      observation: {
        outcome: "blocked",
        stage: "not-loaded",
        detail: `clang spawn failed: ${compile.spawnError}`,
      },
      command,
      includeHeader,
      compile,
    };
  }
  if (compile.timedOut || compile.exitCode !== 0) {
    return {
      status: "failed",
      observation: {
        outcome: "error",
        stage: "not-loaded",
        code: compile.timedOut ? "ETIMEDOUT" : `EXIT_${compile.exitCode ?? "null"}`,
        detail: compile.stderr || "native probe compilation failed",
      },
      command,
      includeHeader,
      compile,
    };
  }
  const addon = await sha256File(input.paths.nativeAddonPath);
  return {
    status: "compiled",
    observation: {
      outcome: "allowed",
      stage: "compiled",
      checks: { "native include exists": true, "clang executed": true, "addon compiled": true },
    },
    command,
    includeHeader,
    addon: { path: input.paths.nativeAddonPath, ...addon },
    compile,
  };
}

export interface KoffiSource {
  indexPath: string;
  nativePath: string;
  triplet: string;
  indexSha256: string;
  nativeSha256: string;
}

export interface KoffiStaged {
  indexPath: string;
  nativePath: string;
  indexSha256: string;
  nativeSha256: string;
}

export function discoverKoffi(
  repoRoot: string,
): { indexPath: string; nativePath: string; triplet: string } | null {
  const root = resolve(repoRoot, "node_modules", "koffi");
  const triplet = koffiTriplet(process.platform, process.arch);
  if (!triplet) return null;
  return {
    indexPath: resolve(root, "index.js"),
    nativePath: resolve(root, "build", "koffi", triplet, "koffi.node"),
    triplet,
  };
}

export async function resolveKoffiSource(repoRoot: string): Promise<KoffiSource | null> {
  const found = discoverKoffi(repoRoot);
  if (!found) return null;
  try {
    const [indexPath, nativePath] = await Promise.all([
      realpath(found.indexPath),
      realpath(found.nativePath),
    ]);
    const [index, native] = await Promise.all([sha256File(indexPath), sha256File(nativePath)]);
    return {
      indexPath,
      nativePath,
      triplet: found.triplet,
      indexSha256: index.sha256,
      nativeSha256: native.sha256,
    };
  } catch {
    return null;
  }
}

export async function stageKoffi(paths: D06Round5Paths, source: KoffiSource): Promise<KoffiStaged> {
  const stageRoot = join(paths.round5Dir, "koffi-staged");
  const indexPath = join(stageRoot, "index.js");
  const nativePath = join(stageRoot, "build", "koffi", source.triplet, "koffi.node");
  await Promise.all([
    mkdir(dirname(indexPath), { recursive: true }),
    mkdir(dirname(nativePath), { recursive: true }),
  ]);
  await Promise.all([
    copyFile(source.indexPath, indexPath),
    copyFile(source.nativePath, nativePath),
  ]);
  await Promise.all([chmod(indexPath, 0o444), chmod(nativePath, 0o444)]);
  const [index, native] = await Promise.all([sha256File(indexPath), sha256File(nativePath)]);
  return {
    indexPath,
    nativePath,
    indexSha256: index.sha256,
    nativeSha256: native.sha256,
  };
}

function koffiTriplet(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === "darwin") return arch === "arm64" ? "darwin_arm64" : "darwin_x64";
  if (platform === "linux") return arch === "arm64" ? "linux_arm64" : "linux_x64";
  if (platform === "win32") return arch === "arm64" ? "win32_arm64" : "win32_x64";
  return null;
}
