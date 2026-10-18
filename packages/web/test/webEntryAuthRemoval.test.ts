import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * F4.10：Web 端登录链删除后的入口契约。
 * `/web-remote` 不再有 Z.ai OAuth 登录门或回调页，任何路径都由普通 Web 启动流程承接。
 * 静态部署下该路径由 server 的 SPA fallback 返回 index.html，路由可达性由
 * packages/server/test/serverInfoHttp.test.ts 的 `/web-remote` 用例覆盖。
 */

const WEB_ROOT = resolve(import.meta.dirname, "..");
const WEB_ENTRY = resolve(WEB_ROOT, "src/main.tsx");

describe("Web 入口登录链删除（F4.10）", () => {
  const source = readFileSync(WEB_ENTRY, "utf8");

  it("入口不再引用 auth 模块", () => {
    expect(source).not.toMatch(/from "\.\/auth\//u);
    expect(existsSync(resolve(WEB_ROOT, "src/auth"))).toBe(false);
  });

  it("入口不再拦截 OAuth 回调路径", () => {
    for (const path of ["/web-remote/callback", "/cn/share/callback", "/share/callback"]) {
      expect(source).not.toContain(path);
    }
    expect(source).not.toContain("isWebOAuthCallback");
    expect(source).not.toContain("startLogin");
  });

  it("/web-remote 由普通启动流程承接", () => {
    // 入口只按 `?remote=<id>` 选择 WS 地址；不再按 pathname 分流登录页/回调页，
    // 直接进入 connectViaWebSocket + Root 渲染。
    expect(source).not.toContain("window.location.pathname");
    expect(source).toContain("connectViaWebSocket");
  });
});
