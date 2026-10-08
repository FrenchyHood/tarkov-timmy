const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("timmySettings", {
  get: () => ipcRenderer.invoke("settings:get"),
  save: (s) => ipcRenderer.invoke("settings:save", s),
  parseLink: (l) => ipcRenderer.invoke("settings:parse-link", l),
  detectLogs: () => ipcRenderer.invoke("settings:detect-logs"),
  onStatus: (cb) => ipcRenderer.on("settings:status", (_e, s) => cb(s)),
  openExternal: (url) => ipcRenderer.send("settings:open-external", url),
});
