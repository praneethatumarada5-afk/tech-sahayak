require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { systemPrompt } = require("./prompt");
const db = require("./db");                       // NEW

const app = express();
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } }); // 5 MB, in memory

app.use(cors({ origin: ["http://localhost:8000", "http://127.0.0.1:8000"] }));
app.use(express.json());

const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const APP_NAMES = {
  phonepe: "PhonePe",
  flipkart: "Flipkart",
  rapido: "Rapido",
  swiggy: "Swiggy / Instamart",
};

async function callGemini(body) {
  const r = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || "Gemini request failed");
  return j.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
}

app.get("/", (req, res) => res.send("Tech-Sahayak backend is running"));

// ---------- Endpoint 2: AI tutor ----------
app.post("/chat", async (req, res) => {
  const { question, app: appKey, level, language } = req.body || {};
  if (!question || !question.trim()) {
    return res.status(400).json({ answer: "Please type a question." });
  }
  if (!KEY) {
    const demo = `(Demo answer) You asked about ${APP_NAMES[appKey] || "the app"} at ${level} level: "${question}". Add GEMINI_API_KEY in .env to get real AI answers.`;
    try { db.saveChat({ question, answer: demo, language }); } catch (e) { console.error("DB save failed:", e.message); }   // NEW
    return res.json({ answer: demo });
  }
  try {
    const answer = await callGemini({
      systemInstruction: { parts: [{ text: systemPrompt(APP_NAMES[appKey] || "the app", level) }] },
      contents: [{ role: "user", parts: [{ text: question }] }],
    });
    try { db.saveChat({ question, answer, language }); } catch (e) { console.error("DB save failed:", e.message); }   // NEW
    res.json({ answer });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ answer: "Sorry, the tutor could not answer right now. Please try again." });
  }
});

// ---------- Endpoint 1: speech to text ----------
app.post("/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ text: "", language: "" });
  if (!KEY) return res.json({ text: "(demo) voice text will appear here", language: "en" });
  try {
    const out = await callGemini({
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: (req.file.mimetype || "audio/webm").split(";")[0], data: req.file.buffer.toString("base64") } },
            { text: 'Transcribe this audio exactly in the language and script that was spoken. Return only JSON like {"text":"...","language":"te"} using a short language code.' },
          ],
        },
      ],
      generationConfig: { responseMimeType: "application/json" },
    });
    const parsed = JSON.parse(out);
    res.json({ text: parsed.text || "", language: parsed.language || "auto" });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ text: "", language: "" });
  }
});

// ---------- Test route: see the last saved messages ----------
app.get("/queries", (req, res) => res.json(db.recentMessages()));   // NEW

app.listen(process.env.PORT || 8001, () =>
  console.log("Backend running on http://localhost:" + (process.env.PORT || 8001))
);