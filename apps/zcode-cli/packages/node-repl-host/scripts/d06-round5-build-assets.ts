import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotResources, type D06ResourceManifest } from "./d06-round5-manifest.js";
import {
  resolveKoffiSource,
  stageKoffi,
  type KoffiSource,
  type KoffiStaged,
} from "./d06-round5-native.js";
import { sha256File, type D06Round5Paths } from "./d06-round5-resources.js";

export const REPO_ROOT = resolve(fileURLToPath(new URL("../../../../..", import.meta.url)));
export const BROWSER_PACKAGE_ROOT = resolve(
  fileURLToPath(new URL("../../browser-use-plugin", import.meta.url)),
);

export interface BrowserAssets {
  asset: {
    clientPath: string;
    docsDir: string;
    apiPath: string;
    readmePath: string;
    clientSha256: string;
    docsSha256: string;
    readmeSha256: string;
  };
  evidence: Record<string, unknown>;
}

export async function prepareKoffi(
  paths: D06Round5Paths,
): Promise<{ source: KoffiSource; staged: KoffiStaged } | null> {
  const source = await resolveKoffiSource(REPO_ROOT);
  if (!source) return null;
  const staged = await stageKoffi(paths, source);
  paths.koffiIndexPath = staged.indexPath;
  paths.koffiNativePath = staged.nativePath;
  return { source, staged };
}

export async function buildBrowserAssets(paths: D06Round5Paths): Promise<BrowserAssets> {
  const buildUrl = new URL("../../browser-use-plugin/scripts/build.mjs", import.meta.url).href;
  const builder = (await import(buildUrl)) as {
    buildBrowserUsePluginBundles(input: {
      packageRoot: string;
      browserClientOutfile: string;
    }): Promise<{ browserClientOutfile: string }>;
  };
  await builder.buildBrowserUsePluginBundles({
    packageRoot: BROWSER_PACKAGE_ROOT,
    browserClientOutfile: paths.browserClientPath,
  });
  await copyFile(resolve(BROWSER_PACKAGE_ROOT, "docs/api.json"), paths.browserApiPath);
  await copyFile(resolve(BROWSER_PACKAGE_ROOT, "docs/documents.json"), paths.browserDocumentsPath);
  await copyFile(resolve(BROWSER_PACKAGE_ROOT, "docs/overview.md"), paths.browserOverviewPath);
  await copyFile(resolve(BROWSER_PACKAGE_ROOT, "README.md"), paths.browserReadmePath);
  const source = await hashSpecs(BROWSER_PACKAGE_ROOT, [
    "src/browser-client.ts",
    "scripts/build.mjs",
    "docs/api.json",
    "docs/documents.json",
    "docs/overview.md",
    "README.md",
  ]);
  const output = await hashSpecs(paths.root, [
    paths.browserClientPath,
    paths.browserApiPath,
    paths.browserDocumentsPath,
    paths.browserOverviewPath,
    paths.browserReadmePath,
  ]);
  return {
    asset: {
      clientPath: paths.browserClientPath,
      docsDir: paths.browserDocsDir,
      apiPath: paths.browserApiPath,
      readmePath: paths.browserReadmePath,
      clientSha256: output.find((item) => item.path === paths.browserClientPath)?.sha256 ?? "",
      docsSha256: output.find((item) => item.path === paths.browserApiPath)?.sha256 ?? "",
      readmeSha256: output.find((item) => item.path === paths.browserReadmePath)?.sha256 ?? "",
    },
    evidence: { source, output },
  };
}

export function profileExtras(
  paths: D06Round5Paths,
  addon: { path: string } | undefined,
  koffi: KoffiStaged | undefined,
): Array<{ path: string; reason: string }> {
  return [
    ...(addon ? [{ path: addon.path, reason: "temporary native probe addon" }] : []),
    { path: paths.browserDocumentsPath, reason: "real Browser documents manifest" },
    { path: paths.browserOverviewPath, reason: "real Browser overview document" },
    { path: paths.browserReadmePath, reason: "real Browser package README" },
    ...(koffi
      ? [
          { path: koffi.indexPath, reason: "staged fixed-hash koffi FFI loader" },
          { path: koffi.nativePath, reason: "staged fixed-hash koffi native binding" },
        ]
      : []),
  ];
}

export async function buildManifest(
  paths: D06Round5Paths,
  addonPath?: string,
  koffi?: KoffiStaged,
): Promise<D06ResourceManifest> {
  const specs = [
    { id: "bundle", path: paths.bundlePath },
    { id: "profile", path: paths.profilePath },
    { id: "canary-read", path: paths.canaryReadPath },
    { id: "canary-write", path: paths.canaryWritePath },
    { id: "native-source", path: paths.nativeSourcePath },
    { id: "browser-client", path: paths.browserClientPath },
    { id: "browser-api", path: paths.browserApiPath },
    { id: "browser-documents", path: paths.browserDocumentsPath },
    { id: "browser-overview", path: paths.browserOverviewPath },
    { id: "browser-readme", path: paths.browserReadmePath },
  ];
  if (addonPath) specs.push({ id: "native-addon", path: addonPath });
  if (koffi) {
    specs.push({ id: "koffi-index", path: koffi.indexPath });
    specs.push({ id: "koffi-native", path: koffi.nativePath });
  }
  return await snapshotResources(paths.root, specs);
}

async function hashSpecs(
  root: string,
  files: string[],
): Promise<Array<{ path: string; sha256: string; bytes: number }>> {
  return await Promise.all(
    files.map(async (file) => {
      const path = resolve(root, file);
      return { path, ...(await sha256File(path)) };
    }),
  );
}
