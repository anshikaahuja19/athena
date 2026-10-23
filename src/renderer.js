const camera = document.getElementById("camera");
const cameraStatus = document.getElementById("camera-status");
const startButton = document.getElementById("start-camera");
const stopButton = document.getElementById("stop-camera");

let cameraStream = null;

const healthElements = {
  camera: document.getElementById("health-camera"),
  microphone: document.getElementById("health-microphone"),
  monitoring: document.getElementById("health-monitoring"),
  detection: document.getElementById("health-detection"),
  screenshot: document.getElementById("health-screenshot"),
};

const healthSummary = document.getElementById("health-summary");

const healthStates = {
  camera: "inactive",
  microphone: "inactive",
  monitoring: "inactive",
  detection: "inactive",
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

let objectDetectionModel = null;
let detectionActive = false;
let detectionTimer = null;

let personDetectionCount = 0;
let objectDetectionCounts = {};

const DETECTION_INTERVAL_MS = 1000;
const REQUIRED_DETECTIONS = 3;
const DETECTION_COOLDOWN_MS = 10000;

const lastDetectionTime = {};

const MONITORED_OBJECTS = new Set([
  "cell phone",
  "book",
  "laptop",
]);

async function loadObjectDetectionModel() {
  try {
    updateHealth("detection", "checking", "Loading model");

    objectDetectionModel = await cocoSsd.load();

    updateHealth("detection", "inactive", "Ready");

    if (monitoringActive && cameraStream) {
      startObjectDetection();
    }
  } catch (error) {
    console.error("Model loading failed:", error);
    updateHealth("detection", "error", "Unavailable");
  }
}

// Returns true when evidence was captured, false when it was skipped.
function captureWebcamEvidence(reason) {
  if (!cameraStream || !camera.videoWidth || !camera.videoHeight) {
    return false;
  }

  const now = Date.now();

  if (
    lastDetectionTime[reason] &&
    now - lastDetectionTime[reason] < DETECTION_COOLDOWN_MS
  ) {
    return false;
  }

  lastDetectionTime[reason] = now;

  const canvas = document.createElement("canvas");
  canvas.width = camera.videoWidth;
  canvas.height = camera.videoHeight;

  const context = canvas.getContext("2d");
  context.drawImage(camera, 0, 0, canvas.width, canvas.height);

  const imageData = canvas.toDataURL("image/jpeg", 0.85);

  window.proctor.saveWebcamEvidence({
    reason,
    imageData,
  }).catch((error) => {
    console.error("Could not save webcam evidence:", error);
  });

  return true;
}

async function detectUnusualActivity() {
  if (
    !detectionActive ||
    !objectDetectionModel ||
    !cameraStream ||
    camera.readyState < 2
  ) {
    return;
  }

  try {
    const predictions = await objectDetectionModel.detect(camera);

    const people = predictions.filter(
      (prediction) => prediction.class === "person"
        && prediction.score >= 0.65
    );

    if (people.length > 1) {
      personDetectionCount += 1;

      if (personDetectionCount >= REQUIRED_DETECTIONS) {
        if (captureWebcamEvidence("multiple-people")) {
          showWarning("multiple-people");
        }

        personDetectionCount = 0;
      }
    } else {
      personDetectionCount = 0;
    }

    const detectedObjects = predictions.filter(
      (prediction) =>
        MONITORED_OBJECTS.has(prediction.class) &&
        prediction.score >= 0.65
    );

    const currentObjects = new Set(
      detectedObjects.map((prediction) => prediction.class)
    );

    for (const objectName of MONITORED_OBJECTS) {
      if (currentObjects.has(objectName)) {
        objectDetectionCounts[objectName] =
          (objectDetectionCounts[objectName] || 0) + 1;

        if (
          objectDetectionCounts[objectName] >= REQUIRED_DETECTIONS
        ) {
          const reason = `object-${objectName.replace(/ /g, "-")}`;

          if (captureWebcamEvidence(reason)) {
            showWarning(reason);
          }

          objectDetectionCounts[objectName] = 0;
        }
      } else {
        objectDetectionCounts[objectName] = 0;
      }
    }
  } catch (error) {
    console.error("Object detection failed:", error);
  }
}

function startObjectDetection() {
  if (!objectDetectionModel || detectionActive) return;

  detectionActive = true;
  detectionTimer = setInterval(
    detectUnusualActivity,
    DETECTION_INTERVAL_MS
  );

  updateHealth("detection", "healthy", "Active");
}

function stopObjectDetection() {
  detectionActive = false;
  clearInterval(detectionTimer);
  detectionTimer = null;
  personDetectionCount = 0;
  objectDetectionCounts = {};

  // Leave an "Unavailable" model failure showing.
  if (objectDetectionModel) {
    updateHealth("detection", "inactive", "Ready");
  }
}
loadObjectDetectionModel();



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

// A track ends when the camera is unplugged or its permission is revoked.
// Clicking Stop Camera calls track.stop(), which does not fire this.
function handleCameraLost() {
  stopObjectDetection();

  cameraStream = null;
  camera.srcObject = null;
  cameraStatus.textContent = "Camera stopped unexpectedly";
  updateHealth("camera", "error", "Lost");

  startButton.disabled = false;
  stopButton.disabled = true;

  if (monitoringActive) {
    showWarning("camera");
  }
}

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

    cameraStream.getVideoTracks().forEach((track) => {
      track.addEventListener("ended", handleCameraLost);
    });

    cameraStatus.textContent = "Camera is active";
    stopButton.disabled = false;
    updateHealth("camera", "healthy", "Active");
    if (objectDetectionModel && monitoringActive) {
      startObjectDetection();
    }
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
  // The camera must stay on for as long as the exam is monitored.
  if (monitoringActive) {
    cameraStatus.textContent =
      "Stop monitoring before stopping the camera.";
    return;
  }

  stopObjectDetection();
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




const warningBanner = document.getElementById("warning-banner");
const warningMessage = document.getElementById("warning-message");
const dismissWarningButton = document.getElementById("dismiss-warning");

const warningMessages = {
  focus: "You left the exam window. Stay on this window until the test is finished.",
  audio: "Loud sound detected. Keep your surroundings quiet during the test.",
  camera: "The camera stopped during the test. Start it again immediately.",
  "multiple-people":
    "Another person is visible on camera. You must be alone during the test.",
  "object-cell-phone":
    "A phone is visible on camera. Put it out of sight for the rest of the test.",
  "object-book":
    "A book is visible on camera. Remove all study material from view.",
  "object-laptop":
    "A second screen is visible on camera. Remove it from view.",
};

let violationCounts = {};

function showWarning(violation) {
  violationCounts[violation] = (violationCounts[violation] || 0) + 1;

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
    updateHealth("screenshot", "healthy", "Operational");

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
    audioContext.close().catch(() => { });
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
  violationCounts = {};
  hideWarning();

  try {
    await startMicrophoneMonitoring();
    await window.proctor.startMonitoring();

    monitoringActive = true;
    monitoringStatus.textContent = "Monitoring is active";
    stopMonitoringButton.disabled = false;
    stopButton.disabled = true;
    updateHealth("monitoring", "healthy", "Active");
    startObjectDetection();
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
  stopObjectDetection();

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
  stopButton.disabled = !cameraStream;
});



window.addEventListener("beforeunload", () => {
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
  }

  monitoringActive = false;
  stopMicrophoneMonitoring();
});

