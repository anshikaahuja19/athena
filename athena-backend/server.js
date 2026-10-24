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

// Accepts 2 and "2", rejects null, true, "" and anything fractional,
// all of which Number() would otherwise turn into a usable index.
function readIndex(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : null;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  }

  return null;
}

// The answer key never leaves the server.
function questionForStudent(question) {
  return {
    id: question.id,
    question: question.question,
    options: question.options,
  };
}

// Health check, so the desktop app can confirm the backend is up.
app.get("/", (request, response) => {
  response.json({
    message: "Athena exam backend is running",
    questions: readQuestions().length,
    sessions: readSessions().length,
  });
});

// Every question, without the answer key.
app.get("/exam/mcq", (request, response) => {
  response.json(readQuestions().map(questionForStudent));
});

// One question, without the answer key.
app.get("/exam/mcq/:id", (request, response) => {
  const question = readQuestions().find(
    (item) => item.id === Number(request.params.id)
  );

  if (!question) {
    return response.status(404).json({ message: "Question not found" });
  }

  response.json(questionForStudent(question));
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

// Record one answer. Scoring happens here, as each answer arrives, so
// a crash part way through an exam does not lose the earlier ones.
app.post("/exam/answer", (request, response) => {
  const body = request.body ?? {};

  const sessionId = readTrimmed(body, "sessionId");
  const questionId = readIndex(body.questionId);
  const selectedAnswer = readIndex(body.selectedAnswer);

  if (!sessionId || questionId === null || selectedAnswer === null) {
    return response.status(400).json({
      message: "sessionId, questionId and selectedAnswer are required",
    });
  }

  const question = readQuestions().find((item) => item.id === questionId);

  if (!question) {
    return response.status(404).json({ message: "Question not found" });
  }

  if (selectedAnswer < 0 || selectedAnswer >= question.options.length) {
    return response.status(400).json({
      message: "selectedAnswer is not one of the options",
    });
  }

  const sessions = readSessions();

  const session = sessions.find((item) => item.sessionId === sessionId);

  if (!session) {
    return response.status(404).json({ message: "Session not found" });
  }

  if (session.status !== "in-progress") {
    return response.status(400).json({ message: "Exam is already submitted" });
  }

  if (session.answers.some((answer) => answer.questionId === questionId)) {
    return response.status(400).json({ message: "Question already answered" });
  }

  const isCorrect = selectedAnswer === question.correctAnswer;

  session.answers.push({
    questionId,
    selectedAnswer,
    isCorrect,
    answeredAt: new Date().toISOString(),
  });

  session.attempted += 1;

  if (isCorrect) {
    session.correct += 1;
  } else {
    session.wrong += 1;
  }

  saveSessions(sessions);

  // Whether the answer was right is withheld until the exam is submitted.
  response.json({
    message: "Answer saved",
    attempted: session.attempted,
  });
});

// Finish the exam and hand back the score.
app.post("/exam/submit", (request, response) => {
  const body = request.body ?? {};

  const sessionId = readTrimmed(body, "sessionId");

  if (!sessionId) {
    return response.status(400).json({ message: "sessionId is required" });
  }

  const sessions = readSessions();

  const session = sessions.find((item) => item.sessionId === sessionId);

  if (!session) {
    return response.status(404).json({ message: "Session not found" });
  }

  if (session.status !== "in-progress") {
    return response.status(400).json({ message: "Exam is already submitted" });
  }

  session.status = "submitted";
  session.submittedAt = new Date().toISOString();

  saveSessions(sessions);

  response.json({
    message: "Exam submitted",
    result: {
      total: readQuestions().length,
      attempted: session.attempted,
      correct: session.correct,
      wrong: session.wrong,
    },
  });
});

// Malformed JSON and unexpected faults should answer with JSON too.
// Express would otherwise return an HTML page containing a stack trace.
app.use((error, request, response, next) => {
  console.error("Request failed:", error.message);

  response.status(error.status || 500).json({
    message: "Request could not be processed",
  });
});

app.listen(PORT, () => {
  console.log(`Athena exam backend running at http://localhost:${PORT}`);
});
