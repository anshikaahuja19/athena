const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("proctor", {
  getAppStatus: () => "Electron is running",
});
