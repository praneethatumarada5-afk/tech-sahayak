require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const db = require("./db");
const { router: authRouter, requireAuth } = require("./auth");
const tutor = require("./prompts/src/tutor");
const { EXPLAIN_MARKER } = require("./prompts/src/history");

const app = express();
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } }); // 5 MB, in memory

app.use(
  cors({
    origin: ["http://localhost:8000", "http://127.0.0.1:8000"],
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json({ limit: "100kb" }));

const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

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

// ---------- accounts: /auth/signup, /auth/login, /auth/me, /auth/logout ... ----------
app.use("/auth", authRouter);

// ---------- AI tutor (login required) ----------
const TUTOR_APPS = ["phonepe", "flipkart", "rapido", "swiggy"];
const LEVELS = ["beginner", "intermediate", "advanced"];
// the page shows **bold** itself, so keep that; only drop single-asterisk italics like *(tip)*
const clean = (s) => String(s || "").replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2").trim();

function makeTitle(text, source, video) {
  if (source === "video" && video && video.title) return Array.from("Video: " + String(video.title)).slice(0, 60).join("");
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const chars = Array.from(t);
  return chars.length > 50 ? chars.slice(0, 47).join("") + "..." : t || "New chat";
}

app.post("/chat", requireAuth, async (req, res) => {
  const { question, app: appKey, level, language, conversationId, source, video, mode } = req.body || {};
  const explain = mode === "explain_again";            // the "Explain again" button
  if (!explain && (!question || !String(question).trim())) {
    return res.status(400).json({ answer: "Please type a question." });
  }
  const q = String(question || "").slice(0, 2000);
  try {
    // continuing an older chat? load it (only if it belongs to this person) and give the tutor its memory
    let conv = null;
    if (conversationId) {
      conv = db.getConversation(req.user.user_id, Number(conversationId));
      if (!conv) return res.status(404).json({ answer: "That chat was not found.", error: "not_found" });
    }
    if (explain && !conv) return res.status(400).json({ answer: "There is nothing to explain again yet.", error: "no_conversation" });
    const history = conv ? db.historyForTutor(conv.id, 16) : [];

    const lvl = String(level || "").toLowerCase();
    const user = {
      full_name: req.user.full_name,
      skill_level: LEVELS.includes(lvl) ? lvl : "beginner",
      preferred_language_id: db.languageId(language),
    };
    const session = tutor.createSession({
      user,
      appSlug: TUTOR_APPS.includes(appKey) ? appKey : (conv && conv.app) || null,
      mode: "text",
      history,
    });
    const out = explain ? await tutor.explainAgain(session) : await tutor.ask(session, q);

    if (out.error) {
      console.error("Tutor error:", out.error.code, out.error.message);
      const status = { RATE_LIMITED: 429, GOOGLE_BUSY: 503, TIMEOUT: 504 }[out.error.code] || 500;
      return res.status(status).json({ answer: clean(out.reply), error: out.error.code });
    }

    const u = out.messagesToSave.find((m) => m.sender === "user");
    const t = out.messagesToSave.find((m) => m.sender === "tutor");
    const userText = u ? u.text : q; // the tutor removes PINs / OTPs before we save
    const tutorText = clean(t ? t.text : out.reply);

    let id = conv ? conv.id : null;
    const title = conv ? conv.title : makeTitle(userText, source, video);
    if (!id) {
      id = db.createConversation(req.user.user_id, {
        languageId: user.preferred_language_id,
        title,
        appSlug: out.appSlug,
        source: source === "video" ? "video" : "chat",
      });
    }
    db.addMessages(id, [
      { sender: "user", text: userText },
      { sender: "tutor", text: tutorText },
    ]);
    db.touchConversation(id, { appSlug: out.appSlug });

    res.json({ answer: tutorText, conversationId: id, title, appSlug: out.appSlug, appSwitched: out.appSwitched });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ answer: "Sorry, the tutor could not answer right now. Please try again." });
  }
});

// ---------- chat history (login required, each person sees only their own) ----------
app.get("/conversations", requireAuth, (req, res) => {
  res.json({ ok: true, conversations: db.listConversations(req.user.user_id) });
});

app.get("/conversations/:id", requireAuth, (req, res) => {
  const conv = db.getConversation(req.user.user_id, Number(req.params.id));
  if (!conv) return res.status(404).json({ ok: false, error: "not_found" });
  const messages = db.getMessages(conv.id).map((m) => ({ ...m, kind: m.sender === "user" && String(m.text).trim() === EXPLAIN_MARKER ? "explain_again" : "message" }));
  res.json({ ok: true, conversation: conv, messages });
});

app.patch("/conversations/:id", requireAuth, (req, res) => {
  const title = String((req.body || {}).title || "").trim().slice(0, 80);
  if (!title) return res.status(400).json({ ok: false, error: "invalid" });
  const ok = db.renameConversation(req.user.user_id, Number(req.params.id), title);
  res.status(ok ? 200 : 404).json({ ok });
});

app.delete("/conversations/:id", requireAuth, (req, res) => {
  const ok = db.deleteConversation(req.user.user_id, Number(req.params.id));
  res.status(ok ? 200 : 404).json({ ok });
});

app.delete("/conversations", requireAuth, (req, res) => {
  db.deleteAllConversations(req.user.user_id);
  res.json({ ok: true });
});

// ---------- speech to text (login required) ----------
app.post("/transcribe", requireAuth, upload.single("audio"), async (req, res) => {
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

// ---------- test route: YOUR last saved messages (login required) ----------
app.get("/queries", requireAuth, (req, res) => res.json(db.recentMessagesForUser(req.user.user_id)));

// any unexpected error becomes a clean JSON reply instead of a web page
app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(err.status || 500).json({ ok: false, error: "server_error", answer: "Something went wrong. Please try again." });
});

// forget login sessions that have expired
db.purgeExpiredSessions();
setInterval(() => db.purgeExpiredSessions(), 3600000).unref();

process.on("unhandledRejection", (e) => console.error("Unhandled promise error:", e && e.message ? e.message : e));
process.on("uncaughtException", (e) => console.error("Unexpected error (server kept running):", e && e.message ? e.message : e));

app.listen(process.env.PORT || 8001, () =>
  console.log("Backend running on http://localhost:" + (process.env.PORT || 8001))
);