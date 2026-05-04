const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require("uuid");
const Groq = require("groq-sdk");
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "systems.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let records = [];
if (fs.existsSync(DB_FILE)) {
  try {
    records = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
  } catch { records = []; }
}

function persist() {
  fs.writeFileSync(DB_FILE, JSON.stringify(records, null, 2));
}
function dbSave(record) {
  records.unshift(record);
  if (records.length > 500) records = records.slice(0, 500);
  persist();
  return record;
}
function dbList(page = 1, limit = 10) {
  const start = (page - 1) * limit;
  const items = records.slice(start, start + limit).map((r) => ({
    id: r.id, task: r.task, title: r.system?.title,
    agentCount: r.system?.agents?.length || 0, createdAt: r.createdAt,
  }));
  return { items, total: records.length, page, limit, pages: Math.ceil(records.length / limit) };
}
function dbGetById(id) { return records.find((r) => r.id === id) || null; }
function dbDeleteById(id) {
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return false;
  records.splice(idx, 1);
  persist();
  return true;
}
function dbStats() {
  return {
    total: records.length,
    latest: records[0]?.createdAt || null,
    topTasks: records.slice(0, 50).map((r) => r.task).reduce((acc, t) => {
      acc[t] = (acc[t] || 0) + 1; return acc;
    }, {}),
  };
}

const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors({ origin: "*" }));
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { error: "Too many requests. Please wait 15 minutes." },
});
app.use("/api/", limiter);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SYSTEM_PROMPT = `You are a multi-agent AI system architect. Given a task, design a multi-agent system as JSON. Return ONLY valid JSON, no markdown, no explanation.

Return this exact structure:
{
  "title": "System name",
  "description": "One sentence overview",
  "agents": [
    {
      "name": "Agent Name",
      "icon": "emoji",
      "role": "What this agent does",
      "input": "What it receives",
      "output": "What it produces",
      "logic": "Decision rule in plain English",
      "failure": "What happens if it fails"
    }
  ],
  "feedbackLoop": "How agents loop back to improve results",
  "scalability": "How to scale this system"
}
Use 4-6 agents. Be specific and practical.`;

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/api/generate", async (req, res) => {
  const { task } = req.body;
  if (!task || typeof task !== "string" || task.trim().length < 3)
    return res.status(400).json({ error: "Please provide a valid task (min 3 characters)." });
  if (task.trim().length > 300)
    return res.status(400).json({ error: "Task too long. Max 300 characters." });
  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Design a multi-agent AI system for: ${task.trim()}` },
      ],
      max_tokens: 1200,
      temperature: 0.7,
    });
    const raw = completion.choices[0]?.message?.content || "";
    const clean = raw.replace(/```json|```/g, "").trim();
    const system = JSON.parse(clean);
    if (!system.title || !Array.isArray(system.agents) || system.agents.length === 0)
      throw new Error("Invalid structure.");
    const record = { id: uuidv4(), task: task.trim(), system, createdAt: new Date().toISOString() };
    dbSave(record);
    res.json({ success: true, id: record.id, system });
  } catch (err) {
    console.error("Error:", err.message);
    if (err instanceof SyntaxError)
      return res.status(502).json({ error: "AI returned bad data. Try again." });
    res.status(500).json({ error: "Failed to generate. Try again." });
  }
});

app.get("/api/history", (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 10);
  res.json(dbList(page, limit));
});
app.get("/api/history/:id", (req, res) => {
  const record = dbGetById(req.params.id);
  if (!record) return res.status(404).json({ error: "Not found." });
  res.json(record);
});
app.delete("/api/history/:id", (req, res) => {
  const deleted = dbDeleteById(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Not found." });
  res.json({ success: true });
});
app.get("/api/stats", (req, res) => { res.json(dbStats()); });
app.use((req, res) => { res.status(404).json({ error: "Route not found." }); });

app.listen(PORT, () => {
  console.log(`✅ Server running → http://localhost:${PORT}`);
});

module.exports = app;