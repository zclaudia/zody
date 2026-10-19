import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";

// 修复依据：欢迎页“跳过”按钮曾引用不存在的 login.apiKey.skip，IntlProvider 把 key 原样渲染。
// 这里从源码收集欢迎页实际使用的 login.* key，要求中英文都存在，防止同类缺失再次出现。
const WELCOME_SOURCES = ["../src/WelcomeScreen.tsx", "../src/login/LoginApiKeyForm.tsx"];

async function collectLoginMessageIds(): Promise<string[]> {
  const ids = new Set<string>();
  for (const file of WELCOME_SOURCES) {
    const source = await readFile(resolve(__dirname, file), "utf8");
    // 匹配所有 "login.*" 字面量，覆盖三元表达式等非 `id: "..."` 直写形式。
    for (const match of source.matchAll(/"(login\.[\w.]+)"/g)) {
      ids.add(match[1]);
    }
  }
  return [...ids].sort();
}

describe("WelcomeScreen i18n", () => {
  it("欢迎页引用的每个 login.* 文案在中英文中都存在", async () => {
    const ids = await collectLoginMessageIds();
    expect(ids).toContain("login.apiKey.skip");
    for (const id of ids) {
      expect(enUS[id], `en-US 缺少 ${id}`).toBeTypeOf("string");
      expect(zhCN[id], `zh-CN 缺少 ${id}`).toBeTypeOf("string");
    }
  });

  it("标题使用 zcoder 品牌名，副标题不再提及账号", () => {
    expect(enUS["login.title"]).toBe("Welcome to zcoder");
    expect(zhCN["login.title"]).toBe("欢迎使用 zcoder");
    expect(enUS["login.description"]).not.toMatch(/account/i);
    expect(zhCN["login.description"]).not.toContain("账号");
    expect(enUS["login.apiKey.skip"]).toBe("Skip for now");
    expect(zhCN["login.apiKey.skip"]).toBe("暂时跳过");
  });
});
