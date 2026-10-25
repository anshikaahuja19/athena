const fs = require("fs/promises");
const { app, BrowserWindow, ipcMain, desktopCapturer, globalShortcut, } = require("electron");
const path = require("path");
let mainWindow;
let monitoring = false;
let examLocked = false;
let lastScreenshotAt = 0;
const SCREENSHOT_COOLDOWN_MS = 3000;

const BACKEND_URL = process.env.ATHENA_BACKEND_URL || "http://localhost:6002";

// The session id stays in the main process. The page never receives it,
// so page code cannot post answers or results on its own.
let examSession = null;

async function backendRequest(pathname, options = {}) {
  let response;

  try {
    response = await fetch(`${BACKEND_URL}${pathname}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
  } catch (error) {
    console.error("Backend unreachable:", error.message);
    throw new Error(
      "Cannot reach the exam server. Check that it is running."
    );
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.message || `Request failed (${response.status})`);
  }

  return payload;
}
ipcMain.handle("evidence:save-webcam", async (event, evidence) => {
  // Accept evidence only from this app's renderer.
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("Unauthorized evidence request");
  }

  if (!monitoring) {
    throw new Error("Monitoring is not active");
  }

  if (
    !evidence ||
    typeof evidence.reason !== "string" ||
    typeof evidence.imageData !== "string" ||
    !evidence.imageData.startsWith("data:image/jpeg;base64,")
  ) {
    throw new Error("Invalid webcam evidence");
  }

  const base64Image = evidence.imageData.slice(
    "data:image/jpeg;base64,".length
  );

  // Reject unusually large images.
  if (base64Image.length > 10 * 1024 * 1024) {
    throw new Error("Webcam image is too large");
  }

  const imageBuffer = Buffer.from(base64Image, "base64");

  if (imageBuffer.length === 0) {
    throw new Error("Webcam image is empty");
  }

  const timestamp = new Date().toISOString();
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  const safeReason = evidence.reason.replace(/[^a-z0-9-]/gi, "-");

  const evidenceDir = path.join(
    app.getPath("documents"),
    "Athena Proctor Evidence"
  );

  await fs.mkdir(evidenceDir, {
    recursive: true,
    mode: 0o700,
  });

  const fileName = `webcam-${safeTimestamp}-${safeReason}.jpg`;
  const filePath = path.join(evidenceDir, fileName);

  await fs.writeFile(filePath, imageBuffer, {
    mode: 0o600,
    flag: "wx",
  });



  return { success: true };
});

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



async function captureScreenshot(reason) {
  if (!monitoring) return;

  const now = Date.now();

  // Prevent duplicate screenshots within 3 seconds.
  if (now - lastScreenshotAt < SCREENSHOT_COOLDOWN_MS) {
    return;
  }

  lastScreenshotAt = now;

  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1280, height: 720 },
    });

    if (!monitoring || sources.length === 0) return;

    const timestamp = new Date().toISOString();
    const safeTimestamp = timestamp.replace(/[:.]/g, "-");

    const evidenceDir = path.join(
      app.getPath("documents"),
      "Athena Proctor Evidence"
    );

    await fs.mkdir(evidenceDir, {
      recursive: true,
      mode: 0o700,
    });

    const safeReason = reason.replace(/[^a-z0-9-]/gi, "-");

    const fileName =
      `screenshot-${safeTimestamp}-${safeReason}.png`;

    const filePath = path.join(evidenceDir, fileName);

    const imageBuffer = sources[0].thumbnail.toPNG();

    await fs.writeFile(filePath, imageBuffer, {
      mode: 0o600,
    });

    // Send only a general status event to the UI.
    sendEvent("screenshot", "Screen snapshot saved");


  } catch (error) {
    console.error("Screen capture failed:", error.message);
    sendEvent("error", `Screen capture failed: ${error.message}`);
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
      sendEvent(
        "focus",
        "Athena Proctor window lost focus",
        { violation: "focus" }
      );

      captureScreenshot("focus-loss");
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

    mainWindow = null;
  });
}


ipcMain.handle("monitoring:start", async () => {
  if (monitoring) return { success: true };

  monitoring = true;
  lastScreenshotAt = 0;

  sendEvent("session", "Monitoring session started");

  return { success: true };
});

ipcMain.handle("monitoring:stop", () => {
  monitoring = false;


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
    captureScreenshot("loud-sound");
  }

  return { success: true };
});



ipcMain.handle("exam:start", async (event, details) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    return { success: false, message: "Unauthorized request" };
  }

  const body = details ?? {};

  try {
    const result = await backendRequest("/exam/start", {
      method: "POST",
      body: JSON.stringify({ name: body.name, urn: body.urn }),
    });

    examSession = {
      sessionId: result.sessionId,
      name: result.name,
      urn: result.urn,
    };

    return { success: true, name: result.name, urn: result.urn };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle("exam:questions", async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    return { success: false, message: "Unauthorized request" };
  }

  if (!examSession) {
    return { success: false, message: "No active exam session" };
  }

  try {
    const questions = await backendRequest("/exam/mcq");
    return { success: true, questions };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle("exam:answer", async (event, answer) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    return { success: false, message: "Unauthorized request" };
  }

  if (!examSession) {
    return { success: false, message: "No active exam session" };
  }

  const body = answer ?? {};

  try {
    const result = await backendRequest("/exam/answer", {
      method: "POST",
      body: JSON.stringify({
        sessionId: examSession.sessionId,
        questionId: body.questionId,
        selectedAnswer: body.selectedAnswer,
      }),
    });

    return { success: true, attempted: result.attempted };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle("exam:submit", async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    return { success: false, message: "Unauthorized request" };
  }

  if (!examSession) {
    return { success: false, message: "No active exam session" };
  }

  try {
    const submitted = await backendRequest("/exam/submit", {
      method: "POST",
      body: JSON.stringify({ sessionId: examSession.sessionId }),
    });

    // The submit reply only counts violations. Read the session back
    // for the breakdown by type shown on the result screen.
    let violations = [];

    try {
      const session = await backendRequest(
        `/exam/session/${examSession.sessionId}`
      );

      violations = session.violations ?? [];
    } catch (error) {
      console.error("Could not read violation detail:", error.message);
    }

    return { success: true, result: submitted.result, violations };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle("exam:violation", async (event, violation) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    return { success: false, message: "Unauthorized request" };
  }

  if (!examSession) {
    return { success: false, message: "No active exam session" };
  }

  const body = violation ?? {};

  try {
    const result = await backendRequest("/exam/violation", {
      method: "POST",
      body: JSON.stringify({
        sessionId: examSession.sessionId,
        type: body.type,
        detail: body.detail,
      }),
    });

    return { success: true, violations: result.violations };
  } catch (error) {
    // A lost violation must never interrupt the exam.
    console.error("Could not record violation:", error.message);
    return { success: false, message: error.message };
  }
});

ipcMain.handle("exam:lock", () => {
  lockExam();
  return { success: examLocked };
});

ipcMain.handle("exam:end", () => {
  examSession = null;
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
