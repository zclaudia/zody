import { describe, expect, it } from "vitest";
import {
  REMOTE_CONNECTION_CREATION_ENABLED,
  shouldShowRemoteConnectionEntry,
} from "../src/hooks/useRemoteConnectionEntryVisibility.js";

// fork（F6.1，D4a 方案 ii）：打包版官方 CDN 不含 fork 版本的远端运行时资源，
// 新建/部署远程工作区会失败，因此入口可见性固定为 false。
// 已有远程工作区的恢复与重连由 useRemoteWorkspaceHistory 独立判定，不受本开关影响。
describe("shouldShowRemoteConnectionEntry", () => {
  it("F6.1 起所有环境都隐藏新建远程工作区入口", () => {
    expect(REMOTE_CONNECTION_CREATION_ENABLED).toBe(false);
    expect(
      shouldShowRemoteConnectionEntry({
        env: "test",
        isIntranet: false,
      }),
    ).toBe(false);
  });

  it("生产态命中内网时也保持隐藏", () => {
    expect(
      shouldShowRemoteConnectionEntry({
        env: "production",
        isIntranet: true,
      }),
    ).toBe(false);
  });

  it("生产态且非内网时保持隐藏", () => {
    expect(
      shouldShowRemoteConnectionEntry({
        env: "production",
        isIntranet: false,
      }),
    ).toBe(false);
  });
});
