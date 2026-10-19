// F0.1 残留检查脚本的定向测试（specs/fork-official-deps-removal-tasks.md「F0.1」）。
// 覆盖任务文档点名的四类判定：正则转义（fooz.ai 不命中）、z-ai 不计入域名、
// BYOK 端点放行、基线增减判定。
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { allowedByokEndpointPattern, officialDomainPatterns } from "./lib/official-domains.mjs";
import {
  buildBaselineCounts,
  compareBaseline,
  scanLine,
  scanText,
  walk,
} from "./check-official-refs.mjs";

function domainKeywords(line) {
  return scanLine(line).domainKeywords.map(({ match }) => match);
}

describe("official-domains 域名词表", () => {
  it("点号已转义且带边界：fooz.ai 等前缀粘连不命中", () => {
    expect(domainKeywords("const url = 'https://fooz.ai/path';")).toEqual([]);
    expect(domainKeywords("const url = 'https://notz.ai/path';")).toEqual([]);
    expect(domainKeywords("const id = 'maze-ai';")).toEqual([]);
    expect(domainKeywords("'https://notbigmodel.cn/path';")).toEqual([]);
  });

  it("裸域与任意层级子域整体命中", () => {
    expect(domainKeywords("https://z.ai/api/v1/x")).toEqual(["z.ai"]);
    expect(domainKeywords("https://api.z.ai/api/v1/x")).toEqual(["api.z.ai"]);
    expect(domainKeywords("export const A = 'https://zcode.z.ai';")).toEqual(["zcode.z.ai"]);
    expect(domainKeywords("'https://open.bigmodel.cn/api/v1/x'")).toEqual(["open.bigmodel.cn"]);
    expect(domainKeywords("'https://chatglm.cn'")).toEqual(["chatglm.cn"]);
    expect(domainKeywords("'https://codegeex.cn'")).toEqual(["codegeex.cn"]);
    expect(domainKeywords("'https://zcode-ai.com'")).toEqual(["zcode-ai.com"]);
    // 尾边界：紧跟字母数字不算域名。
    expect(domainKeywords("const weird = 'z.aix';")).toEqual([]);
  });

  it("同一行多个官方域名分别计入", () => {
    expect(domainKeywords("'https://zcode.z.ai/a https://api.z.ai/b'")).toEqual([
      "zcode.z.ai",
      "api.z.ai",
    ]);
  });

  it("词表正则带全局标志，可安全重复使用（无 lastIndex 残留）", () => {
    for (const { regex } of officialDomainPatterns) {
      expect(regex.global).toBe(true);
    }
    expect(domainKeywords("https://z.ai")).toEqual(["z.ai"]);
    expect(domainKeywords("https://z.ai")).toEqual(["z.ai"]);
  });
});

describe("official-domains 标识类词表", () => {
  it("z-ai / z_ai 是 provider id，不计入域名命中", () => {
    expect(domainKeywords("const provider = 'z-ai';")).toEqual([]);
    expect(domainKeywords("const provider = 'z-ai-pc';")).toEqual([]);
    expect(domainKeywords("const env = 'Z_AI_KEY';")).toEqual([]);
  });

  it("标识类词表命中 provider id 并只做统计", () => {
    const identifiers = (line) => scanLine(line).identifierKeywords.map(({ keyword }) => keyword);
    expect(identifiers("provider: 'z-ai', id: 'z-ai-pc'")).toEqual(["z-ai", "z-ai"]);
    expect(identifiers("const scope = '@zai-ai/sdk';")).toEqual(["@zai-ai"]);
    // 命中顺序按词表顺序而非行内出现顺序，用集合断言。
    expect(new Set(identifiers("github.com/zai-org/x zai-sdk y Zhipu_API"))).toEqual(
      new Set(["zai-org", "zai-sdk", "zhipu"]),
    );
    // 边界：无关词不误报。
    expect(identifiers("const puzzle_ai = 1; const blaze-air = 2;")).toEqual([]);
  });
});

describe("BYOK 端点放行", () => {
  it("任务文档列出的四个公开 API 地址不计入域名命中", () => {
    for (const endpoint of [
      "https://api.z.ai/api/anthropic",
      "https://api.z.ai/api/paas/v4",
      "https://open.bigmodel.cn/api/anthropic",
      "https://open.bigmodel.cn/api/paas/v4",
    ]) {
      expect(scanText(`const baseUrl = "${endpoint}";`).domainHits).toBe(0);
    }
  });

  it("带子路径的 BYOK URL 以公开端点为前缀，同样放行", () => {
    expect(scanText('"https://api.z.ai/api/anthropic/v1/messages";').domainHits).toBe(0);
    expect(scanText('"https://open.bigmodel.cn/api/paas/v4/chat/completions";').domainHits).toBe(0);
  });

  it("同行内放行 URL 之外的其他官方地址仍计入", () => {
    const result = scanText(
      'export const A = "https://api.z.ai/api/anthropic";\nexport const B = "https://api.z.ai/api/coding/paas";\nconst mixed = "https://api.z.ai/api/anthropic/v1/messages" + officialUrl("https://zcode.z.ai");',
    );
    expect(result.domainHits).toBe(2);
    expect(result.domainLines.map((entry) => entry.line)).toEqual([2, 3]);
  });

  it("官方网关改写地址（带 :443 端口）不放行，照常计入", () => {
    expect(
      scanText('["https://open.bigmodel.cn:443/api/anthropic/v1/messages", x]').domainHits,
    ).toBe(1);
    expect(allowedByokEndpointPattern.test("https://api.z.ai:443/api/anthropic")).toBe(false);
  });

  it("放行只匹配端点本身与 / 子路径，不吞粘连串", () => {
    expect(scanText('"https://api.z.ai/api/anthropic-evil";').domainHits).toBe(1);
  });
});

describe("基线增减判定", () => {
  it("新增文件与命中数增加判为失败，减少只提示收紧", () => {
    const baseline = { "a.ts": 2, "b.ts": 3 };
    const current = { "a.ts": 3, "b.ts": 1, "c.ts": 4 };
    const { failures, decreases } = compareBaseline(current, baseline);
    expect(failures).toEqual([
      { type: "increased", path: "a.ts", baseline: 2, count: 3 },
      { type: "added", path: "c.ts", count: 4 },
    ]);
    expect(decreases).toEqual([{ path: "b.ts", baseline: 3, count: 1 }]);
  });

  it("基线中有而当前无命中的文件视为减至 0，不失败", () => {
    const { failures, decreases } = compareBaseline({}, { "gone.ts": 5 });
    expect(failures).toEqual([]);
    expect(decreases).toEqual([{ path: "gone.ts", baseline: 5, count: 0 }]);
  });

  it("命中完全一致时不产生失败与提示", () => {
    const baseline = { "a.ts": 2, "b.ts": 1 };
    const { failures, decreases } = compareBaseline({ "b.ts": 1, "a.ts": 2 }, baseline);
    expect(failures).toEqual([]);
    expect(decreases).toEqual([]);
  });

  it("buildBaselineCounts 只收录拦截范围内的域名命中", () => {
    const report = {
      enforced: {
        files: [
          { path: "keep.ts", domainHits: 3, identifierHits: 9 },
          { path: "ident-only.ts", domainHits: 0, identifierHits: 4 },
        ],
      },
    };
    expect(buildBaselineCounts(report)).toEqual({ "keep.ts": 3 });
  });
});

describe("scanText 汇总", () => {
  it("报告行号、关键词与标识分类汇总", () => {
    const result = scanText(
      [
        "const ok = 1;",
        "const a = 'https://api.z.ai/api/v1/x'; // z-ai",
        "",
        "const b = 'https://open.bigmodel.cn/api/v1/y';",
      ].join("\n"),
    );
    expect(result.domainHits).toBe(2);
    expect(result.domainLines.map((entry) => entry.line)).toEqual([2, 4]);
    expect(result.identifierTotals).toEqual({ "z-ai": 1 });
    expect(result.identifierHits).toBe(1);
  });
});

describe("walk 扫描范围", () => {
  it("跳过 .e2e-artifacts / .e2e-network-capture 等 E2E 运行产物", async () => {
    const root = await mkdtemp(join(tmpdir(), "official-refs-walk-"));
    try {
      const captureDir = join(root, ".e2e-artifacts", "run-1", "network-capture");
      await mkdir(captureDir, { recursive: true });
      await writeFile(join(captureDir, "capture.json"), '{"http-referer":"https://zcode.z.ai"}');
      await mkdir(join(root, ".e2e-network-capture"), { recursive: true });
      await writeFile(
        join(root, ".e2e-network-capture", "upstream.json"),
        '{"url":"https://z.ai/api"}',
      );
      await writeFile(join(root, "source.ts"), "export const value = 1;");

      const scanned = [...walk(root)].map((file) => file.relativePath);

      expect(scanned.some((path) => path.includes(".e2e-artifacts"))).toBe(false);
      expect(scanned.some((path) => path.includes(".e2e-network-capture"))).toBe(false);
      expect(scanned.some((path) => path.endsWith("/source.ts"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
