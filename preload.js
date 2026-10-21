const { contextBridge,ipcRenderer  } = require("electron");

contextBridge.exposeInMainWorld("proctor", {
  getAppStatus: () => "Electron is running",

  startMonitoring: () =>
    ipcRenderer.invoke("monitoring:start"),

  stopMonitoring: () =>
    ipcRenderer.invoke("monitoring:stop"),

  reportSoundActivity: () =>
    ipcRenderer.invoke("monitoring:sound-activity"),

  onEvent: (callback) => {
    const listener = (_event, data) => callback(data);

    ipcRenderer.on("monitoring:event", listener);

    return () => {
      ipcRenderer.removeListener("monitoring:event", listener);
    };
  },
});
