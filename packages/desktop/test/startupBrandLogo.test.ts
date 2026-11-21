import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("desktop startup brand logo", () => {
  it("启动壳使用新应用图标，不再内嵌旧 Z 字形", () => {
    const html = readFileSync(
      resolve(import.meta.dirname, "../src/renderer/index.html"),
      "utf8",
    );

    expect(html).toContain("./brand/zody-logo.png");
    expect(html).not.toContain("M134.4");
  });

  it("启动壳图标、欢迎页品牌图与公共图标是同一文件", () => {
    const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    const startupLogo = resolve(import.meta.dirname, "../src/renderer/public/brand/zody-logo.png");
    const welcomeLogo = resolve(import.meta.dirname, "../../ui/src/assets/brand/zody-logo.png");
    const publicLogo = resolve(import.meta.dirname, "../../../public/logo/icons/128x128.png");

    expect(hash(startupLogo)).toBe(hash(publicLogo));
    expect(hash(welcomeLogo)).toBe(hash(publicLogo));
  });
});
