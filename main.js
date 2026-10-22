const { app, BrowserWindow, ipcMain, desktopCapturer, } = require("electron");
const path = require("path");
let mainWindow;
let monitoring = false;
let screenshotTimer = null;

function sendEvent(type, message, extra = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  mainWindow.webContents.send("monitoring:event", {
    type,
    message,
    timestamp: new Date().toISOString(),
    ...extra,
  });
}

async function captureScreenshot() {
  if (!monitoring) return;

  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1280, height: 720 },
    });

    if (!monitoring || sources.length === 0) return;

    sendEvent("screenshot", "Screen snapshot captured", {
      image: sources[0].thumbnail.toDataURL(),
    });
  } catch (error) {
    console.error("Screen capture failed:", error.message);
    sendEvent("error", "Screen capture failed");
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });



  mainWindow.loadFile(path.join(__dirname, "src", "index.html"));

  mainWindow.on("blur", () => {
    if (monitoring) {
      sendEvent("focus", "Athena Proctor window lost focus", {
        violation: "focus",
      });
    }
  });

  mainWindow.on("focus", () => {
    if (monitoring) {
      sendEvent("focus", "Athena Proctor window regained focus");
    }
  });

  mainWindow.on("closed", () => {
    monitoring = false;
    clearInterval(screenshotTimer);
    screenshotTimer = null;
    mainWindow = null;
  });
}


ipcMain.handle("monitoring:start", async () => {
  if (monitoring) return { success: true };

  monitoring = true;
  sendEvent("session", "Monitoring session started");

  await captureScreenshot();

  if (monitoring) {
    screenshotTimer = setInterval(captureScreenshot, 15000);
  }

  return { success: true };
});

ipcMain.handle("monitoring:stop", () => {
  monitoring = false;
  clearInterval(screenshotTimer);
  screenshotTimer = null;

  sendEvent("session", "Monitoring session stopped");

  return { success: true };
});

ipcMain.handle("monitoring:sound-activity", () => {
  if (monitoring) {
    sendEvent(
      "audio",
      "Sound activity detected — review required",
      { violation: "audio" }
    );
  }

  return { success: true };
});



app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
