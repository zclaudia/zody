import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const R3_FORMAL_LOCAL_SPEC = "conversation-session-cua-r3-formal-local.test.ts";

export const R3_PRODUCTION_RENDERER_SPEC =
  "conversation-session-cua-r3-production-renderer.test.ts";

/** 只为本轮精确用例切换就绪合同；其他用例仍必须具备原E2E store bridge。 */
export function usesR3ProductionRendererPreflight(options: {
  specs: readonly string[];
  packagedApp: string | null;
  cwd: string;
  repoRoot: string;
  platform: string;
}): boolean {
  // 修复原因：WDIO worker的spec采用file URL；先用标准解析器转换，不能把合法精确用例误拒绝。
  const specs = options.specs.map((s) => (s.startsWith("file:") ? fileURLToPath(s) : s));
  const matching = specs.filter((s) =>
    [R3_PRODUCTION_RENDERER_SPEC, R3_FORMAL_LOCAL_SPEC].some((name) =>
      s.replaceAll("\\", "/").endsWith(`/${name}`),
    ),
  );
  if (!matching.length) return false;
  const formal = specs[0]?.replaceAll("\\", "/").endsWith(`/${R3_FORMAL_LOCAL_SPEC}`);
  const expected = resolve(
    options.repoRoot,
    formal
      ? "output/cua-r3-formal-local-20261116/run-slot/mac-arm64/Zody.app/Contents/MacOS/Zody"
      : "output/cua-r3-normal-host-20261115/run-slot/mac-arm64/Zody CUA Normal Host Candidate.app/Contents/MacOS/Zody CUA Normal Host Candidate",
  );
  const exactSpec = resolve(
    options.repoRoot,
    "packages/desktop/test/e2e/conversation-session/manual-review/pending",
    formal ? R3_FORMAL_LOCAL_SPEC : R3_PRODUCTION_RENDERER_SPEC,
  );
  // 调用方先用异步realpath解析cwd/repoRoot，避免符号链接把仓库内部伪装成外部。
  const rel = relative(options.repoRoot, options.cwd);
  if (
    options.specs.length !== 1 ||
    resolve(specs[0]!) !== exactSpec ||
    options.platform !== "darwin" ||
    options.packagedApp !== expected ||
    !(isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
  ) {
    throw new Error(
      "R3 production renderer requires its single exact spec/candidate and a cwd outside the repository",
    );
  }
  return true;
}

export async function runR3ProductionRendererPreflight() {
  await browser.waitUntil(
    async () => {
      const handles = await browser.getWindowHandles();
      for (const handle of handles) {
        await browser.switchToWindow(handle);
        const facts = await browser.execute(() => ({
          url: window.location.href,
          ready: document.readyState,
          storeBridge: "__zcodeSessionStoreE2E" in window,
        }));
        if (!facts.url.includes("/Contents/Resources/app.asar/out/renderer/index.html")) continue;
        if (facts.storeBridge)
          throw new Error("R3 production renderer unexpectedly exposes the E2E store bridge");
        if (facts.ready !== "complete") continue;
        (browser.electron as typeof browser.electron & { windowHandle?: string }).windowHandle =
          handle;
        return true;
      }
      return false;
    },
    { timeout: 30_000, interval: 100, timeoutMsg: "R3 packaged production renderer is not ready" },
  );
}
