import { describe, expect, it } from "vitest";
import {
  MOBILE_UI_RELEASE_BRIDGE_VERSION_V1,
  MOBILE_UI_RELEASE_ENTRY,
  MOBILE_UI_RELEASE_ID_PATTERN,
  MOBILE_UI_RELEASE_MANIFEST_FILE,
  MOBILE_UI_RELEASE_META_NAME,
  MOBILE_UI_RELEASE_SCHEMA_VERSION,
  mobileUiReleaseManifestSchema,
  parseMobileUiReleaseManifest,
  safeParseMobileUiReleaseManifest,
  type MobileUiReleaseManifest,
} from "../src/mobile-ui-release.js";
import * as sharedIndex from "../src/index.js";

const VALID: MobileUiReleaseManifest = {
  schemaVersion: 1,
  releaseId: "0123456789abcdef01234567",
  desktopVersion: "3.15.1",
  supportedBridgeVersions: [1],
  entry: "/assets/remote/index.html",
  assetDigest: "a".repeat(64),
};

describe("MobileUiReleaseManifest 契约常量", () => {
  it("与 spec 第 4.2 节保持一致，且经 shared 根入口公开", () => {
    expect(MOBILE_UI_RELEASE_SCHEMA_VERSION).toBe(1);
    expect(MOBILE_UI_RELEASE_BRIDGE_VERSION_V1).toBe(1);
    expect(MOBILE_UI_RELEASE_MANIFEST_FILE).toBe("release.json");
    expect(MOBILE_UI_RELEASE_ENTRY).toBe("/assets/remote/index.html");
    expect(MOBILE_UI_RELEASE_META_NAME).toBe("zody-mobile-ui-release");
    expect(MOBILE_UI_RELEASE_ID_PATTERN.test("0123456789abcdef01234567")).toBe(true);
    expect(sharedIndex.parseMobileUiReleaseManifest).toBe(parseMobileUiReleaseManifest);
  });
});

describe("mobileUiReleaseManifestSchema", () => {
  it("接受完整合法 manifest，并返回独立副本", () => {
    const parsed = parseMobileUiReleaseManifest(VALID);
    expect(parsed).toEqual(VALID);
    expect(parsed).not.toBe(VALID);
    expect(parsed.supportedBridgeVersions).not.toBe(VALID.supportedBridgeVersions);
  });

  it.each(Object.keys(VALID))("缺少字段 %s 时拒绝", (field) => {
    const candidate: Record<string, unknown> = { ...VALID };
    delete candidate[field];
    expect(mobileUiReleaseManifestSchema.safeParse(candidate).success).toBe(false);
  });

  it("拒绝额外字段，下游不得另创 manifest 字段", () => {
    expect(safeParseMobileUiReleaseManifest({ ...VALID, extra: true }).success).toBe(false);
    // appProtocol 的唯一所有者是 web-remote-control*，manifest 不得携带业务协议版本。
    expect(safeParseMobileUiReleaseManifest({ ...VALID, appProtocol: 2 }).success).toBe(false);
  });

  it.each([
    ["大写十六进制", "0123456789ABCDEF01234567"],
    ["过短", "0123456789abcdef0123456"],
    ["过长", "0123456789abcdef012345678"],
    ["非十六进制", "0123456789abcdef0123456g"],
    ["空串", ""],
  ])("非法 releaseId（%s）拒绝", (_name, releaseId) => {
    expect(safeParseMobileUiReleaseManifest({ ...VALID, releaseId }).success).toBe(false);
  });

  it("拒绝 schemaVersion 之外的版本", () => {
    expect(safeParseMobileUiReleaseManifest({ ...VALID, schemaVersion: 2 }).success).toBe(false);
    expect(safeParseMobileUiReleaseManifest({ ...VALID, schemaVersion: "1" }).success).toBe(false);
  });

  it.each([
    ["空数组", []],
    ["重复值", [1, 1]],
    ["零", [0]],
    ["负数", [-1]],
    ["小数", [1.5]],
    ["字符串", ["1"]],
  ])("非法 supportedBridgeVersions（%s）拒绝", (_name, supportedBridgeVersions) => {
    expect(safeParseMobileUiReleaseManifest({ ...VALID, supportedBridgeVersions }).success).toBe(
      false,
    );
  });

  it("接受多个不同的 bridge 版本", () => {
    expect(
      safeParseMobileUiReleaseManifest({ ...VALID, supportedBridgeVersions: [1, 2] }).success,
    ).toBe(true);
  });

  it("entry 只能是固定的 Remote 入口", () => {
    for (const entry of [
      "/assets/remote/mobile.html",
      "assets/remote/index.html",
      "/assets/remote/../index.html",
      "https://example.com/assets/remote/index.html",
    ]) {
      expect(safeParseMobileUiReleaseManifest({ ...VALID, entry }).success).toBe(false);
    }
  });

  it.each([
    ["过短", "a".repeat(63)],
    ["过长", "a".repeat(65)],
    ["大写", "A".repeat(64)],
    ["非十六进制", "g".repeat(64)],
  ])("非法 assetDigest（%s）拒绝", (_name, assetDigest) => {
    expect(safeParseMobileUiReleaseManifest({ ...VALID, assetDigest }).success).toBe(false);
  });

  it.each(["", " ", "3.15 .1", "x".repeat(65)])("非法 desktopVersion %j 拒绝", (desktopVersion) => {
    expect(safeParseMobileUiReleaseManifest({ ...VALID, desktopVersion }).success).toBe(false);
  });

  it("parseMobileUiReleaseManifest 对非法输入抛出可诊断错误", () => {
    expect(() => parseMobileUiReleaseManifest({})).toThrow(/Invalid mobile UI release manifest/);
    expect(() => parseMobileUiReleaseManifest(null)).toThrow(/Invalid mobile UI release manifest/);
    expect(() => parseMobileUiReleaseManifest("{}")).toThrow(/Invalid mobile UI release manifest/);
  });
});
