import { describe, expect, it } from "vitest";
import {
  extractMobileNotificationPushActions,
  mobileNotificationPushActionSchema,
  mobileNotificationPushActionsSchema,
} from "../src/mobile-notification-delivery.js";

/** 第二批 E4：envelope 按钮的脱敏提取与上限。 */
describe("mobile notification push actions", () => {
  it("只提取三类固定 kind 的选项，按原顺序取前 3；custom/空 optionId 被跳过", () => {
    expect(
      extractMobileNotificationPushActions({
        options: [
          { optionId: "opt-custom", kind: "custom" },
          { optionId: "opt-once", kind: "allowOnce" },
          { optionId: "", kind: "deny" },
          { optionId: "opt-always", kind: "allowAlways" },
          { optionId: "opt-deny", kind: "deny" },
          { optionId: "opt-extra", kind: "allowOnce" },
        ],
      }),
    ).toEqual([
      { optionId: "opt-once", optionKind: "allowOnce" },
      { optionId: "opt-always", optionKind: "allowAlways" },
      { optionId: "opt-deny", optionKind: "deny" },
    ]);
  });

  it("非法输入与无可映射选项时返回 undefined", () => {
    expect(extractMobileNotificationPushActions(undefined)).toBeUndefined();
    expect(extractMobileNotificationPushActions("x")).toBeUndefined();
    expect(extractMobileNotificationPushActions({})).toBeUndefined();
    expect(
      extractMobileNotificationPushActions({ options: [{ optionId: "a", kind: "custom" }] }),
    ).toBeUndefined();
    expect(extractMobileNotificationPushActions({ options: [] })).toBeUndefined();
  });

  it("schema 拒绝未知字段与非法 kind；上限 3", () => {
    expect(
      mobileNotificationPushActionSchema.parse({
        optionId: "opt",
        optionKind: "deny",
      }),
    ).toEqual({ optionId: "opt", optionKind: "deny" });
    expect(
      mobileNotificationPushActionSchema.safeParse({
        optionId: "opt",
        optionKind: "escalate",
      }).success,
    ).toBe(false);
    // envelope 不携带 label：脱敏红线由 schema 结构保证。
    expect(
      mobileNotificationPushActionSchema.safeParse({
        optionId: "opt",
        optionKind: "deny",
        label: "允许",
      }).success,
    ).toBe(false);
    expect(mobileNotificationPushActionsSchema.safeParse([]).success).toBe(true);
    expect(
      mobileNotificationPushActionsSchema.safeParse(
        Array.from({ length: 4 }, (_, i) => ({ optionId: `o${i}`, optionKind: "deny" })),
      ).success,
    ).toBe(false);
  });
});
