const status = document.getElementById("status");
const camera = document.getElementById("camera");
const cameraStatus = document.getElementById("camera-status");
const startButton = document.getElementById("start-camera");
const stopButton = document.getElementById("stop-camera");

let cameraStream = null;

status.textContent = window.proctor.getAppStatus();

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
  } catch (error) {
    cameraStream = null;

    const messages = {
      NotAllowedError: "Camera access denied. Check macOS permissions.",
      NotFoundError: "No camera found.",
      NotReadableError: "Camera is busy or unavailable.",
    };

    cameraStatus.textContent =
      messages[error.name] || `Camera failed: ${error.message}`;

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
  startButton.disabled = false;
  stopButton.disabled = true;
});



const startMonitoringButton =
  document.getElementById("start-monitoring");

const stopMonitoringButton =
  document.getElementById("stop-monitoring");

const monitoringStatus =
  document.getElementById("monitoring-status");

let monitoringActive = false;
let microphoneStream = null;
let audioContext = null;
let audioTimer = null;
let lastSoundEvent = 0;

async function startMicrophoneMonitoring() {
  microphoneStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: false,
  });

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
    if (rms > 0.06 && now - lastSoundEvent > 10000) {
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
}

startMonitoringButton.addEventListener("click", async () => {
  startMonitoringButton.disabled = true;
  monitoringStatus.textContent = "Starting monitoring...";

  try {
    await startMicrophoneMonitoring();
    await window.proctor.startMonitoring();

    monitoringActive = true;
    monitoringStatus.textContent = "Monitoring is active";
    stopMonitoringButton.disabled = false;
  } catch (error) {
    monitoringActive = false;
    stopMicrophoneMonitoring();

    monitoringStatus.textContent =
      `Could not start monitoring: ${error.message}`;

    console.error("Monitoring error:", error);
  } finally {
    startMonitoringButton.disabled = monitoringActive;
  }
});

stopMonitoringButton.addEventListener("click", async () => {
  monitoringActive = false;
  stopMicrophoneMonitoring();

  try {
    await window.proctor.stopMonitoring();
    monitoringStatus.textContent = "Monitoring is stopped";
  } catch (error) {
    monitoringStatus.textContent = "Error stopping monitoring";
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

