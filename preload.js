const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  minimize:       () => ipcRenderer.send("win-minimize"),
  maximize:       () => ipcRenderer.send("win-maximize"),
  close:          () => ipcRenderer.send("win-close"),
  shutdown:       () => ipcRenderer.send("win-shutdown"),
  restart:        () => ipcRenderer.send("win-restart"),
  checkForUpdate: () => ipcRenderer.send("updater-check"),
  installUpdate:  () => ipcRenderer.send("updater-install-now"),
  onUpdateAvailable: (cb) => ipcRenderer.on("update-available",  (_e, info)     => cb(info)),
  onUpdateProgress:  (cb) => ipcRenderer.on("update-progress",   (_e, progress) => cb(progress)),
  onUpdateDownloaded:(cb) => ipcRenderer.on("update-downloaded",  (_e, info)     => cb(info)),
  onUpdateError:     (cb) => ipcRenderer.on("update-error",       (_e, msg)      => cb(msg)),
});
