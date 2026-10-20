const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getSummary: () => ipcRenderer.invoke("get-summary"),
  saveConfig: (cfg) => ipcRenderer.invoke("save-config", cfg),
  testConnection: (creds) => ipcRenderer.invoke("test-connection", creds),
  connectRouter: (creds) => ipcRenderer.invoke("connect-router", creds),
  disconnect: () => ipcRenderer.invoke("disconnect"),
  refreshNow: () => ipcRenderer.invoke("refresh-now"),
  quitApp: () => ipcRenderer.invoke("quit-app"),
  minimizeWindow: () => ipcRenderer.invoke("minimize-window"),
  closeWindow: () => ipcRenderer.invoke("close-window"),
  setDeviceNickname: (mac, nickname) => ipcRenderer.invoke("set-device-nickname", { mac, nickname }),
  onSummaryUpdate: (callback) => {
    ipcRenderer.on("summary-update", (_event, data) => callback(data));
  },
});
