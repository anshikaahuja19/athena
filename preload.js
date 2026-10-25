const { contextBridge,ipcRenderer  } = require("electron");

contextBridge.exposeInMainWorld("proctor", {
  startMonitoring: () =>
    ipcRenderer.invoke("monitoring:start"),

  stopMonitoring: () =>
    ipcRenderer.invoke("monitoring:stop"),

  startExam: (details) =>
    ipcRenderer.invoke("exam:start", details),

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
