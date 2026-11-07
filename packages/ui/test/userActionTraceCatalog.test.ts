import { describe, expect, it } from "vitest";
import {
  CORE_USER_ACTION_FEATURES,
  SETTINGS_USER_ACTION_FEATURES,
  USER_ACTION_CATALOG,
} from "../src/lib/userActionTraceCatalog.js";

describe("user action trace catalog", () => {
  it("固定 25 个 Core 与 15 个 Settings 叶子 feature", () => {
    // fork（F23，上游 a60ba6a7）：conversation.blocking.mcp_trust（review/dismiss）
    // 加入 core 目录，24→25 feature、94→96 叶子。
    expect(Object.keys(CORE_USER_ACTION_FEATURES)).toHaveLength(25);
    expect(Object.keys(SETTINGS_USER_ACTION_FEATURES)).toHaveLength(15);
    expect(USER_ACTION_CATALOG.filter((entry) => entry.group === "core")).toHaveLength(96);
    expect(USER_ACTION_CATALOG.filter((entry) => entry.group === "settings")).toHaveLength(44);
  });

  it("feature/action 组合唯一且不使用动态标识", () => {
    const keys = USER_ACTION_CATALOG.map((entry) => `${entry.featureId}:${entry.action}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of USER_ACTION_CATALOG) {
      expect(entry.featureId).toMatch(/^[a-z]+(?:[._][a-z]+)+$/u);
      expect(entry.action).toMatch(/^[a-z]+(?:_[a-z]+)*$/u);
      expect(entry.featureId).not.toMatch(/taskId|workspacePath|pluginId/iu);
    }
  });

  it("不声明 /event/report sink", () => {
    for (const entry of USER_ACTION_CATALOG) {
      expect(entry).not.toHaveProperty("eventPolicy");
      expect(entry).not.toHaveProperty("elementName");
    }
  });
});
