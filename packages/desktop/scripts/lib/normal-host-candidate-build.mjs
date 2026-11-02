// Source-build helpers for the normal utility Host candidate. The outer builder owns the
// assembly transaction; these helpers only configure builds and verify their outputs.
import { build } from "esbuild";
import { join } from "node:path";
import {
  DESKTOP_ROOT,
  ESM_CJS_INTEROP_BANNER,
  RUNTIME_EXTERNALS,
} from "./normal-host-candidate-config.mjs";
import { createWorkspaceSourcePlugin } from "./cua-desktop-session-workspace-source.mjs";

export function sourceDefines({ buildMetadata, environment, productFlavor, buildTimeDefines }) {
  return {
    __ZCODE_VERSION__: JSON.stringify(buildMetadata.appVersion),
    __ZCODE_COMMIT__: JSON.stringify(buildMetadata.buildCommitId),
    __ZCODE_BUILD_TIME__: JSON.stringify(buildMetadata.buildTime),
    __ZCODE_ENV__: JSON.stringify(environment),
    __ZCODE_PRODUCT_FLAVOR__: JSON.stringify(productFlavor),
    ...buildTimeDefines,
    __ZCODE_CUA_HELPER_BUILD_ID__: JSON.stringify(
      process.env.ZCODE_CUA_HELPER_BUILD_ID?.trim() ?? "",
    ),
    __ZCODE_REMOTE_CDN_RELEASE_ROOTS__: JSON.stringify([]),
    __ZCODE_PACKAGED_AGENT_TELEMETRY_ENV__: JSON.stringify({}),
  };
}

export async function buildEntryGroup({ name, entryPoints, outDir, defines, minify }) {
  const result = await build({
    absWorkingDir: DESKTOP_ROOT,
    entryPoints: { ...entryPoints },
    outdir: join(outDir, "out"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: RUNTIME_EXTERNALS,
    define: defines,
    banner: { js: ESM_CJS_INTEROP_BANNER },
    keepNames: minify,
    minify,
    sourcemap: false,
    legalComments: "none",
    chunkNames: `${name}/chunk-[hash]`,
    plugins: [createWorkspaceSourcePlugin()],
    metafile: true,
    logLevel: "info",
  });
  return { ...result, defines: { ...defines } };
}

export function verifyCompiledCandidateSources({
  mainSource,
  hostSource,
  schedulerSource,
  forbiddenPaths,
  displayName,
  profileKind,
  launcherRelativePath,
}) {
  if (mainSource.includes("typeof __ZCODE_CANDIDATE_NATIVE_HOST_LAUNCH__")) {
    throw new Error("normal main still contains unresolved candidate Host define");
  }
  if (
    mainSource.includes("typeof __ZCODE_NORMAL_CUA_CANDIDATE_UI_NAME__") ||
    !mainSource.includes(displayName)
  ) {
    throw new Error("normal main is missing the fixed candidate UI identity");
  }
  if (hostSource.includes("typeof __ZCODE_CUA_NARROW_AGENT__")) {
    throw new Error("compiled Host still contains unresolved narrow profile define");
  }
  if (!hostSource.includes(profileKind) || !hostSource.includes("workspace-relay")) {
    throw new Error("compiled Host is missing the fixed narrow profile or workspace-relay route");
  }
  if (!hostSource.includes(launcherRelativePath)) {
    throw new Error("compiled Host is missing the fixed relative narrow launcher path");
  }
  if (hostSource.includes("ZCODE_CUA_NARROW_AGENT_JSON")) {
    throw new Error("compiled Host exposes a runtime narrow-profile environment switch");
  }
  for (const [label, source] of [
    ["main", mainSource],
    ["host", hostSource],
    ["scheduler", schedulerSource],
  ]) {
    assertCompiledWithoutBuildPaths(source, label, forbiddenPaths);
  }
}

export function assertNoBuildErrors(builds) {
  if (builds.some((result) => result.errors.length > 0)) {
    throw new Error("source build reported esbuild errors");
  }
}

function assertCompiledWithoutBuildPaths(source, label, forbiddenPaths) {
  for (const path of forbiddenPaths) {
    if (path && source.includes(path)) {
      throw new Error(`${label} contains a forbidden build/checkout path: ${path}`);
    }
  }
}
