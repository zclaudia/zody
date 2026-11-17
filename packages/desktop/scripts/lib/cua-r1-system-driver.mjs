import { isAbsolute } from "node:path";
export function cuaR1SystemChromeOptions(options, context) {
  // 中文原因：ChromeDriver 在调试连接丢失时会终止其持有的进程；系统故障验收必须保留候选，让真实守卫和恢复继续执行。
  const systemCase =
    context.platform === "darwin" &&
    typeof context.systemRun === "string" &&
    isAbsolute(context.systemRun) &&
    context.specs.length === 1 &&
    context.specs[0].endsWith("/conversation-session-cua-r1-system-state.test.ts");
  return systemCase ? { ...options, detach: true } : options;
}
export function canPollR1SystemUI(sample, faultBoundary) {
  if (
    !sample ||
    sample.guard !== "allowed" ||
    sample.event === "complete" ||
    !Number.isSafeInteger(sample.sleepSequence) ||
    sample.sleepSequence < 0 ||
    !Number.isSafeInteger(sample.wakeSequence) ||
    sample.wakeSequence < 0
  )
    return false;
  if (faultBoundary === null) return true;
  return (
    Number.isSafeInteger(faultBoundary) &&
    faultBoundary >= 0 &&
    sample.sleepSequence > faultBoundary &&
    sample.wakeSequence > sample.sleepSequence
  );
}
export function r1SystemWaitBudgets(operatorWaitSeconds = 300) {
  if (
    !Number.isInteger(operatorWaitSeconds) ||
    operatorWaitSeconds < 60 ||
    operatorWaitSeconds > 1800
  )
    throw new Error("Invalid operator wait budget");
  const operatorMs = operatorWaitSeconds * 1000;
  const testMs = operatorMs * 2 + 300_000;
  return { operatorMs, recoveryMs: operatorMs, testMs, monitorSeconds: testMs / 1000 + 120 };
}
export async function waitForR1SystemEligibility({
  readSample,
  faultBoundary,
  operatorWaitSeconds = 300,
  now = Date.now,
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
}) {
  // 中文原因：睡眠暂停的是执行，不是人工恢复资格；不能用机器 40 秒预算在用户解锁前销毁候选。
  const deadline = now() + r1SystemWaitBudgets(operatorWaitSeconds).recoveryMs;
  while (now() < deadline) {
    if (canPollR1SystemUI(await readSample(), faultBoundary)) return true;
    await wait(25);
  }
  return false;
}
