"use strict";
const { app, BrowserWindow } = require("electron");
const { mkdir, writeFile, rename, stat } = require("node:fs/promises");
const { resolve, isAbsolute } = require("node:path");
const directory = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
if (!directory || !isAbsolute(directory)) throw new Error("Expected exact absolute run directory");
const windows = [];
let complete = false;
app
  .whenReady()
  .then(async () => {
    if (!(await stat(directory)).isDirectory()) throw new Error("Run directory missing");
    await mkdir(resolve(directory, "electron-data"), { recursive: true });
    app.setPath("userData", resolve(directory, "electron-data"));
    // 中文原因：该组合显式启用 Chromium AX；通过只代表此受控组合，不扩大到全部 Electron 应用。
    app.setAccessibilitySupportEnabled(true);
    const manifest = {
      fixtureKind: "read-electron-v1",
      pid: process.pid,
      targetMarker: "E2E_R1_TARGET_BODY",
      siblingMarker: "E2E_R1_SIBLING_BODY",
    };
    for (const [index, kind] of ["target", "sibling"].entries()) {
      const window = new BrowserWindow({
        title: "Zody R1 Read Fixture",
        x: 80 + index * 330,
        y: 350,
        width: 300,
        height: 160,
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      windows.push(window);
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      await window.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body><label>R1 read-only body <input readonly aria-label="R1 Fixture Body" value="${manifest[`${kind}Marker`]}"></label></body></html>`)}`,
      );
      window.setTitle("Zody R1 Read Fixture");
      window.showInactive();
      const match = /^window:(\d+):\d+$/.exec(window.getMediaSourceId());
      const id = Number(match?.[1]);
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error("CGWindowID missing");
      manifest[`${kind}Window`] = id;
      window.on("closed", () => {
        if (complete) app.quit();
      });
    }
    if (manifest.targetWindow === manifest.siblingWindow) throw new Error("Duplicate windows");
    const temporary = resolve(directory, "manifest.tmp");
    await writeFile(temporary, JSON.stringify(manifest), { flag: "wx" });
    await rename(temporary, resolve(directory, "manifest.json"));
    complete = true;
  })
  .catch(() => app.exit(1));
