const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 6002;

app.use(cors());
app.use(express.json());

const questionsPath = path.join(__dirname, "data", "questions.json");
const sessionsPath = path.join(__dirname, "data", "sessions.json");

function readQuestions() {
  return JSON.parse(fs.readFileSync(questionsPath, "utf-8"));
}

function readSessions() {
  return JSON.parse(fs.readFileSync(sessionsPath, "utf-8"));
}

// Health check, so the desktop app can confirm the backend is up.
app.get("/", (request, response) => {
  response.json({
    message: "Athena exam backend is running",
    questions: readQuestions().length,
    sessions: readSessions().length,
  });
});

app.listen(PORT, () => {
  console.log(`Athena exam backend running at http://localhost:${PORT}`);
});
