const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 6002;

const NAME_MAX_LENGTH = 80;
const URN_PATTERN = /^[A-Za-z0-9/-]{3,40}$/;

app.use(cors());
app.use(express.json());

const questionsPath = path.join(__dirname, "data", "questions.json");
const sessionsPath = path.join(__dirname, "data", "sessions.json");

function readQuestions() {
  return JSON.parse(fs.readFileSync(questionsPath, "utf-8"));
}

// Sessions hold candidate details, so the file is not kept in git.
// It is created on the first write.
function readSessions() {
  if (!fs.existsSync(sessionsPath)) {
    return [];
  }

  return JSON.parse(fs.readFileSync(sessionsPath, "utf-8"));
}

function saveSessions(sessions) {
  fs.writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2));
}

function makeSessionId() {
  return `session-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function readTrimmed(body, field) {
  return typeof body[field] === "string" ? body[field].trim() : "";
}

// Health check, so the desktop app can confirm the backend is up.
app.get("/", (request, response) => {
  response.json({
    message: "Athena exam backend is running",
    questions: readQuestions().length,
    sessions: readSessions().length,
  });
});

// Start a new exam session for one candidate.
app.post("/exam/start", (request, response) => {
  const body = request.body ?? {};

  const name = readTrimmed(body, "name");
  const urn = readTrimmed(body, "urn");

  if (!name || name.length > NAME_MAX_LENGTH) {
    return response.status(400).json({
      message: `Name is required and must be ${NAME_MAX_LENGTH} characters or fewer`,
    });
  }

  if (!URN_PATTERN.test(urn)) {
    return response.status(400).json({
      message: "URN must be 3 to 40 letters, digits, hyphens or slashes",
    });
  }

  const sessions = readSessions();

  const session = {
    sessionId: makeSessionId(),
    name,
    urn,
    startedAt: new Date().toISOString(),
    submittedAt: null,
    status: "in-progress",
    attempted: 0,
    correct: 0,
    wrong: 0,
    answers: [],
  };

  sessions.push(session);
  saveSessions(sessions);

  response.status(201).json({
    message: "Exam session started",
    sessionId: session.sessionId,
    name: session.name,
    urn: session.urn,
    startedAt: session.startedAt,
  });
});

// Read one session back, for progress and for the result screen.
app.get("/exam/session/:sessionId", (request, response) => {
  const sessions = readSessions();

  const session = sessions.find(
    (item) => item.sessionId === request.params.sessionId
  );

  if (!session) {
    return response.status(404).json({ message: "Session not found" });
  }

  response.json(session);
});

app.listen(PORT, () => {
  console.log(`Athena exam backend running at http://localhost:${PORT}`);
});
