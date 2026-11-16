const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "techsahayak_db", "techsahayak.db"), { fileMustExist: true });
db.pragma("foreign_keys = ON");

function languageId(code) {
  const c = (code || "en").slice(0, 2).toLowerCase();
  const row = db.prepare("SELECT language_id FROM languages WHERE code = ?").get(c);
  return row ? row.language_id : 1;
}

function guestUserId() {
  const u = db.prepare("SELECT user_id FROM users WHERE email = ?").get("guest@local");
  if (u) return u.user_id;
  return db
    .prepare("INSERT INTO users (full_name, email, password_hash, is_active) VALUES ('Guest','guest@local','none',0)")
    .run().lastInsertRowid;
}

function saveChat({ question, answer, language }) {
  const conv = db
    .prepare("INSERT INTO tutor_conversations (user_id, language_id) VALUES (?, ?)")
    .run(guestUserId(), languageId(language)).lastInsertRowid;
  const add = db.prepare("INSERT INTO tutor_messages (conversation_id, sender, message_text) VALUES (?, ?, ?)");
  add.run(conv, "user", question);
  add.run(conv, "tutor", answer);
}

function recentMessages() {
  return db
    .prepare("SELECT message_id, conversation_id, sender, message_text, created_at FROM tutor_messages ORDER BY message_id DESC LIMIT 10")
    .all();
}

module.exports = { saveChat, recentMessages };