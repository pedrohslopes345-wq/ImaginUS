const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("native", {
  onHotkey: (callback) => ipcRenderer.on("hotkey", () => callback()),
  onUpdateReady: (callback) => ipcRenderer.on("update:ready", (_e, version) => callback(version)),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setHotkey: (accelerator) => ipcRenderer.invoke("settings:setHotkey", accelerator),
  setAutostart: (enabled) => ipcRenderer.invoke("settings:setAutostart", enabled),
  checkForUpdate: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.send("update:install"),
  setTrayStatus: (text) => ipcRenderer.send("tray:status", text),
  showWindow: () => ipcRenderer.send("window:show"),
});
