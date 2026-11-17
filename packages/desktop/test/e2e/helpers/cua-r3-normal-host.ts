import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

// 复用已有真实SDK单案，只为新的正常Host装配增加SDK外的环境/权限准备门。
export async function prepareR3NormalHost() {
  const directory = process.env.ZODY_CUA_R2_EVIDENCE_DIR?.trim() ?? "";
  if (!isAbsolute(directory)) throw new Error("R3 explicit evidence directory missing");
  const facts = await browser.electron.execute((electron) => ({
    pid: process.pid,
    executable: electron.app.getPath("exe"),
    appPath: electron.app.getAppPath(),
    appName: electron.app.getName(),
    packaged: electron.app.isPackaged,
    screenPermission: electron.systemPreferences.getMediaAccessStatus("screen"),
  }));
  if (
    !facts.packaged ||
    !facts.executable.includes("cua-r3-normal-host-20261115/run-slot/") ||
    !facts.appPath.endsWith("/Contents/Resources/app.asar")
  )
    throw new Error("R3 requires the isolated normal production Host candidate");
  await writeFile(
    resolve(directory, "normal-host-preflight.json"),
    JSON.stringify({ ...facts, SDKStarted: false, writes: 0 }, null, 2),
  );
  // 中文原因：系统权限可能需要人工处理；先结束所有SDK之外的准备，复用单案的reload启动新候选进程再调用工具。
  const deadline = Date.now() + 1_800_000;
  while (Date.now() < deadline) {
    try {
      const ready = JSON.parse(await readFile(resolve(directory, "operator-ready.json"), "utf8"));
      if (ready.ready === true) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error("R3 environment readiness expired before SDK; no action replay");
}
