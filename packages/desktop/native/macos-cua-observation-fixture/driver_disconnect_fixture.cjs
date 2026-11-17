const { app, BrowserWindow } = require("electron");
const { writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const dir = process.env.R1_DRIVER_FIXTURE_DIR;
app.setPath("userData", join(dir, "profile"));
app.commandLine.appendSwitch("remote-debugging-port", process.env.R1_DRIVER_REAL_PORT);
const addon = require(process.env.R1_DRIVER_ORIGIN_ADDON);
app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  void writeFile(join(dir, "quit.json"), addon.readQuitOrigin());
});
app.whenReady().then(async () => {
  const w = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await w.loadURL(
    "data:text/html,<title>R1 driver disconnect regression</title><p>Controlled fixture. No input needed.</p>",
  );
  w.showInactive();
  const signalProbe = JSON.parse(addon.installSignalObserver(join(dir, "signals.bin")));
  await writeFile(
    join(dir, "ready.json"),
    JSON.stringify({
      pid: process.pid,
      executable: process.execPath,
      signalProbe,
      profile: app.getPath("userData"),
    }),
  );
});
