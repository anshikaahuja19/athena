const { app, BrowserWindow, ipcMain, desktopCapturer, globalShortcut, } = require("electron");
const path = require("path");
let mainWindow;
let monitoring = false;
let screenshotTimer = null;
let examLocked = false;

// Kiosk mode on macOS hides the Dock and menu bar and disables
// Cmd+Tab, Force Quit and hiding the app.
function lockExam() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  examLocked = true;
  mainWindow.setKiosk(true);
  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.focus();
}

function unlockExam() {
  examLocked = false;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  mainWindow.setAlwaysOnTop(false);
  mainWindow.setVisibleOnAllWorkspaces(false);
  mainWindow.setKiosk(false);
}

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

  // Never allow the page to open extra windows.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // While the exam is locked, keep the window open, full screen and visible.
  mainWindow.on("close", (event) => {
    if (examLocked) event.preventDefault();
  });

  mainWindow.on("leave-full-screen", () => {
    if (examLocked) mainWindow.setKiosk(true);
  });

  mainWindow.on("minimize", () => {
    if (examLocked) mainWindow.restore();
  });

  // Block reload, DevTools, close, minimize and hide shortcuts while locked.
  // DevTools would let the page call window.close(), which skips "close".
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (!examLocked) return;

    const key = input.key.toLowerCase();
    const command = input.meta || input.control;

    if (command && ["r", "w", "m", "h", "i", "j"].includes(key)) {
      event.preventDefault();
    }

    if (key === "f5" || key === "f12") event.preventDefault();
  });

  mainWindow.webContents.on("devtools-opened", () => {
    if (examLocked) mainWindow.webContents.closeDevTools();
  });

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
    // If the window is destroyed anyway, don't leave quitting blocked.
    examLocked = false;
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



ipcMain.handle("exam:lock", () => {
  lockExam();
  return { success: examLocked };
});

ipcMain.handle("exam:end", () => {
  unlockExam();
  app.quit();
  return { success: true };
});

// Blocks Cmd+Q and the Quit menu item while the exam is locked.
app.on("before-quit", (event) => {
  if (examLocked) event.preventDefault();
});

app.whenReady().then(() => {
  createWindow();

  // Developer escape hatch so testing never leaves you stuck in kiosk mode.
  // Only registered when running from source, not in a packaged build.
  if (!app.isPackaged) {
    globalShortcut.register("CommandOrControl+Shift+Alt+U", unlockExam);
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

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
