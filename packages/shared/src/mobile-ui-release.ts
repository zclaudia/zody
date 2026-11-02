/**
 * 手机 Remote UI 发布契约（spec: specs/mobile-remote-ui-desktop-delivery.md 第 4.2 节）。
 *
 * 桌面随安装包交付一份只读的 Remote Web 制品，手机经 Gateway HTTP proxy 读取其中的
 * `release.json` 判断是否需要刷新。本文件只冻结 manifest 的类型与严格运行时 schema，
 * 供构建脚本、桌面 provider 与 Remote Web 共用；摘要算法在构建脚本里（依赖 node:crypto，
 * 不能进入浏览器可导入的 shared 根入口）。
 *
 * 边界：
 * - `appProtocol` 的唯一所有者仍是 `web-remote-control*`，manifest 不携带业务协议版本；
 * - manifest 只描述制品本身，不含 task/session、快照或任何设备凭证；
 * - 新字段必须先改本文件与 spec，下游不得自行扩展 manifest。
 */
import { z } from "zod";

/** manifest 格式版本；只有字段语义不兼容变化时才递增。 */
export const MOBILE_UI_RELEASE_SCHEMA_VERSION = 1;

/** 当前原生桥版本（`ZodyRemoteBridge` v1）；manifest 用它声明制品兼容的桥版本集合。 */
export const MOBILE_UI_RELEASE_BRIDGE_VERSION_V1 = 1;

/** Remote 制品的固定 base 路径，Vite 以此作为资源前缀。 */
export const MOBILE_UI_REMOTE_BASE_PATH = "/assets/remote/";

/** manifest 文件名，位于制品根目录，经 `GET /mobile-ui/release` 对外提供。 */
export const MOBILE_UI_RELEASE_MANIFEST_FILE = "release.json";

/** 固定入口：构建把 `mobile.html` 规范化为 `index.html`，manifest 只允许这一个值。 */
export const MOBILE_UI_RELEASE_ENTRY = `${MOBILE_UI_REMOTE_BASE_PATH}index.html`;

/** 构建写入入口 HTML 的 meta 名称；其 content 必须等于 manifest 的 `releaseId`。 */
export const MOBILE_UI_RELEASE_META_NAME = "zody-mobile-ui-release";

/** `releaseId`：24 位小写十六进制。 */
export const MOBILE_UI_RELEASE_ID_PATTERN = /^[0-9a-f]{24}$/;

/** `assetDigest`：全部制品文件相对路径与字节内容的 SHA-256（64 位小写十六进制）。 */
export const MOBILE_UI_RELEASE_ASSET_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

const DESKTOP_VERSION_MAX_CHARS = 64;
const DESKTOP_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

export const mobileUiReleaseManifestSchema = z.strictObject({
  schemaVersion: z.literal(MOBILE_UI_RELEASE_SCHEMA_VERSION),
  releaseId: z.string().regex(MOBILE_UI_RELEASE_ID_PATTERN),
  desktopVersion: z.string().max(DESKTOP_VERSION_MAX_CHARS).regex(DESKTOP_VERSION_PATTERN),
  supportedBridgeVersions: z
    .array(z.number().int().positive())
    .min(1)
    .refine((versions) => new Set(versions).size === versions.length, {
      message: "supportedBridgeVersions must not contain duplicates",
    }),
  entry: z.literal(MOBILE_UI_RELEASE_ENTRY),
  assetDigest: z.string().regex(MOBILE_UI_RELEASE_ASSET_DIGEST_PATTERN),
});

export type MobileUiReleaseManifest = z.infer<typeof mobileUiReleaseManifestSchema>;

/** 非抛出校验，供手机侧在 manifest 异常时保留当前文档而不是崩溃。 */
export function safeParseMobileUiReleaseManifest(input: unknown) {
  return mobileUiReleaseManifestSchema.safeParse(input);
}

/** 抛出式校验，供构建与桌面 provider 在制品不完整时 fail closed。 */
export function parseMobileUiReleaseManifest(input: unknown): MobileUiReleaseManifest {
  const result = mobileUiReleaseManifestSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid mobile UI release manifest: ${result.error.message}`, {
      cause: result.error,
    });
  }
  return result.data;
}
