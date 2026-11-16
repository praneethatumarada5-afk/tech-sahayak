"use strict";
const crypto = require("crypto");
const { promisify } = require("util");
const express = require("express");
const db = require("./db");

const scrypt = promisify(crypto.scrypt);

/* DEMO_OTP=1 (default): the forgot-password code is printed in the server window and also sent back
   to the page, so you can test without an SMS service. Set DEMO_OTP=0 in .env only after you have
   connected a real SMS / email service inside deliverOtp() below. */
const DEMO_OTP = process.env.DEMO_OTP !== "0";

const PHONE_RE = /^[6-9]\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PROGRESS_RE = /^(phonepe|flipkart|rapido|swiggy)\/(beginner|intermediate|advanced)$/;

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/* ---------- passwords (never stored as plain text) ---------- */
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const h = (await scrypt(pw, salt, 32)).toString("hex");
  return "scrypt$" + salt + "$" + h;
}
async function verifyPassword(pw, stored) {
  const [alg, salt, h] = String(stored || "").split("$");
  if (alg !== "scrypt" || !salt || !h) return false;
  const test = await scrypt(pw, salt, 32);
  const want = Buffer.from(h, "hex");
  return want.length === test.length && crypto.timingSafeEqual(want, test);
}

/* ---------- stop password guessing: 8 wrong tries locks that login for 5 minutes ---------- */
const fails = new Map();
const isLocked = (k) => { const f = fails.get(k); return !!(f && f.until > Date.now()); };
function recordFail(k) {
  const f = fails.get(k) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 8) { f.until = Date.now() + 5 * 60000; f.n = 0; }
  fails.set(k, f);
}

/* ---------- middleware: who is calling? ---------- */
function tokenFrom(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
  return m ? m[1].trim() : "";
}
function requireAuth(req, res, next) {
  const token = tokenFrom(req);
  const user = token ? db.userFromToken(token) : null;
  if (!user) return res.status(401).json({ ok: false, error: "login_required", answer: "Please log in to use the tutor." });
  req.user = user;
  req.token = token;
  next();
}

const router = express.Router();

/* ---------- sign up ---------- */
router.post("/signup", async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || "").trim().slice(0, 80);
  const phone = db.normPhone(b.phone);
  const email = String(b.email || "").trim().toLowerCase().slice(0, 120);
  const password = String(b.password || "");
  if (name.length < 2 || !PHONE_RE.test(phone) || (email && !EMAIL_RE.test(email)) || password.length < 6 || password.length > 200) {
    return res.status(400).json({ ok: false, error: "invalid" });
  }
  if (db.findUserByPhone(phone)) return res.status(409).json({ ok: false, error: "phone_taken" });
  if (email && db.findUserByEmail(email)) return res.status(409).json({ ok: false, error: "email_taken" });
  try {
    const id = db.createUser({ name, phone, email: email || phone + "@phone.local", passwordHash: await hashPassword(password) });
    const token = db.createSession(id, 30);
    const row = db.findUserByPhone(phone);
    res.json({ ok: true, token, user: db.publicUser(row) });
  } catch (e) {
    console.error("signup:", e.message);
    if (/UNIQUE|constraint/i.test(e.message)) return res.status(409).json({ ok: false, error: /email/i.test(e.message) ? "email_taken" : "phone_taken" });
    res.status(500).json({ ok: false, error: "storage" });
  }
});

/* ---------- log in ---------- */
router.post("/login", async (req, res) => {
  const b = req.body || {};
  const id = String(b.id || "").trim().toLowerCase();
  const password = String(b.password || "");
  if (!id || !password) return res.status(400).json({ ok: false, error: "bad_login" });
  if (isLocked(id)) return res.status(429).json({ ok: false, error: "bad_login" });
  const user = db.findUserByLogin(id);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    recordFail(id);
    return res.status(401).json({ ok: false, error: "bad_login" });
  }
  fails.delete(id);
  db.touchLogin(user.user_id);
  const token = db.createSession(user.user_id, b.remember ? 30 : 1);
  res.json({ ok: true, token, user: db.publicUser(db.findUserByPhone(user.phone)) });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ ok: true, user: db.publicUser(req.user) });
});

router.post("/logout", requireAuth, (req, res) => {
  db.deleteSession(req.token);
  res.json({ ok: true });
});

router.delete("/me", requireAuth, (req, res) => {
  db.deleteAccount(req.user.user_id);
  res.json({ ok: true });
});

/* ---------- lesson progress (the green ticks) ---------- */
router.post("/progress", requireAuth, (req, res) => {
  const key = String((req.body || {}).key || "");
  if (!PROGRESS_RE.test(key)) return res.status(400).json({ ok: false, error: "invalid" });
  db.markDone(req.user.user_id, key);
  res.json({ ok: true });
});

/* ---------- forgot password with a 6-digit code ---------- */
const otps = new Map(); // user_id -> { hash, exp, tries, sent, resetToken }
const OTP_TTL = 5 * 60000, OTP_GAP = 30000, OTP_TRIES = 5;

function mask(channel, to) {
  if (channel === "sms") return "+91 ******" + to.slice(-4);
  const p = to.split("@");
  return p[0].charAt(0) + "***@" + p[1];
}
async function deliverOtp(channel, to, code) {
  // Connect your SMS / email service here, then set DEMO_OTP=0 in .env.
  throw new Error("No SMS / email service connected yet");
}

router.post("/otp/request", async (req, res) => {
  const id = String((req.body || {}).id || "").trim();
  const user = db.findUserByLogin(id);
  if (!user) return res.status(404).json({ ok: false, error: "no_account" });
  const channel = id.includes("@") ? "email" : "sms";
  const to = channel === "sms" ? user.phone : user.email;
  const prev = otps.get(user.user_id), t = Date.now();
  if (prev && t - prev.sent < OTP_GAP) {
    return res.status(429).json({ ok: false, error: "wait", wait: Math.ceil((OTP_GAP - (t - prev.sent)) / 1000) });
  }
  const code = String(crypto.randomInt(100000, 1000000));
  otps.set(user.user_id, { hash: sha(code), exp: t + OTP_TTL, tries: 0, sent: t, resetToken: null });
  if (DEMO_OTP) {
    console.log("[DEMO OTP] code for " + mask(channel, to) + " is " + code);
    return res.json({ ok: true, channel, masked: mask(channel, to), demoCode: code });
  }
  try {
    await deliverOtp(channel, to, code);
    res.json({ ok: true, channel, masked: mask(channel, to) });
  } catch (e) {
    otps.delete(user.user_id);
    res.status(502).json({ ok: false, error: "send_failed" });
  }
});

router.post("/otp/verify", (req, res) => {
  const b = req.body || {};
  const user = db.findUserByLogin(b.id);
  const rec = user && otps.get(user.user_id);
  if (!rec || Date.now() > rec.exp) { if (user) otps.delete(user.user_id); return res.status(400).json({ ok: false, error: "expired" }); }
  if (rec.tries >= OTP_TRIES) return res.status(429).json({ ok: false, error: "locked" });
  if (sha(String(b.code || "").trim()) !== rec.hash) {
    rec.tries++;
    return res.status(400).json({ ok: false, error: rec.tries >= OTP_TRIES ? "locked" : "wrong", left: Math.max(0, OTP_TRIES - rec.tries) });
  }
  rec.resetToken = crypto.randomBytes(24).toString("hex");
  res.json({ ok: true, resetToken: rec.resetToken });
});

router.post("/otp/reset", async (req, res) => {
  const b = req.body || {};
  const user = db.findUserByLogin(b.id);
  const rec = user && otps.get(user.user_id);
  const password = String(b.password || "");
  if (!rec || !rec.resetToken || Date.now() > rec.exp || rec.resetToken !== String(b.resetToken || "")) {
    return res.status(400).json({ ok: false, error: "expired" });
  }
  if (password.length < 6 || password.length > 200) return res.status(400).json({ ok: false, error: "invalid" });
  db.setPassword(user.user_id, await hashPassword(password));
  db.deleteUserSessions(user.user_id);
  otps.delete(user.user_id);
  res.json({ ok: true });
});

module.exports = { router, requireAuth };