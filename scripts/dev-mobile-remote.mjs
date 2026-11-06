#!/usr/bin/env node
// 手机远控的浏览器开发模式：同时起 Web 端 Vite dev server（服务轻 Shell 入口 mobile-shell.html）
// 和桌面 dev 进程。Shell 在配对页填写本地 gateway 配置，openRemote 后进入 mobile.html。
import { spawn } from "node:child_process";
import process from "node:process";

const DEFAULT_WEB_DEV_ORIGIN = "http://localhost:5173";
const webDevOrigin = process.env.ZODY_MOBILE_WEB_DEV_ORIGIN?.trim() || DEFAULT_WEB_DEV_ORIGIN;
const mobilePageUrl = `${webDevOrigin}/mobile-shell.html`;

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

console.info(`[dev:mobile-remote] 手机入口 ${mobilePageUrl}`);

start(pnpmCommand, ["--filter", "@zody/web", "exec", "vite", "dev", "--strictPort"]);
start(pnpmCommand, ["--filter", "@zody/desktop", "dev:local-cli"]);
