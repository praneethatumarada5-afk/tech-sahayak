'use strict';
const config = require('./config');

/** Accepts DB rows from tutor_messages ({sender:'user'|'tutor', message_text}) or {sender, text}. */
function normalizeHistory(rows) {
  return (rows || [])
    .map((r) => ({ sender: r.sender === 'tutor' ? 'tutor' : 'user', message_text: String(r.message_text ?? r.text ?? '') }))
    .filter((r) => r.message_text.trim());
}

/**
 * DB history -> Gemini `contents`.
 *  - sender 'tutor' becomes role 'model'
 *  - only the last MAX_HISTORY_MESSAGES are kept
 *  - Gemini wants the conversation to start with a user turn, so leading tutor messages (e.g. the greeting) are dropped
 *  - consecutive turns by the same role are merged
 */
function toContents(history, nextUserText) {
  const recent = normalizeHistory(history).slice(-config.MAX_HISTORY_MESSAGES);
  const turns = recent.map((m) => ({ role: m.sender === 'tutor' ? 'model' : 'user', text: m.message_text }));
  if (nextUserText) turns.push({ role: 'user', text: nextUserText });
  while (turns.length && turns[0].role === 'model') turns.shift();
  const merged = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) last.text += '\n\n' + t.text;
    else merged.push({ ...t });
  }
  return merged.map((t) => ({ role: t.role, parts: [{ text: t.text }] }));
}

/** Saved as a learner message when the "Explain again" button is pressed, so the signal survives in the DB history. */
const EXPLAIN_MARKER = '[Explain again]';
const isMarker = (m) => m.sender === 'user' && m.message_text.trim() === EXPLAIN_MARKER;

/** How many times the button was pressed in this history, and how many times in a row since the last real question. */
function explainStats(history) {
  const h = normalizeHistory(history);
  const total = h.filter(isMarker).length;
  let streak = 0;
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i].sender === 'tutor') continue;
    if (isMarker(h[i])) streak++; else break;
  }
  return { total, streak };
}

module.exports = { normalizeHistory, toContents, explainStats, EXPLAIN_MARKER };
