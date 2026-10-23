
const camera = document.getElementById("camera");
const cameraStatus = document.getElementById("camera-status");
const startButton = document.getElementById("start-camera");
const stopButton = document.getElementById("stop-camera");

let cameraStream = null;

const instructionsOverlay = document.getElementById("instructions-overlay");
const fullscreenOverlay = document.getElementById("fullscreen-overlay");
const fullscreenError = document.getElementById("fullscreen-error");
const agreeButton = document.getElementById("agree-instructions");
const enterFullscreenButton = document.getElementById("enter-fullscreen");
const endExamButton = document.getElementById("end-exam");

agreeButton.addEventListener("click", () => {
  instructionsOverlay.hidden = true;
  fullscreenOverlay.hidden = false;
});

enterFullscreenButton.addEventListener("click", async () => {
  enterFullscreenButton.disabled = true;
  fullscreenError.hidden = true;

  try {
    const result = await window.proctor.lockExam();
    if (!result.success) throw new Error("Full screen was not enabled.");

    fullscreenOverlay.hidden = true;
    endExamButton.hidden = false;
  } catch (error) {
    fullscreenError.textContent = `Could not enter full screen: ${error.message}`;
    fullscreenError.hidden = false;
    enterFullscreenButton.disabled = false;
    console.error("Full screen error:", error);
  }
});

endExamButton.addEventListener("click", () => {
  if (confirm("End the exam? You will not be able to return to it.")) {
    window.proctor.endExam();
  }
});

startButton.addEventListener("click", async () => {
  if (cameraStream) return;

  startButton.disabled = true;
  cameraStatus.textContent = "Requesting camera permission...";

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false,
    });

    camera.srcObject = cameraStream;
    await camera.play();

    cameraStatus.textContent = "Camera is active";
    stopButton.disabled = false;
    updateHealth("camera", "healthy", "Active");
  } catch (error) {
    cameraStream = null;

    const messages = {
      NotAllowedError: "Camera access denied. Check macOS permissions.",
      NotFoundError: "No camera found.",
      NotReadableError: "Camera is busy or unavailable.",
    };

    cameraStatus.textContent =
      messages[error.name] || `Camera failed: ${error.message}`;
    updateHealth("camera", "error", "Unavailable");

    console.error("Camera error:", error);
  } finally {
    startButton.disabled = Boolean(cameraStream);
  }
});

stopButton.addEventListener("click", () => {
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }

  camera.srcObject = null;
  cameraStatus.textContent = "Camera stopped";
  updateHealth("camera", "inactive", "Not started");
  startButton.disabled = false;
  stopButton.disabled = true;
});



const startMonitoringButton =
  document.getElementById("start-monitoring");

const stopMonitoringButton =
  document.getElementById("stop-monitoring");

const monitoringStatus =
  document.getElementById("monitoring-status");

const healthElements = {
  app: document.getElementById("health-app"),
  camera: document.getElementById("health-camera"),
  microphone: document.getElementById("health-microphone"),
  monitoring: document.getElementById("health-monitoring"),
  screenshot: document.getElementById("health-screenshot"),
};

const lastScreenshotElement = document.getElementById(
  "health-last-screenshot"
);
const healthSummary = document.getElementById("health-summary");

const healthStates = {
  app: "checking",
  camera: "inactive",
  microphone: "inactive",
  monitoring: "inactive",
  screenshot: "inactive",
};

function updateHealth(component, state, label) {
  const element = healthElements[component];
  if (!element) return;

  healthStates[component] = state;
  element.className = `health-indicator ${state}`;
  element.textContent = label;

  updateHealthSummary();
}

function updateHealthSummary() {
  if (Object.values(healthStates).includes("error")) {
    healthSummary.textContent =
      "Attention required: one or more components have an error.";
    return;
  }

  if (Object.values(healthStates).every(
    (state) => state === "healthy"
  )) {
    healthSummary.textContent =
      "All monitored components are healthy.";
    return;
  }

  healthSummary.textContent =
    "System is running. Some components are inactive or awaiting checks.";
}

// Verify that the renderer can communicate with the Electron preload bridge.
try {
  const appStatus = window.proctor.getAppStatus();

  if (appStatus === "Electron is running") {
    updateHealth("app", "healthy", "Running");
  } else {
    updateHealth("app", "error", "Unexpected response");
  }
} catch (error) {
  updateHealth("app", "error", "Unavailable");
  console.error("Application health check failed:", error);
}


const warningBanner = document.getElementById("warning-banner");
const warningMessage = document.getElementById("warning-message");
const dismissWarningButton = document.getElementById("dismiss-warning");

const warningMessages = {
  focus: "You left the exam window. Stay on this window until the test is finished.",
  audio: "Loud sound detected. Keep your surroundings quiet during the test.",
};

let violationCounts = { focus: 0, audio: 0 };

function showWarning(violation) {
  violationCounts[violation] += 1;

  warningMessage.textContent =
    `Warning ${violationCounts[violation]}: ${warningMessages[violation]} ` +
    "Do not repeat this — it is recorded as a violation.";
  warningBanner.hidden = false;
}

function hideWarning() {
  warningBanner.hidden = true;
}

dismissWarningButton.addEventListener("click", hideWarning);


window.proctor.onEvent((event) => {
  // Keep the existing warning behavior.
  if (event.violation in warningMessages) {
    showWarning(event.violation);
  }

  // A screenshot event means a screenshot was captured.
  if (event.type === "screenshot") {
    updateHealth("screenshot", "healthy", "Captured");

    if (lastScreenshotElement) {
      const time = event.timestamp
        ? new Date(event.timestamp).toLocaleString()
        : "Time unavailable";

      lastScreenshotElement.textContent =
        `Last successful screenshot: ${time}`;
    }
  }

  // Report screenshot capture errors.
  if (
    event.type === "error" &&
    event.message?.includes("Screen capture failed")
  ) {
    updateHealth("screenshot", "error", "Capture failed");
  }
});


let monitoringActive = false;
let microphoneStream = null;
let audioContext = null;
let audioTimer = null;
let lastSoundEvent = 0;

// Volume (RMS, 0–1) above which sound counts as a violation.
const SOUND_THRESHOLD = 0.12;

async function startMicrophoneMonitoring() {
  microphoneStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: false,
  });
  updateHealth("microphone", "healthy", "Active");

  audioContext = new AudioContext();
  await audioContext.resume();

  const source = audioContext.createMediaStreamSource(
    microphoneStream
  );

  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);

  const samples = new Uint8Array(analyser.fftSize);

  audioTimer = setInterval(() => {
    if (!monitoringActive) return;

    analyser.getByteTimeDomainData(samples);

    let sum = 0;

    for (const sample of samples) {
      const value = (sample - 128) / 128;
      sum += value * value;
    }

    const rms = Math.sqrt(sum / samples.length);
    const now = Date.now();

    // Detect sound activity, not speech or cheating.
    if (rms > SOUND_THRESHOLD && now - lastSoundEvent > 10000) {
      lastSoundEvent = now;
      window.proctor.reportSoundActivity();
    }
  }, 1000);
}

function stopMicrophoneMonitoring() {
  clearInterval(audioTimer);
  audioTimer = null;

  if (microphoneStream) {
    microphoneStream.getTracks().forEach((track) => track.stop());
    microphoneStream = null;
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  updateHealth("microphone", "inactive", "Not started");
}


startMonitoringButton.addEventListener("click", async () => {
  const cameraIsActive =
    cameraStream &&
    cameraStream.getVideoTracks().some(
      (track) => track.readyState === "live" && track.enabled
    );

  if (!cameraIsActive) {
    monitoringStatus.textContent =
      "Start the camera before starting monitoring.";
    return;
  }

  startMonitoringButton.disabled = true;
  monitoringStatus.textContent = "Starting monitoring...";
  violationCounts = { focus: 0, audio: 0 };
  hideWarning();

  try {
    await startMicrophoneMonitoring();
    await window.proctor.startMonitoring();

    monitoringActive = true;
    monitoringStatus.textContent = "Monitoring is active";
    stopMonitoringButton.disabled = false;
    updateHealth("monitoring", "healthy", "Active");
  } catch (error) {
    monitoringActive = false;
    stopMicrophoneMonitoring();

    monitoringStatus.textContent =
      `Could not start monitoring: ${error.message}`;
    updateHealth("monitoring", "error", "Failed to start");

    console.error("Monitoring error:", error);
  } finally {
    startMonitoringButton.disabled = monitoringActive;
  }
});

stopMonitoringButton.addEventListener("click", async () => {
  monitoringActive = false;
  stopMicrophoneMonitoring();
  hideWarning();

  try {
    await window.proctor.stopMonitoring();
    monitoringStatus.textContent = "Monitoring is stopped";
    updateHealth("monitoring", "inactive", "Stopped");
  } catch (error) {
    monitoringStatus.textContent = "Error stopping monitoring";
    updateHealth("monitoring", "error", "Stop failed");
    console.error("Stop monitoring error:", error);
  }

  startMonitoringButton.disabled = false;
  stopMonitoringButton.disabled = true;
});



window.addEventListener("beforeunload", () => {
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
  }

  monitoringActive = false;
  stopMicrophoneMonitoring();
});

