"use strict";
const { app, BrowserWindow, ipcMain } = require("electron");
const { writeFile, rename, stat, mkdir } = require("node:fs/promises");
const { resolve, isAbsolute } = require("node:path");
const { createWriteBarrier } = require("./write_electron_barrier.cjs");
const directory = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
if (!directory || !isAbsolute(directory)) throw new Error("Expected exact absolute run directory");
const windows = new Map();
const openWindows = [];
app.commandLine.appendSwitch("user-data-dir", resolve(directory, "electron-data"));
const initial = () => ({ presses: 0, requests: 0, value: "E2E_R2_INITIAL", ignoreEffects: false });
const manifest = {
  fixtureKind: "controlled-ax-write-v1",
  appKind: "electron",
  pid: process.pid,
  title: "Zody R2 Controlled Fixture",
  targetMarker: "E2E_R2_TARGET_BODY",
  siblingMarker: "E2E_R2_SIBLING_BODY",
  target: initial(),
  sibling: initial(),
};
manifest.target.ignoreEffects = process.argv.includes("--ignore-effects");
manifest.barrierEnabled = process.argv.includes("--barrier");
const barrier = manifest.barrierEnabled ? createWriteBarrier(directory) : null;
if (barrier) manifest.barrierNonce = barrier.nonce;
let writes = Promise.resolve();
function save() {
  const immutable = JSON.stringify(manifest);
  // 单一业务 owner 的有序不可变投影；较旧的异步写不能覆盖后来的模型。
  writes = writes
    .then(async () => {
      await writeFile(resolve(directory, "manifest.tmp"), immutable, { mode: 0o600 });
      await rename(resolve(directory, "manifest.tmp"), resolve(directory, "manifest.json"));
    })
    .catch(() => app.exit(1));
}
ipcMain.on("controlled-press", async (event) => {
  const kind = windows.get(event.sender.id);
  if (!kind) return;
  const model = manifest[kind];
  model.requests += 1;
  const released = kind !== "target" || !barrier || (await barrier.wait());
  if (released && !model.ignoreEffects) model.presses += 1;
  save();
});
ipcMain.on("controlled-value", async (event, value) => {
  const kind = windows.get(event.sender.id);
  if (!kind || typeof value !== "string" || !/^E2E_R2_VALUE_\d+$/.test(value)) return;
  const model = manifest[kind];
  if (model.lastInput === value) return;
  // input/change 可由同一真实赋值产生，只保留一次业务接纳。
  Object.defineProperty(model, "lastInput", {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  model.requests += 1;
  const released = kind !== "target" || !barrier || (await barrier.wait());
  if (released && !model.ignoreEffects) model.value = value;
  save();
});
app
  .whenReady()
  .then(async () => {
    if (!(await stat(directory)).isDirectory()) throw new Error("Run directory missing");
    await mkdir(resolve(directory, "electron-data"), { recursive: true });
    app.setPath("userData", resolve(directory, "electron-data"));
    app.setAccessibilitySupportEnabled(true);
    for (const [index, kind] of ["target", "sibling"].entries()) {
      const window = new BrowserWindow({
        title: manifest.title,
        x: 80 + index * 330,
        y: 350,
        width: 310,
        height: 220,
        show: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          preload: resolve(__dirname, "write_electron_preload.cjs"),
        },
      });
      openWindows.push(window);
      windows.set(window.webContents.id, kind);
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      await window.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body>
      <p>${manifest[kind + "Marker"]}</p><button id="press">R2 Press</button>
      <input id="value" aria-label="E2E_R2_VALUE" value="E2E_R2_INITIAL">
      <script>document.querySelector('#press').addEventListener('click',()=>window.controlledFixture.press());
      for(const event of ['input','change'])document.querySelector('#value').addEventListener(event,e=>window.controlledFixture.value(e.target.value));</script>
      </body></html>`)}`,
      );
      window.setTitle(manifest.title);
      window.showInactive();
      const id = Number(/^window:(\d+):\d+$/.exec(window.getMediaSourceId())?.[1]);
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error("CGWindowID missing");
      manifest[kind + "Window"] = id;
      window.on("closed", () => app.quit());
    }
    if (manifest.targetWindow === manifest.siblingWindow) throw new Error("Duplicate windows");
    save();
  })
  .catch(() => app.exit(1));
