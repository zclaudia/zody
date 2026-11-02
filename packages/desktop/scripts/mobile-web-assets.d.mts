import type * as NodePath from "node:path";

export const MOBILE_WEB_RESOURCE_DIR_NAME: "mobile-web";

export interface ResolveMobileWebSourceDirOptions {
  desktopPackageRoot?: string;
  pathApi?: typeof NodePath;
}

export interface ResolveMobileWebRootDirOptions {
  isPackaged?: boolean;
  resourcesPath?: string;
  desktopPackageRoot?: string;
  pathApi?: typeof NodePath;
}

export type MobileWebReleaseVerifier = (input: { distDir: string }) => Promise<unknown>;

export interface VerifyMobileWebReleaseDirectoryOptions {
  rootDir?: string;
  verifyRelease?: MobileWebReleaseVerifier;
}

export function resolveMobileWebSourceDir(options?: ResolveMobileWebSourceDirOptions): string;
export function resolveMobileWebRootDir(options?: ResolveMobileWebRootDirOptions): string;
export function verifyMobileWebReleaseDirectory(
  options?: VerifyMobileWebReleaseDirectoryOptions,
): Promise<unknown>;
