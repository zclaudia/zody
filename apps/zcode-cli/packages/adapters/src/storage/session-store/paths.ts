import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ZCODE_DATA_ROOT_DIR_NAME } from "@zcode/shared";
import { maybeThrowStorageFsFault } from "../fs-fault-injection.js";

export function getDefaultSessionDbPath(): string {
  // fork 数据隔离：家目录级数据根改为 .zcoder，避免与正式版 ZCode 共用。
  return join(homedir(), ZCODE_DATA_ROOT_DIR_NAME, "cli", "db", "db.sqlite");
}

export function ensureParentDir(filePath: string): void {
  const parent = dirname(filePath);
  if (!existsSync(parent)) {
    maybeThrowStorageFsFault({ operation: "mkdir", path: parent });
    mkdirSync(parent, { recursive: true });
  }
}
