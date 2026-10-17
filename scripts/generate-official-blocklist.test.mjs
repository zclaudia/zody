// F0.3 断网验收容器 --add-host 屏蔽清单生成器的定向测试
// （specs/fork-official-deps-removal-tasks.md「F0.3」）。
// 覆盖：裸域 + 代码引用子域的收集、dist 忽略、大小写归一、非官方域名不误收、
// add-host 参数拼接，以及真实仓库上的 CLI 出口。
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAddHostArgs, collectOfficialHosts } from "./generate-official-blocklist.mjs";

describe("collectOfficialHosts", () => {
  it("收集裸域与代码引用的官方子域，忽略 dist 与非官方域名", async () => {
    const root = await mkdtemp(join(tmpdir(), "official-blocklist-"));
    try {
      await mkdir(join(root, "packages/a/src"), { recursive: true });
      await mkdir(join(root, "packages/a/dist"), { recursive: true });
      await mkdir(join(root, "scripts"), { recursive: true });
      await writeFile(
        join(root, "packages/a/src/x.ts"),
        'const a = "https://API.Z.AI/api/v1";\nconst b = "https://zcode.z.ai/path";\n',
      );
      await writeFile(
        join(root, "packages/a/src/y.ts"),
        'const c = "https://fooz.ai";\n' +
          'const d = "https://open.bigmodel.cn/api/paas/v4";\n' +
          'const e = "https://z-cdn.chatglm.cn/font.ttf";\n',
      );
      await writeFile(join(root, "packages/a/dist/out.js"), 'export const gone = "https://dist.z.ai/ignored";\n');
      await writeFile(join(root, "scripts/keep.mjs"), "// provider id z-ai 不产生域名命中\n");
      // shell 默认值语法（`${var:-cdn-zcode.z.ai}`）会截出非法主机名，应被形状过滤剔除；
      // 同文件中合法主机名不受影响。
      await writeFile(
        join(root, "packages/a/src/env.sh"),
        'CDN_DOMAIN_RAW="${CDN_DOMAIN:-cdn-zcode.z.ai}"\n# real: https://cdn-zcode.z.ai/icon.png\n',
      );

      const hosts = collectOfficialHosts(root);

      // 裸域始终在清单内（词表顺序无关，返回值按字典序）。
      expect(hosts).toEqual(
        expect.arrayContaining([
          "z.ai",
          "api.z.ai",
          "zcode.z.ai",
          "bigmodel.cn",
          "open.bigmodel.cn",
          "chatglm.cn",
          "z-cdn.chatglm.cn",
          "codegeex.cn",
          "zcode-ai.com",
        ]),
      );
      // 大小写归一：内容转小写后匹配，不产生大写变体。
      expect(hosts).not.toContain("API.Z.AI");
      expect(hosts.filter((host) => host !== host.toLowerCase())).toEqual([]);
      // 前缀粘连不误收；dist 与忽略目录不进清单。
      expect(hosts).not.toContain("fooz.ai");
      expect(hosts).not.toContain("dist.z.ai");
      // 形状过滤：shell `${var:-default}` 语法截出的非法标签（`-` 开头）不进清单。
      expect(hosts).not.toContain("-cdn-zcode.z.ai");
      expect(hosts).toContain("cdn-zcode.z.ai");
      // 返回值稳定排序。
      expect(hosts).toEqual([...hosts].sort((left, right) => left.localeCompare(right)));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("buildAddHostArgs", () => {
  it("生成 host:sink 形式的 --add-host 参数", () => {
    expect(buildAddHostArgs(["api.z.ai", "z.ai"], "127.0.0.1")).toEqual([
      "api.z.ai:127.0.0.1",
      "z.ai:127.0.0.1",
    ]);
  });
});

describe("CLI（真实仓库）", () => {
  it("--format hosts 输出包含裸域，退出码为 0", async () => {
    const scriptPath = fileURLToPath(new URL("./generate-official-blocklist.mjs", import.meta.url));
    const result = await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [scriptPath, "--format", "hosts"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdoutText = "";
      let stderrText = "";
      child.stdout.on("data", (chunk) => {
        stdoutText += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderrText += chunk;
      });
      child.on("error", rejectPromise);
      child.on("exit", (code) => {
        resolvePromise({ code, stdoutText, stderrText });
      });
    });
    expect(result.code).toBe(0);
    const hosts = result.stdoutText.trim().split("\n");
    expect(hosts).toContain("z.ai");
    expect(hosts).toContain("api.z.ai");
    expect(hosts).toContain("zcode.z.ai");
    expect(result.stderrText).toContain("official host(s)");
    // 排序稳定，供 bash while-read 消费。
    expect(hosts).toEqual([...hosts].sort((left, right) => left.localeCompare(right)));
  }, 60_000);
});
