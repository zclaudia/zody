"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("controlledFixture", {
  press: () => ipcRenderer.send("controlled-press"),
  value: (value) => {
    if (typeof value === "string" && /^E2E_R2_VALUE_\d+$/.test(value))
      ipcRenderer.send("controlled-value", value);
  },
});
