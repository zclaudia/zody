import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditSealedBundle } from "./lib/cua-helper-product-wiring-bundle.mjs";
import { assertAuthorityWorkspaceClosed } from "./lib/cua-helper-round11-final-build.mjs";

test("product wiring and authority reject real imports of both workspace scopes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cua-workspace-scope-"));
  try {
    const output = join(dir, "entry.mjs");
    const metafilePath = join(dir, "meta.json");
    await writeFile(metafilePath, JSON.stringify({ inputs: {}, outputs: {} }));
    for (const scope of ["zcode", "zody"]) {
      for (const source of [
        `import "@${scope}/core";`,
        `await import("@${scope}/core");`,
        `await import(\`@${scope}/core\`, { with: { type: "json" } });`,
        `await import("@${scope}/core", { with: { type: "json" } });`,
        `require(\`@${scope}/core\`);`,
        `require("@${scope}/core");`,
      ]) {
        await writeFile(output, source);
        await assert.rejects(
          () => auditSealedBundle({ output, metafilePath }),
          (error) => error.code === "bundle-external-package",
        );
        assert.throws(
          () => assertAuthorityWorkspaceClosed(source),
          (error) => error.code === "authority-external-package",
        );
      }
    }
    const safe = `// import "@zody/core";\nconst x = 'require("@zcode/core")';\nimport "node:fs";`;
    await writeFile(output, safe);
    await auditSealedBundle({ output, metafilePath });
    assert.doesNotThrow(() => assertAuthorityWorkspaceClosed(safe));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
