'use strict';
/**
 * PUBLIC API of the AI layer. The backend only needs this file.
 *
 *   const tutor = require('./prompts/src/tutor');
 *   const session = tutor.createSession({ user, appSlug: 'phonepe', mode: 'text', history });
 *   const out = await tutor.ask(session, 'How do I pay at a shop?');
 *   // out.reply            -> text to show (and speak, in voice mode)
 *   // out.messagesToSave   -> [{sender:'user',text}, {sender:'tutor',text}] for tutor.save_message(...)
 *   // out.appSlug / appSwitched -> keep the frontend tab in sync
 *
 * The session is a plain object: either keep it in memory per conversation, or rebuild it on every
 * request from DB rows (users row + tutor.get_history()). Both work.
 */
const config = require('./config');
const { fill } = require('./template');
const { redactSensitive } = require('./safety');
const { toContents, normalizeHistory, explainStats, EXPLAIN_MARKER } = require('./history');
const { generate, TutorError } = require('./llm');
const pb = require('./promptBuilder');

/** Language info the frontend needs to pick the speech voice and show the right language in its dropdown. */
const langInfo = (session) => ({ code: session.language.code, language_id: session.language.language_id, speech_locale: session.language.speech_locale });

function createSession({ user, language, appSlug = null, lesson = null, progress = null, mode = 'text', history = [] }) {
  if (!user) throw new Error('createSession: "user" is required (a row from the users table)');
  const lang = pb.getLanguage(language ?? user.preferred_language_id ?? 1);
  // If the caller gave a lesson but no app, work the app out from the lesson slug.
  const resolvedApp = appSlug || (lesson && lesson.slug && (pb.findAppByLessonSlug(lesson.slug) || {}).slug) || null;
  if (resolvedApp && !pb.getApp(resolvedApp)) throw new Error(`Unknown app "${resolvedApp}"`);
  return { user, language: lang, appSlug: resolvedApp, lesson, progress, mode: config.VALID_MODES.includes(mode) ? mode : 'text', history: normalizeHistory(history) };
}

/** A fixed welcome message in the learner's language (no API call, costs no quota). */
function greet(session) {
  const app = session.appSlug ? pb.getApp(session.appSlug) : null;
  const tpl = app ? session.language.greeting_with_app : session.language.greeting_no_app;
  const reply = fill(tpl, { name: pb.firstName(session.user), app: app ? app.name : '' });
  session.history.push({ sender: 'tutor', message_text: reply });
  return { reply, appSlug: session.appSlug, language: langInfo(session), messagesToSave: [{ sender: 'tutor', text: reply }] };
}

function failure(session, err) {
  return {
    reply: session.language.fallback_error,
    error: { code: err.code || 'UNKNOWN', message: err.message },
    appSlug: session.appSlug,
    language: langInfo(session),
    messagesToSave: [], // do not store the canned apology as if the tutor had said it
  };
}

/** Which app knowledge pages are needed for this message? May switch session.appSlug. */
function resolveApps(session, text) {
  const mentioned = pb.detectApps(text);
  let appSwitched = false;
  let extra = [];
  if (mentioned.length === 1 && mentioned[0] !== session.appSlug) {
    session.appSlug = mentioned[0]; appSwitched = true;
  } else if (mentioned.length > 1) {
    if (!session.appSlug) { session.appSlug = mentioned[0]; appSwitched = true; }
    extra = mentioned.filter((s) => s !== session.appSlug);
  }
  return { appSwitched, extra };
}

/**
 * Answer one learner message.
 * @param {object} session  from createSession
 * @param {string} message  what the learner typed or said (speech-to-text result)
 * @param {{mode?: 'text'|'voice'}} [opts]  mode can change per message (typed vs. spoken)
 */
async function ask(session, message, opts = {}) {
  const mode = config.VALID_MODES.includes(opts.mode) ? opts.mode : session.mode;
  const { text: clean, found } = redactSensitive(message);
  if (!clean.trim()) return failure(session, { code: 'EMPTY_MESSAGE', message: 'Empty message' });

  const { appSwitched, extra } = resolveApps(session, clean);
  const systemInstruction = pb.buildSystemInstruction({
    user: session.user, language: session.language, appSlug: session.appSlug, extraAppSlugs: extra,
    lesson: session.lesson, progress: session.progress, mode, explainTotal: explainStats(session.history).total,
  });

  let turn = clean;
  if (found.length) {
    turn = fill(pb.readText('templates/sensitive_data_notice.md'), { kinds: found.join(', ') }) + '\n\nLearner message:\n' + clean;
  }

  try {
    const { text, usage, truncated } = await generate({ systemInstruction, contents: toContents(session.history, turn), mode });
    session.history.push({ sender: 'user', message_text: clean }, { sender: 'tutor', message_text: text });
    return {
      reply: text, appSlug: session.appSlug, language: langInfo(session), appSwitched, redacted: found,
      messagesToSave: [{ sender: 'user', text: clean }, { sender: 'tutor', text }], usage, truncated: !!truncated,
    };
  } catch (err) {
    return failure(session, err instanceof TutorError ? err : { code: 'UNKNOWN', message: String(err.message || err) });
  }
}

/** The "Explain again, differently" button: re-teaches the last answer in new words. */
async function explainAgain(session, opts = {}) {
  const mode = config.VALID_MODES.includes(opts.mode) ? opts.mode : session.mode;
  const lastTutor = [...session.history].reverse().find((m) => m.sender === 'tutor');
  if (!lastTutor) return failure(session, { code: 'NOTHING_TO_EXPLAIN', message: 'No earlier tutor message to explain again' });
  const { total, streak } = explainStats(session.history);
  const count = streak + 1;
  const systemInstruction = pb.buildSystemInstruction({
    user: session.user, language: session.language, appSlug: session.appSlug,
    lesson: session.lesson, progress: session.progress, mode, explainTotal: total + 1,
  });
  const note = fill(pb.readText('templates/explain_again.md'), {
    count, extra: count >= 2 ? 'This is a repeat, so go even simpler and slower: one tiny action only. ' : '',
  });
  try {
    const { text, usage, truncated } = await generate({ systemInstruction, contents: toContents(session.history, note), mode });
    // Save the button press as a (hidden) learner message so later calls can see how often it was needed.
    session.history.push({ sender: 'user', message_text: EXPLAIN_MARKER }, { sender: 'tutor', message_text: text });
    return {
      reply: text, appSlug: session.appSlug, language: langInfo(session),
      messagesToSave: [{ sender: 'user', text: EXPLAIN_MARKER, kind: 'explain_again' }, { sender: 'tutor', text }], usage, truncated: !!truncated,
    };
  } catch (err) {
    return failure(session, err instanceof TutorError ? err : { code: 'UNKNOWN', message: String(err.message || err) });
  }
}

module.exports = { createSession, ask, explainAgain, greet, buildSystemInstruction: pb.buildSystemInstruction, getLanguage: pb.getLanguage, getLanguages: pb.getLanguages, getApps: pb.getApps, TutorError };
