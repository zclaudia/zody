import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ZodyStdioTapDevState } from "@zody/shared";
import { getAppConfigDir } from "#src/paths.js";
import { isEffectiveDevelopmentNodeEnv } from "#src/runtime-tools/nodeEnv.js";

interface ZodyStdioTapStateFile {
  enabled?: boolean;
}

export function isZodyStdioTapDevVisible(): boolean {
  return isEffectiveDevelopmentNodeEnv();
}

export function getZodyStdioTapDevDir(): string {
  return join(getAppConfigDir(), "dev");
}

export function getZodyStdioTapDevLogDir(): string {
  return join(getZodyStdioTapDevDir(), "stdio-traffic");
}

export function getZodyStdioTapDevStatePath(): string {
  return join(getZodyStdioTapDevDir(), "zody-stdio-tap.json");
}

function readStateFile(path: string): ZodyStdioTapStateFile {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ZodyStdioTapStateFile) : {};
  } catch {
    return {};
  }
}

export function readZodyStdioTapDevState(): ZodyStdioTapDevState {
  const visible = isZodyStdioTapDevVisible();
  const statePath = getZodyStdioTapDevStatePath();
  const fileState = readStateFile(statePath);
  return {
    enabled: visible && fileState.enabled === true,
    visible,
    logDir: getZodyStdioTapDevLogDir(),
    statePath,
  };
}

export function setZodyStdioTapDevEnabled(enabled: boolean): ZodyStdioTapDevState {
  const visible = isZodyStdioTapDevVisible();
  const statePath = getZodyStdioTapDevStatePath();
  mkdirSync(getZodyStdioTapDevDir(), { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        // 开发态 stdio 抓包是高频原始协议帧，只能通过显式开关写旁路文件，避免误进生产日志。
        enabled: visible && enabled,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return readZodyStdioTapDevState();
}
