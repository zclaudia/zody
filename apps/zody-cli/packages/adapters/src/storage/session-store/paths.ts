import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ZODY_DATA_ROOT_DIR_NAME } from "@zody/shared";
import { maybeThrowStorageFsFault } from "../fs-fault-injection.js";

export function getDefaultSessionDbPath(): string {
  // fork 数据隔离：家目录级数据根改为 .zody，避免与正式版 ZCode 共用。
  return join(homedir(), ZODY_DATA_ROOT_DIR_NAME, "cli", "db", "db.sqlite");
}

export function ensureParentDir(filePath: string): void {
  const parent = dirname(filePath);
  if (!existsSync(parent)) {
    maybeThrowStorageFsFault({ operation: "mkdir", path: parent });
    mkdirSync(parent, { recursive: true });
  }
}
