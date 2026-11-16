'use strict';
/**
 * Builds the Gemini "system instruction" from the markdown files in this folder
 * plus the learner's data (same fields as the TechSahayak database).
 *
 * Order matters: general rules first, learner + app facts LAST (models pay most attention to the end).
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { fill } = require('./template');

const cache = new Map();
function readRaw(rel) {
  const file = path.join(config.ROOT, rel);
  if (cache.has(file)) return cache.get(file);
  const raw = fs.readFileSync(file, 'utf8');
  // Cache only in production, so prompt edits show up instantly while you are tuning.
  if (process.env.NODE_ENV === 'production') cache.set(file, raw);
  return raw;
}
// Markdown files may hold team-only notes: <!-- comments --> and [CHECK ...] markers. Never send those to the model.
function readText(rel) {
  return readRaw(rel)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/[ \t]*\[CHECK[^\]]*\]/g, '')
    .replace(/(?<!\.)\.\.(?!\.)/g, '.')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
const readJson = (rel) => JSON.parse(readRaw(rel));

// ---------- languages (mirror of the DB `languages` table) ----------
function getLanguages() { return readJson('languages/languages.json').languages; }
/** Accepts a language_id (number), a code ('hi'), or a language object. Falls back to English. */
function getLanguage(idOrCode) {
  const all = getLanguages();
  if (idOrCode && typeof idOrCode === 'object') {
    return all.find((l) => l.code === idOrCode.code || l.language_id === idOrCode.language_id) || all[0];
  }
  return all.find((l) => l.language_id === Number(idOrCode) || l.code === idOrCode) || all[0];
}

// ---------- apps ----------
function getApps() { return readJson('apps/registry.json').apps; }
function getApp(slug) { return getApps().find((a) => a.slug === slug) || null; }
/** Which app does this lesson slug / category slug belong to? */
function findAppByLessonSlug(slug) { return getApps().find((a) => a.lesson_slugs.includes(slug)) || null; }
/** Apps mentioned by name in a learner message (English or native-script names). */
function detectApps(text) {
  const t = String(text || '').toLowerCase();
  return getApps()
    .filter((a) => a.aliases.some((al) => t.includes(al.toLowerCase())))
    .map((a) => a.slug);
}

function firstName(user) {
  const n = String((user && user.full_name) || '').trim().split(/\s+/)[0];
  return n || 'friend';
}

function describeProgress(progress) {
  if (!progress) return 'No history available yet.';
  const done = (progress.completed || []).filter(Boolean);
  const doing = (progress.in_progress || []).filter(Boolean);
  const parts = [];
  if (done.length) parts.push(`Completed lessons: ${done.join(', ')}.`);
  if (doing.length) parts.push(`Currently in progress: ${doing.join(', ')}.`);
  return parts.length ? parts.join(' ') : 'Just starting. No lessons completed yet.';
}

/**
 * @param {object} ctx
 * @param {object} ctx.user      row from `users` ({full_name, skill_level, age_group})
 * @param {object} ctx.language  language object or id/code (see getLanguage)
 * @param {string|null} ctx.appSlug  'phonepe' | 'flipkart' | 'rapido' | 'swiggy' | null
 * @param {string[]} [ctx.extraAppSlugs] other apps mentioned in the same question (knowledge added too)
 * @param {object|null} ctx.lesson   {title, description, difficulty, estimated_minutes} (optional)
 * @param {object|null} ctx.progress {completed:[titles], in_progress:[titles]} (optional)
 * @param {'text'|'voice'} ctx.mode
 * @param {number} [ctx.explainTotal] times the learner pressed "Explain again" in this chat
 */
function buildSystemInstruction(ctx) {
  const user = ctx.user || {};
  const lang = getLanguage(ctx.language);
  const level = config.VALID_LEVELS.includes(user.skill_level) ? user.skill_level : 'beginner';
  const mode = config.VALID_MODES.includes(ctx.mode) ? ctx.mode : 'text';
  const ages = readJson('levels/age_groups.json');
  const age = ages[user.age_group] || ages.unknown;

  const app = ctx.appSlug ? getApp(ctx.appSlug) : null;
  if (ctx.appSlug && !app) throw new Error(`Unknown app slug "${ctx.appSlug}". Valid: ${getApps().map((a) => a.slug).join(', ')}`);

  const lesson = ctx.lesson;
  const lessonLine = lesson
    ? `"${lesson.title}"${lesson.difficulty ? ` (${lesson.difficulty}` + (lesson.estimated_minutes ? `, about ${lesson.estimated_minutes} minutes)` : ')') : ''}${lesson.description ? `. ${lesson.description}` : ''}`
    : 'none selected';

  const userContext = fill(readText('templates/user_context.md'), {
    first_name: firstName(user),
    skill_level: level,
    age_label: age.label,
    age_note: age.note,
    language_name: lang.name,
    native_name: lang.native_name,
    language_code: lang.code,
    mode,
    app_line: app ? `${app.name} (${app.kind})` : 'not chosen yet',
    lesson_line: lessonLine,
    progress_line: describeProgress(ctx.progress),
    explain_total: ctx.explainTotal || 0,
    explain_hint: (ctx.explainTotal || 0) >= 2 ? '. This learner often needs things said again: keep everything extra simple and slow.' : '',
  });

  // App knowledge: the selected app, plus any other app named in the same question.
  const slugs = [ctx.appSlug, ...(ctx.extraAppSlugs || [])].filter(Boolean);
  const uniqueSlugs = [...new Set(slugs)];
  const appKnowledge = uniqueSlugs.length
    ? uniqueSlugs.map((s) => readText(`apps/${getApp(s).file}`)).join('\n\n---\n\n')
    : readText('apps/no_app.md');

  return [
    readText('persona/system_persona.md'),
    readText('rules/safety_rules.md'),
    readText(`rules/response_format_${mode}.md`),
    readText(`levels/${level}.md`),
    readText('templates/few_shot_examples.md'),
    userContext,
    appKnowledge,
  ].join('\n\n---\n\n');
}

/** List all "[CHECK ...]" markers still left in the app pages = things the team should verify on the real app. */
function listCheckMarkers() {
  const out = [];
  for (const a of getApps()) {
    readRaw(`apps/${a.file}`).split('\n').forEach((line, i) => {
      if (/\[CHECK/.test(line)) out.push(`${a.file}:${i + 1}: ${line.trim()}`);
    });
  }
  return out;
}

module.exports = { buildSystemInstruction, getLanguage, getLanguages, getApps, getApp, findAppByLessonSlug, detectApps, firstName, describeProgress, listCheckMarkers, readText };
