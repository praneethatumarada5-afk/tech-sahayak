"use strict";
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

const db = new Database(path.join(__dirname, "techsahayak_db", "techsahayak.db"), { fileMustExist: true });
db.pragma("foreign_keys = ON");

/* ---------------------------------------------------------------
   One-time setup. Runs every time the server starts and only ADDS
   what the account system needs. It never deletes anything.
   --------------------------------------------------------------- */
function columns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}
function addColumn(table, col, type) {
  if (!columns(table).includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

addColumn("users", "phone", "TEXT");
addColumn("users", "created_ms", "INTEGER");
addColumn("users", "last_login_ms", "INTEGER");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL");

addColumn("tutor_conversations", "title", "TEXT");
addColumn("tutor_conversations", "app_slug", "TEXT");
addColumn("tutor_conversations", "source", "TEXT");
addColumn("tutor_conversations", "updated_ms", "INTEGER");

db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL
)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)");

db.exec(`CREATE TABLE IF NOT EXISTS user_progress (
  user_id INTEGER NOT NULL,
  key     TEXT    NOT NULL,
  done_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
)`);

const now = () => Date.now();
const normPhone = (p) => String(p || "").replace(/\D/g, "").slice(-10);

/* ---------------- languages ---------------- */
function languageId(code) {
  const c = (code || "en").slice(0, 2).toLowerCase();
  const row = db.prepare("SELECT language_id FROM languages WHERE code = ?").get(c);
  return row ? row.language_id : 1;
}

/* ---------------- users ---------------- */
function findUserByPhone(phone) {
  return db.prepare("SELECT * FROM users WHERE phone = ? AND is_active = 1").get(normPhone(phone)) || null;
}
function findUserByEmail(email) {
  return db.prepare("SELECT * FROM users WHERE LOWER(email) = LOWER(?) AND is_active = 1").get(String(email || "").trim()) || null;
}
function findUserByLogin(id) {
  id = String(id || "").trim();
  return id.includes("@") ? findUserByEmail(id) : findUserByPhone(id);
}
function createUser({ name, phone, email, passwordHash }) {
  const t = now();
  const r = db
    .prepare("INSERT INTO users (full_name, email, password_hash, is_active, phone, created_ms, last_login_ms) VALUES (?, ?, ?, 1, ?, ?, ?)")
    .run(name, email, passwordHash, normPhone(phone), t, t);
  return Number(r.lastInsertRowid);
}
function touchLogin(userId) {
  db.prepare("UPDATE users SET last_login_ms = ? WHERE user_id = ?").run(now(), userId);
}
function setPassword(userId, passwordHash) {
  db.prepare("UPDATE users SET password_hash = ? WHERE user_id = ?").run(passwordHash, userId);
}
function progressMap(userId) {
  const out = {};
  db.prepare("SELECT key, done_ms FROM user_progress WHERE user_id = ?").all(userId).forEach((r) => { out[r.key] = r.done_ms; });
  return out;
}
function markDone(userId, key) {
  db.prepare("INSERT OR IGNORE INTO user_progress (user_id, key, done_ms) VALUES (?, ?, ?)").run(userId, key, now());
}
function publicUser(row) {
  const email = row.email && !/@phone\.local$/i.test(row.email) ? row.email : "";
  return {
    id: row.user_id,
    name: row.full_name,
    phone: row.phone || "",
    email,
    created: row.created_ms || 0,
    lastLogin: row.last_login_ms || row.created_ms || 0,
    done: progressMap(row.user_id),
  };
}
/* Deleting an account removes the person's data. The users row is kept but blanked,
   so tables made by other teammates that point to it do not break. */
function deleteAccount(userId) {
  const run = db.transaction(() => {
    deleteAllConversations(userId);
    db.prepare("DELETE FROM user_progress WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    db.prepare("UPDATE users SET full_name = 'Deleted user', email = ?, phone = NULL, password_hash = 'none', is_active = 0 WHERE user_id = ?")
      .run("deleted-" + userId + "@deleted.local", userId);
  });
  run();
}

/* ---------------- login sessions ---------------- */
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

function createSession(userId, days) {
  const token = crypto.randomBytes(32).toString("hex");
  const t = now();
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_ms, expires_ms) VALUES (?, ?, ?, ?)").run(sha(token), userId, t, t + days * 86400000);
  return token;
}
function userFromToken(token) {
  return (
    db
      .prepare("SELECT u.* FROM sessions s JOIN users u ON u.user_id = s.user_id WHERE s.token_hash = ? AND s.expires_ms > ? AND u.is_active = 1")
      .get(sha(token), now()) || null
  );
}
function deleteSession(token) {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(token));
}
function deleteUserSessions(userId) {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}
function purgeExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_ms <= ?").run(now());
}

/* ---------------- conversations (the chat history) ---------------- */
function createConversation(userId, { languageId: langId, title, appSlug, source }) {
  const r = db
    .prepare("INSERT INTO tutor_conversations (user_id, language_id, title, app_slug, source, updated_ms) VALUES (?, ?, ?, ?, ?, ?)")
    .run(userId, langId, title, appSlug || null, source || "chat", now());
  return Number(r.lastInsertRowid);
}
function getConversation(userId, id) {
  return (
    db
      .prepare("SELECT rowid AS id, title, app_slug AS app, source, updated_ms AS updated FROM tutor_conversations WHERE rowid = ? AND user_id = ?")
      .get(id, userId) || null
  );
}
function listConversations(userId) {
  return db
    .prepare(
      "SELECT rowid AS id, title, app_slug AS app, source, updated_ms AS updated FROM tutor_conversations " +
        "WHERE user_id = ? AND title IS NOT NULL ORDER BY COALESCE(updated_ms, 0) DESC, rowid DESC LIMIT 200"
    )
    .all(userId);
}
function getMessages(convId) {
  return db
    .prepare("SELECT message_id AS id, sender, message_text AS text, created_at AS created FROM tutor_messages WHERE conversation_id = ? ORDER BY message_id ASC")
    .all(convId);
}
/* the last few messages, in the shape the tutor layer wants for memory */
function historyForTutor(convId, limit) {
  return db
    .prepare(
      "SELECT sender, message_text FROM (SELECT message_id, sender, message_text FROM tutor_messages WHERE conversation_id = ? ORDER BY message_id DESC LIMIT ?) ORDER BY message_id ASC"
    )
    .all(convId, limit || 16);
}
function addMessages(convId, msgs) {
  const add = db.prepare("INSERT INTO tutor_messages (conversation_id, sender, message_text) VALUES (?, ?, ?)");
  const run = db.transaction(() => msgs.forEach((m) => add.run(convId, m.sender, m.text)));
  run();
}
function touchConversation(convId, { appSlug } = {}) {
  if (appSlug) db.prepare("UPDATE tutor_conversations SET updated_ms = ?, app_slug = ? WHERE rowid = ?").run(now(), appSlug, convId);
  else db.prepare("UPDATE tutor_conversations SET updated_ms = ? WHERE rowid = ?").run(now(), convId);
}
function renameConversation(userId, id, title) {
  return db.prepare("UPDATE tutor_conversations SET title = ? WHERE rowid = ? AND user_id = ?").run(title, id, userId).changes > 0;
}
function deleteConversation(userId, id) {
  const run = db.transaction(() => {
    const c = getConversation(userId, id);
    if (!c) return false;
    db.prepare("DELETE FROM tutor_messages WHERE conversation_id = ?").run(id);
    db.prepare("DELETE FROM tutor_conversations WHERE rowid = ? AND user_id = ?").run(id, userId);
    return true;
  });
  return run();
}
function deleteAllConversations(userId) {
  const run = db.transaction(() => {
    db.prepare("DELETE FROM tutor_messages WHERE conversation_id IN (SELECT rowid FROM tutor_conversations WHERE user_id = ?)").run(userId);
    db.prepare("DELETE FROM tutor_conversations WHERE user_id = ?").run(userId);
  });
  run();
}
function recentMessagesForUser(userId) {
  return db
    .prepare(
      "SELECT m.message_id, m.conversation_id, m.sender, m.message_text, m.created_at FROM tutor_messages m " +
        "JOIN tutor_conversations c ON c.rowid = m.conversation_id WHERE c.user_id = ? ORDER BY m.message_id DESC LIMIT 10"
    )
    .all(userId);
}

module.exports = {
  languageId, normPhone,
  findUserByPhone, findUserByEmail, findUserByLogin, createUser, touchLogin, setPassword,
  progressMap, markDone, publicUser, deleteAccount,
  createSession, userFromToken, deleteSession, deleteUserSessions, purgeExpiredSessions,
  createConversation, getConversation, listConversations, getMessages, historyForTutor,
  addMessages, touchConversation, renameConversation, deleteConversation, deleteAllConversations,
  recentMessagesForUser,
};