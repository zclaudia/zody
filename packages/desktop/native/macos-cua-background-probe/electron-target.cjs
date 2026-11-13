'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const directory = args[0];
if (args.length !== 1 || !path.isAbsolute(directory) || !fs.statSync(directory).isDirectory()) {
  throw new Error('expected an existing absolute run directory');
}
const parent = process.ppid;
const state = { pid: process.pid, targetWindow: 0, siblingWindow: 0, targetClicks: 0, siblingClicks: 0, targetValue: '', siblingValue: '' };
const windows = new Map();
const ownedWindows = [];
let ready = false;
let dirty = false;
let writing;
let lastSnapshot;
let stopping = false;
function flush() {
  if (!ready) return Promise.resolve();
  dirty = true;
  if (writing) return writing;
  writing = (async () => {
    while (dirty) {
      dirty = false;
      const snapshot = JSON.stringify(state);
      if (snapshot === lastSnapshot) continue;
      const temporary = path.join(directory, `target.json.${process.pid}.tmp`);
      await fsp.writeFile(temporary, snapshot);
      await fsp.rename(temporary, path.join(directory, 'target.json'));
      lastSnapshot = snapshot;
    }
  })().catch((error) => { console.error('fixture state write failed', error); app.exit(1); })
    .finally(() => { writing = undefined; });
  return writing;
}
async function stop() {
  if (stopping) return;
  stopping = true;
  await flush();
  app.exit(0);
}
function windowId(window) {
  // Electron's bundled API definition documents this macOS component as CGWindowID.
  const match = /^window:(\d+):\d+$/.exec(window.getMediaSourceId());
  const id = match && Number(match[1]);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('invalid CGWindowID');
  return id;
}
ipcMain.on('probe-effect', (event, effect, value) => {
  const name = windows.get(event.sender.id);
  if (!name || stopping) return;
  if (effect === 'click') state[`${name}Clicks`]++;
  else if (effect === 'value' && typeof value === 'string') state[`${name}Value`] = value;
  else return;
  void flush();
});
const html = '<!doctype html><html><body><button aria-label="Probe Button">Probe Button</button><label>Probe Field <input aria-label="Probe Field"></label></body></html>';
app.whenReady().then(async () => {
  // This fixture explicitly opts Chromium into accessibility; positive results
  // establish behavior under that condition, not for every Electron application.
  app.setAccessibilitySupportEnabled(true);
  for (const [index, name] of ['target', 'sibling'].entries()) {
    const window = new BrowserWindow({ title: 'Background AX Probe', x: 80 + index * 330, y: 350, width: 300, height: 150, show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'electron-preload.cjs') } });
    ownedWindows.push(window);
    windows.set(window.webContents.id, name);
    window.on('closed', () => { void stop(); });
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    window.setTitle('Background AX Probe');
    window.showInactive();
    state[`${name}Window`] = windowId(window);
  }
  if (state.targetWindow === state.siblingWindow) throw new Error('duplicate CGWindowID');
  ready = true; await flush();
  setInterval(() => { if (process.ppid !== parent) void stop(); }, 250).unref();
}).catch((error) => { console.error(error); app.exit(1); });
