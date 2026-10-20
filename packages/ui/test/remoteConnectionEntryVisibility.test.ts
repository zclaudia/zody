import { describe, expect, it } from "vitest";
import {
  REMOTE_CONNECTION_CREATION_ENABLED,
  shouldShowRemoteConnectionEntry,
} from "../src/hooks/useRemoteConnectionEntryVisibility.js";

describe("shouldShowRemoteConnectionEntry", () => {
  it.each(["test", "production"] as const)("%s 恢复 SSH/WSL 入口，不依赖内网判断", (env) => {
    expect(REMOTE_CONNECTION_CREATION_ENABLED).toBe(true);
    for (const isIntranet of [true, false])
      expect(shouldShowRemoteConnectionEntry({ env, isIntranet })).toBe(true);
  });
});
