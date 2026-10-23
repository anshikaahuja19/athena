const { contextBridge,ipcRenderer  } = require("electron");

contextBridge.exposeInMainWorld("proctor", {
  getAppStatus: () => "Electron is running",

  startMonitoring: () =>
    ipcRenderer.invoke("monitoring:start"),

  stopMonitoring: () =>
    ipcRenderer.invoke("monitoring:stop"),

  lockExam: () =>
    ipcRenderer.invoke("exam:lock"),

  endExam: () =>
    ipcRenderer.invoke("exam:end"),

  reportSoundActivity: () =>
    ipcRenderer.invoke("monitoring:sound-activity"),
  
  saveWebcamEvidence: (evidence) =>
  ipcRenderer.invoke("evidence:save-webcam", evidence),

  onEvent: (callback) => {
    const listener = (_event, data) => callback(data);

    ipcRenderer.on("monitoring:event", listener);

    return () => {
      ipcRenderer.removeListener("monitoring:event", listener);
    };
  },
});
