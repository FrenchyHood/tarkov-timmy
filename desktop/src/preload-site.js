// Bridge between the Tarkov Timmy website and the desktop app. The main process only answers
// requests coming from the configured server's origin.
const { contextBridge, ipcRenderer } = require("electron");

const role = (process.argv.find((a) => a.startsWith("--timmy-role=")) || "").split("=")[1] || "main";

contextBridge.exposeInMainWorld("timmyDesktop", {
  role,
  identity: () => ipcRenderer.invoke("timmy:identity"),
  status: () => ipcRenderer.invoke("timmy:status"),
  onStatus: (cb) => ipcRenderer.on("timmy:status", (_e, s) => cb(s)),
  onOverlay: (cb) => ipcRenderer.on("timmy:overlay", (_e, s) => cb(s)),
  notify: (title, body) => ipcRenderer.send("timmy:notify", { title, body }),
  openSettings: () => ipcRenderer.send("timmy:open-settings"),
  toggleOverlay: () => ipcRenderer.send("timmy:toggle-overlay"),
  toggleClickThrough: () => ipcRenderer.send("timmy:toggle-click-through"),
  setOpacity: (v) => ipcRenderer.send("timmy:set-opacity", Number(v)),
});
