#!/usr/bin/env node
// 手机远控的浏览器开发模式（T1.2）：同时起 Web 端 Vite dev server（服务手机入口 mobile.html）
// 和桌面 dev 进程（把桌面生成的远控 URL 指向手机入口）。
// 旧链路 `dev:web-remote-control` 保留到 T5.1。
import { spawn } from "node:child_process";
import process from "node:process";

const DEFAULT_WEB_DEV_ORIGIN = "http://localhost:5173";
const webDevOrigin = process.env.ZCODE_MOBILE_WEB_DEV_ORIGIN?.trim() || DEFAULT_WEB_DEV_ORIGIN;
const mobilePageUrl = `${webDevOrigin}/mobile.html`;

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const children = [];

function start(command, args, env) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  children.push(child);
  child.on("error", (error) => {
    console.error("[dev:mobile-remote] 子进程启动失败", error);
    shutdown(1);
  });
  child.on("exit", (code) => {
    // 任一子进程退出即整体退出，避免留下半套开发环境。
    shutdown(code ?? 1);
  });
  return child;
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    child.kill();
  }
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}

console.info(`[dev:mobile-remote] 手机入口 ${mobilePageUrl}（桌面远控 URL 指向该地址）`);

start(pnpmCommand, ["--filter", "@zcode/web", "exec", "vite", "dev", "--strictPort"]);
start(pnpmCommand, ["--filter", "@zcode/desktop", "dev:local-cli"], {
  ZCODE_WEB_REMOTE_CONTROL_URL: mobilePageUrl,
});
