const camera = document.getElementById("camera");
const cameraStatus = document.getElementById("camera-status");
const startButton = document.getElementById("start-camera");
const stopButton = document.getElementById("stop-camera");

let cameraStream = null;

const screens = {
  details: document.getElementById("screen-details"),
  proctoring: document.getElementById("screen-proctoring"),
  exam: document.getElementById("screen-exam"),
  result: document.getElementById("screen-result"),
};

const endExamButton = document.getElementById("end-exam");
const nextToExamButton = document.getElementById("next-to-exam");
const submitExamButton = document.getElementById("submit-exam");
const readinessHint = document.getElementById("readiness-hint");

let currentScreen = "details";

function showScreen(name) {
  currentScreen = name;

  for (const [screenName, element] of Object.entries(screens)) {
    element.hidden = screenName !== name;
  }

  // Finishing the exam is the only way out, so End Exam appears
  // on the result screen and nowhere earlier.
  endExamButton.hidden = name !== "result";
}

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
  updateReadiness();
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

// Screen Capture is deliberately not required: it stays "Waiting" until
// a violation triggers the first capture, so waiting on it would never
// let anyone through.
const REQUIRED_HEALTH = {
  camera: "camera",
  microphone: "microphone",
  monitoring: "monitoring",
  detection: "object detection",
};

function updateReadiness() {
  const pending = Object.entries(REQUIRED_HEALTH)
    .filter(([component]) => healthStates[component] !== "healthy")
    .map(([, label]) => label);

  nextToExamButton.disabled = pending.length > 0;

  readinessHint.textContent = pending.length
    ? `Waiting for: ${pending.join(", ")}`
    : "Proctoring is ready.";
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
const detailsForm = document.getElementById("details-form");
const candidateName = document.getElementById("candidate-name");
const candidateUrn = document.getElementById("candidate-urn");
const detailsError = document.getElementById("details-error");
const startTestButton = document.getElementById("start-test");

// Mirrors the rule the backend enforces, so the candidate is told
// before the request is made.
const URN_PATTERN = /^[A-Za-z0-9/-]{3,40}$/;

function showDetailsError(message) {
  detailsError.textContent = message;
  detailsError.hidden = false;
}

detailsForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = candidateName.value.trim();
  const urn = candidateUrn.value.trim();

  if (!name) {
    showDetailsError("Enter your full name.");
    return;
  }

  if (!URN_PATTERN.test(urn)) {
    showDetailsError(
      "Enter a valid URN: 3 to 40 letters, digits, hyphens or slashes."
    );
    return;
  }

  detailsError.hidden = true;
  startTestButton.disabled = true;
  startTestButton.textContent = "Starting...";

  const result = await window.proctor.startExam({ name, urn });

  startTestButton.disabled = false;
  startTestButton.textContent = "Start Test";

  if (!result.success) {
    showDetailsError(result.message);
    return;
  }

  instructionsOverlay.hidden = false;
});

startTestButton.disabled = false;

const examStatus = document.getElementById("exam-status");
const examError = document.getElementById("exam-error");
const questionList = document.getElementById("question-list");
const resultSummary = document.getElementById("result-summary");
const resultBreakdown = document.getElementById("result-breakdown");

// Short names for the result screen. The sentences in warningMessages
// are written to warn a candidate, not to summarise afterwards.
const violationLabels = {
  focus: "Left the window",
  audio: "Loud sound",
  camera: "Camera stopped",
  "multiple-people": "Another person seen",
  "object-cell-phone": "Phone seen",
  "object-book": "Book seen",
  "object-laptop": "Second screen seen",
};

let examQuestions = [];

// Question id to the option index the server has accepted, so a
// rejected change can be rolled back on screen.
const acceptedAnswers = new Map();

function showExamError(message) {
  examError.textContent = message;
  examError.hidden = false;
}

function updateExamProgress() {
  const total = examQuestions.length;
  const answered = acceptedAnswers.size;

  examStatus.textContent =
    `Answered ${answered} of ${total}. ` +
    "You can change an answer until you submit.";

  submitExamButton.disabled = total === 0 || answered < total;
}

// Puts the radios back to the last answer the server accepted.
function restoreSelection(questionId, inputs) {
  const accepted = acceptedAnswers.get(questionId);

  inputs.forEach((input) => {
    input.checked = accepted !== undefined && Number(input.value) === accepted;
  });
}

async function sendAnswer(questionId, selectedAnswer, item) {
  const inputs = item.querySelectorAll("input[type=radio]");

  // Locked only while the answer is in flight, so a quick second
  // click cannot overtake the first.
  inputs.forEach((input) => {
    input.disabled = true;
  });

  const result = await window.proctor.submitAnswer({
    questionId,
    selectedAnswer,
  });

  inputs.forEach((input) => {
    input.disabled = false;
  });

  if (!result.success) {
    // Never leave a selection showing that the server did not take.
    restoreSelection(questionId, inputs);
    showExamError(result.message);
    return;
  }

  examError.hidden = true;
  item.classList.add("answered");
  acceptedAnswers.set(questionId, selectedAnswer);
  updateExamProgress();
}

function renderQuestions() {
  questionList.replaceChildren();

  for (const question of examQuestions) {
    const item = document.createElement("li");
    item.className = "question";

    const text = document.createElement("p");
    text.className = "question-text";
    text.textContent = question.question;
    item.appendChild(text);

    question.options.forEach((option, index) => {
      const label = document.createElement("label");
      label.className = "option";

      const input = document.createElement("input");
      input.type = "radio";
      input.name = `question-${question.id}`;
      input.value = String(index);

      input.addEventListener("change", () => {
        sendAnswer(question.id, index, item);
      });

      const optionText = document.createElement("span");
      optionText.textContent = option;

      label.append(input, optionText);
      item.appendChild(label);
    });

    questionList.appendChild(item);
  }

  updateExamProgress();
}

async function loadQuestions() {
  examError.hidden = true;
  examStatus.textContent = "Loading questions...";

  const result = await window.proctor.getQuestions();

  if (!result.success) {
    examStatus.textContent = "Questions could not be loaded.";
    showExamError(result.message);
    return;
  }

  examQuestions = result.questions;
  renderQuestions();
}

function addResultRow(label, value) {
  const row = document.createElement("div");
  row.className = "health-row";

  const name = document.createElement("span");
  name.textContent = label;

  const amount = document.createElement("span");
  amount.className = "result-value";
  amount.textContent = value;

  row.append(name, amount);
  resultBreakdown.appendChild(row);
}

function renderResult(result, violations) {
  resultSummary.textContent =
    `You scored ${result.correct} out of ${result.total}.`;

  resultBreakdown.replaceChildren();

  addResultRow("Attempted", `${result.attempted} of ${result.total}`);
  addResultRow("Correct", String(result.correct));
  addResultRow("Wrong", String(result.wrong));

  const counts = {};

  for (const violation of violations) {
    counts[violation.type] = (counts[violation.type] || 0) + 1;
  }

  const recorded = Object.entries(counts);

  if (!recorded.length) {
    addResultRow("Violations", "None");
    return;
  }

  for (const [type, count] of recorded) {
    addResultRow(violationLabels[type] ?? type, String(count));
  }
}

nextToExamButton.addEventListener("click", () => {
  showScreen("exam");
  loadQuestions();
});

submitExamButton.addEventListener("click", async () => {
  submitExamButton.disabled = true;
  submitExamButton.textContent = "Submitting...";

  const result = await window.proctor.submitExam();

  submitExamButton.textContent = "Submit Test";

  if (!result.success) {
    submitExamButton.disabled = false;
    showExamError(result.message);
    return;
  }

  renderResult(result.result, result.violations);
  showScreen("result");
});

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
    showScreen("proctoring");
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

  // Every violation type reaches the examiner's record through here.
  // Not awaited: a slow server must not hold up the warning.
  window.proctor.reportViolation({
    type: violation,
    detail: `Seen on the ${currentScreen} screen`,
  });
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

