import { readFile, writeFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, resolve } from "node:path";
import { reloadElectronSessionSafely } from "./e2e-electron-reload.js";
import { runR3ProductionRendererPreflight } from "./cua-r3-production-renderer.js";

const exec = promisify(execFile);

/** 系统权限等待在SDK之外；身份以实际包/签名核验，运行名只服务隔离。 */
export async function prepareFormalLocal() {
  const evidence = process.env.ZODY_CUA_R3_EVIDENCE_DIR?.trim() ?? "";
  const repo = resolve(import.meta.dirname, "../../../../..");
  const app = resolve(repo, "output/cua-r3-formal-local-20261116/run-slot/mac-arm64/Zody.app");
  const expected = resolve(app, "Contents/MacOS/Zody");
  if (
    !isAbsolute(evidence) ||
    !evidence.startsWith(resolve(repo, "output/cua-r3-formal-local-20261116") + "/")
  )
    throw new Error("Formal local evidence scope is missing");
  const plist = async (key: string) =>
    (
      await exec("/usr/libexec/PlistBuddy", [
        "-c",
        `Print :${key}`,
        resolve(app, "Contents/Info.plist"),
      ])
    ).stdout.trim();
  const identity = {
    bundleId: await plist("CFBundleIdentifier"),
    bundleName: await plist("CFBundleName"),
  };
  if (identity.bundleId !== "io.github.zclaudia.zody" || identity.bundleName !== "Zody")
    throw new Error("Formal local package identity mismatch");
  const facts = () =>
    browser.electron.execute((electron) => ({
      pid: process.pid,
      cwd: process.cwd(),
      executable: electron.app.getPath("exe"),
      appPath: electron.app.getAppPath(),
      appName: electron.app.getName(),
      home: electron.app.getPath("home"),
      userData: electron.app.getPath("userData"),
      packaged: electron.app.isPackaged,
      screenPermission: electron.systemPreferences.getMediaAccessStatus("screen"),
      runId: process.env.ZODY_E2E_RUN_ID,
    }));
  const verify = async (f: Awaited<ReturnType<typeof facts>>) => {
    if (
      f.executable !== expected ||
      f.appPath !== resolve(app, "Contents/Resources/app.asar") ||
      !f.packaged ||
      f.appName !== "ZCode E2E" ||
      f.home !== process.env.ZODY_E2E_HOME_DIR ||
      !f.runId ||
      !f.userData.includes(f.runId) ||
      (await realpath(f.cwd)) !== (await realpath(process.cwd()))
    )
      throw new Error("Formal local running process is not the isolated packaged candidate");
  };
  await runR3ProductionRendererPreflight();
  const initial = await facts();
  await verify(initial);
  await writeFile(
    resolve(evidence, "formal-local-preflight.json"),
    JSON.stringify(
      {
        ...initial,
        ...identity,
        SDKStarted: false,
        writes: 0,
        helperAccessibility: {
          standaloneProbeAvailable: false,
          lastAcceptedEvidence: "R3-02 same signed Helper",
          currentState:
            "not independently queried; first native read must succeed before the one write",
        },
        runtimeNamePurpose:
          "isolate the existing installed app and shell integrations; bundle/signature/TCC identity remains formal",
      },
      null,
      2,
    ) + "\n",
  );
  const deadline = Date.now() + 1_800_000;
  while (Date.now() < deadline) {
    let ready = false;
    try {
      ready =
        JSON.parse(await readFile(resolve(evidence, "operator-ready.json"), "utf8")).ready === true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (ready) {
      // 录屏授权改变后按既有退出屏障重启，不能仅凭用户勾选或旧进程状态记成功。
      if (initial.screenPermission !== "granted") {
        await reloadElectronSessionSafely(browser);
        await runR3ProductionRendererPreflight();
      }
      const current = await facts();
      await verify(current);
      await writeFile(
        resolve(evidence, "formal-local-ready.json"),
        JSON.stringify({ ...current, ...identity, SDKStarted: false, writes: 0 }, null, 2) + "\n",
      );
      if (current.screenPermission !== "granted")
        throw new Error(
          "Formal candidate screen permission is still denied after readiness; no SDK/action dispatched",
        );
      return;
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error("Formal local readiness expired before SDK; no action replay");
}

/** 修复依据：OptionAll可列出仍有ID但已离屏的旧夹具；SDK前必须核对两扇窗口的新鲜onscreen事实。 */
export function assertFormalFixtureOnscreen(
  rows: Array<{ id: number; pid: number; layer: number; onscreen?: unknown }>,
  f: { pid: number; targetWindow: number; siblingWindow: number },
) {
  if (
    ![f.targetWindow, f.siblingWindow].every(
      (id) =>
        rows.filter((r) => r.id === id && r.pid === f.pid && r.layer === 0 && r.onscreen === true)
          .length === 1,
    )
  )
    throw new Error("Formal fixture windows are not onscreen before SDK");
}

export async function checkFormalFixtureVisibility(
  inspector: string,
  f: { pid: number; targetWindow: number; siblingWindow: number },
) {
  const { stdout } = await exec(inspector, [String(f.pid)]);
  assertFormalFixtureOnscreen(JSON.parse(stdout), f);
}
