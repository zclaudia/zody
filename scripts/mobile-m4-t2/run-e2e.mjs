#!/usr/bin/env node
/**
 * M4-T2：通知冷启动深链与按钮动作的真实 Android E2E（无需 Gateway / 桌面）。
 *
 * 覆盖：
 *   1. MobileNotificationRenderService 渲染真实系统通知卡片；
 *   2. 展开通知组/卡片后点击系统按钮（Allow once）→ 原生 pending action 持久化；
 *   3. 点击系统卡片正文 → 原生 pending click 持久化，且 click/action 槽互不覆盖；
 *   4. 强制停止后冷启动 deep link → pending 在 Remote 未 ready 时持久保留、不被 ack；
 *   5. 非法/超长/缺参 intent 不写槽。
 *
 * 不覆盖（见任务报告）：Remote ready 后按 backend 派发到正确页面、跨 backend 返回 Shell、
 * Web 队列 at-most-once 的端到端执行——这些需要可独立占用的测试 backend，当前共享 Gateway
 * 同一 backendId 已被并行任务占用。focused 测试覆盖上述语义。
 *
 * 运行：
 *   node scripts/mobile-m4-t2/run-e2e.mjs
 *   ZODY_E2E_ANDROID_SERIAL=emulator-5584 node scripts/mobile-m4-t2/run-e2e.mjs
 *
 * 前置：debug APK 已安装；设备已解锁。脚本不打印凭证，结束时强制停止并要求清理通知。
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const serial = process.env.ZODY_E2E_ANDROID_SERIAL || "emulator-5584";
const appId = "io.github.zclaudia.zody.mobile";
const activity = `${appId}/.MainActivity`;
const renderService = `${appId}/.notifications.MobileNotificationRenderService`;
const prefsPath = "shared_prefs/mobile_notification_bridge.xml";
const workDir = await mkdtemp(join(tmpdir(), "zody-m4-t2-e2e-"));
const report = { device: serial, scenarios: {}, evidence: {} };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const adb = (...args) => execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8" }).trim();
const adbShell = (...args) => adb("shell", ...args);
/** 读取可选 prefs 时忽略 adb/设备 stderr，避免首次安装的 “No such file” 噪音。 */
const adbShellQuiet = (...args) =>
  execFileSync("adb", ["-s", serial, "shell", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

function record(name, status, details = {}) {
  report.scenarios[name] = { status, ...details };
  console.log(`[m4-t2] ${name}: ${status}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runDeviceScript(name, lines) {
  const local = join(workDir, `${name}.sh`);
  const remote = `/data/local/tmp/zody-m4-t2-${name}.sh`;
  await writeFile(local, `#!/system/bin/sh\n${lines.join("\n")}\n`, "utf8");
  adb("push", local, remote);
  adbShell("sh", remote);
}

function escapeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function readPending() {
  let xml;
  try {
    xml = adbShellQuiet("run-as", appId, "cat", prefsPath);
  } catch {
    return { click: null, action: null };
  }
  const read = (key) => {
    const match = xml.match(new RegExp(`<string name="${key}">([\\s\\S]*?)</string>`));
    if (!match) return null;
    try {
      return JSON.parse(escapeXml(match[1]));
    } catch {
      return null;
    }
  };
  return { click: read("pending_click"), action: read("pending_notification_action_v1") };
}

/**
 * 轮询 pending 槽而不是固定 sleep 后只读一次。
 *
 * 原因：MainActivity 用 SharedPreferences.apply() 异步落盘；实测在模拟器负载下从点击到
 * 文件可读需要 1.0–1.25s，旧的固定 1200ms 会稳定竞态。这里按 150ms 间隔轮询，最多 10s，
 * 超时返回最后一次快照，让原断言给出真实的失败内容。
 */
async function waitForPending(predicate, timeoutMs = 10000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = readPending();
  while (Date.now() < deadline) {
    if (predicate(snapshot)) return snapshot;
    await sleep(intervalMs);
    snapshot = readPending();
  }
  return snapshot;
}

function clearPendingPrefs() {
  adbShell("am", "force-stop", appId);
  try {
    adbShell("run-as", appId, "rm", "-f", prefsPath);
  } catch {
    // 首次安装尚无 prefs 文件。
  }
}

/** 从 uiautomator XML 里取出所有 node 的属性；足够处理系统通知栏的扁平 dump。 */
function parseUiNodes(xml) {
  const nodes = [];
  for (const match of xml.matchAll(/<node\s+([^>]*?)\/?>/gu)) {
    const attributes = {};
    for (const attribute of match[1].matchAll(/([A-Za-z0-9_:-]+)="([^"]*)"/gu)) {
      attributes[attribute[1]] = attribute[2];
    }
    const bounds = attributes.bounds?.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/u);
    if (!bounds) continue;
    const [x1, y1, x2, y2] = bounds.slice(1).map(Number);
    nodes.push({ ...attributes, x1, y1, x2, y2, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2 });
  }
  return nodes;
}

function dumpUi() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      adbShell("uiautomator", "dump", "/sdcard/window.xml");
      return parseUiNodes(adbShell("cat", "/sdcard/window.xml"));
    } catch {
      adbShell("input", "keyevent", "224");
    }
    sleepSync(500);
  }
  throw new Error("uiautomator dump unavailable");
}

function tap(node) {
  adbShell("input", "tap", String(Math.round(node.cx)), String(Math.round(node.cy)));
}

async function expandShade() {
  try {
    adbShell("cmd", "statusbar", "expand-notifications");
  } catch {
    adbShell("input", "swipe", "540", "20", "540", "1600", "300");
  }
  await sleep(700);
}

/**
 * 系统通知默认折叠为「Zody 组」；组和单条卡片各有一个 Expand 按钮。
 * 反复点最上方的 Expand，直到目标文本可见，最多 4 层。
 */
async function reveal(text) {
  // 通知卡片由 Service 异步发布；固定 900ms 后只重试 5 次在模拟器负载下可能还没出现在
  // 通知栏（曾出现一次 “Allow once” 未找到）。扩大到 12 次有界轮询，仍保留超时失败。
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const nodes = dumpUi();
    const target = nodes.find((node) => node.text === text);
    if (target) return target;
    const expand = nodes
      .filter((node) => node["content-desc"] === "Expand" || node.text === "Expand")
      .sort((left, right) => left.y1 - right.y1)[0];
    if (!expand) break;
    tap(expand);
    await sleep(700);
  }
  throw new Error(`notification UI text not found: ${text}`);
}

/** 清掉上一场景的可清除卡片，避免多个 Zody 卡片折叠成组后点错层级。 */
async function clearAllNotifications() {
  await expandShade();
  try {
    const clearAll = dumpUi().find((node) => node.text === "Clear all");
    if (clearAll) {
      tap(clearAll);
      await sleep(700);
    }
  } catch {
    // 没有可清除通知或系统未提供 Clear all。
  }
}

async function postNotification(payload) {
  await runDeviceScript("notify", [
    `am start-foreground-service -n ${renderService} \\`,
    `  --es body '${JSON.stringify(payload)}'`,
  ]);
  await sleep(900);
}

async function sendDeepLink(url) {
  await runDeviceScript("deeplink", [
    `am start -W -a android.intent.action.VIEW -n ${activity} \\`,
    `  -d '${url}'`,
  ]);
}

const expiry = () => Date.now() + 3_600_000;

async function main() {
  adbShell("pm", "grant", appId, "android.permission.POST_NOTIFICATIONS");
  adbShell("input", "keyevent", "224");
  adbShell("wm", "dismiss-keyguard");
  try {
    adbShell("svc", "power", "stayon", "true");
    adbShell("settings", "put", "system", "screen_off_timeout", "2147483647");
  } catch {
    // 模拟器不支持的选项不影响后续。
  }
  clearPendingPrefs();
  await clearAllNotifications();
  report.evidence.initialPending = readPending();

  // 1. 真实系统卡片按钮动作。
  const permissionId = `e2e-perm-${Date.now()}`;
  await postNotification({
    version: 1,
    backendId: "e2e-backend",
    notificationId: permissionId,
    kind: "permission",
    expiresAt: expiry(),
    actions: [
      { optionId: "opt-allow", optionKind: "allowOnce" },
      { optionId: "opt-deny", optionKind: "deny" },
    ],
  });
  await expandShade();
  const allowButton = await reveal("Allow once");
  tap(allowButton);
  // 同上的落盘竞态：轮询等待动作槽出现，超时仍交给下面的断言报出真实快照。
  const afterAction = await waitForPending(
    (pending) =>
      pending.action?.notificationId === permissionId &&
      pending.action?.optionId === "opt-allow" &&
      pending.action?.optionKind === "allowOnce",
  );
  assert(
    afterAction.action?.notificationId === permissionId &&
      afterAction.action?.optionId === "opt-allow" &&
      afterAction.action?.optionKind === "allowOnce",
    `system action did not persist expected pending action: ${JSON.stringify(afterAction.action)}`,
  );
  assert(afterAction.click === null, "action tap must not populate the click slot");
  record("real-system-card-action", "pass", { notificationId: permissionId });

  // 2. 真实系统卡片正文点击（槽分离）。
  // 先停进程清掉 activity 的 FGS 通知与旧样式分组，让任务卡成为唯一卡片；
  // 否则折叠组摘要的点击目标由系统决定，可能落到没有 click data 的常驻通知。
  const clickId = `e2e-click-${Date.now()}`;
  adbShell("am", "force-stop", appId);
  await clearAllNotifications();
  await postNotification({
    version: 1,
    backendId: "e2e-backend",
    notificationId: clickId,
    kind: "task",
    expiresAt: expiry(),
  });
  await expandShade();
  // 卡片可能先在折叠组里；先点正文，若只是展开了组，则点最上方的 Expand 再重试。
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const nodes = dumpUi();
    const body = nodes.find((node) => node.text === "A task has finished.");
    if (body) {
      tap(body);
      // 点击后同样等待异步落盘；一次点击没有命中时再尝试展开组。
      const clicked = await waitForPending(
        (pending) => pending.click?.notificationId === clickId,
        5000,
      );
      if (clicked.click?.notificationId === clickId) break;
    }
    const expand = nodes
      .filter((node) => node["content-desc"] === "Expand" || node.text === "Expand")
      .sort((left, right) => left.y1 - right.y1)[0];
    if (expand) {
      tap(expand);
      await sleep(700);
    }
  }
  const afterClick = await waitForPending(
    (pending) => pending.click?.notificationId === clickId,
    5000,
  );
  assert(
    afterClick.click?.notificationId === clickId && afterClick.click?.backendId === "e2e-backend",
    `system card click did not persist expected pending click: ${JSON.stringify(afterClick.click)}`,
  );
  assert(
    afterClick.action?.notificationId === permissionId,
    "card click must not consume the action slot",
  );
  record("real-system-card-click", "pass", { notificationId: clickId });

  // 3. 冷启动 deep link 先持久化；未 ready 时不 ack。
  const coldId = `e2e-cold-${Date.now()}`;
  adbShell("am", "force-stop", appId);
  await sendDeepLink(
    `zody://notification/v1?backendId=e2e-backend&notificationId=${encodeURIComponent(coldId)}`,
  );
  // 冷启动 Activity 与 SharedPreferences 写入也是异步的，先轮询到 pending 出现。
  const afterColdStart = await waitForPending(
    (pending) => pending.click?.notificationId === coldId,
  );
  assert(
    afterColdStart.click?.notificationId === coldId,
    "cold start deep link was not persisted before Remote ready",
  );
  // 这里是“等待 3 秒确认没有被 ack”，使用固定窗口符合断言语义。
  await sleep(3000);
  const retained = readPending();
  assert(
    retained.click?.notificationId === coldId,
    "unconfirmed pending click must be retained when no Remote session is ready",
  );
  assert(
    retained.action?.notificationId === permissionId,
    "cold start must not consume the separate action slot",
  );
  record("cold-start-pending-without-ack", "pass", { notificationId: coldId });

  // 4. 非法 intent 不覆盖已有 pending。
  await runDeviceScript("invalid", [
    `am start -W -a android.intent.action.VIEW -n ${activity} \\`,
    `  -d 'zody://notification-action/v1?backendId=e2e-backend&notificationId=${permissionId}&optionId=bad&optionKind=custom'`,
    `am start -W -a android.intent.action.VIEW -n ${activity} \\`,
    `  -d 'zody://notification/v1?backendId=e2e-backend&notificationId='`,
    `am start -W -a android.intent.action.VIEW -n ${activity} \\`,
    `  -d 'zody://notification/v1?backendId=e2e-backend&notificationId=${"a".repeat(268)}'`,
  ]);
  // 非法 intent 的断言是“不改变已有槽”，等一个短稳定窗口后再读，避免把尚未落盘的旧值当失败。
  await sleep(500);
  const afterInvalid = readPending();
  assert(
    afterInvalid.click?.notificationId === coldId &&
      afterInvalid.action?.notificationId === permissionId,
    `invalid intents overwrote pending slots: ${JSON.stringify(afterInvalid)}`,
  );
  record("invalid-intent-preserves-pending", "pass");
}

let failure;
try {
  await main();
} catch (error) {
  failure = error;
  record("run", "fail", { error: error instanceof Error ? error.message : String(error) });
} finally {
  // 清理：停进程（系统同时移除该应用通知）并删除测试 pending/seen 槽；不触碰 Shell 配置。
  try {
    adbShell("am", "force-stop", appId);
    adbShell("run-as", appId, "rm", "-f", prefsPath);
    adbShell("cmd", "statusbar", "collapse");
  } catch {
    // best-effort cleanup
  }
  await rm(workDir, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}

if (failure) process.exitCode = 1;
