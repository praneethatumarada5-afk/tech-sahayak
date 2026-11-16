'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

module.exports = {
  ROOT: path.join(__dirname, '..'),
  API_KEY: (process.env.GEMINI_API_KEY || '').trim(),
  MODEL: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
  TEMPERATURE: process.env.GEMINI_TEMPERATURE !== undefined ? Number(process.env.GEMINI_TEMPERATURE) : 0.4,
  // MOCK_LLM can be changed at runtime (tests do), so read it lazily.
  get MOCK() { return process.env.MOCK_LLM === '1'; },
  // How many previous messages (user + tutor) are sent to Gemini for context.
  MAX_HISTORY_MESSAGES: 12,
  // Reply size caps. Voice replies are short by design. Thinking tokens and Indian-script text
  // (many tokens per word) both count against this, so keep generous headroom.
  MAX_OUTPUT_TOKENS: { text: 2048, voice: 1024 },
  // Give up on a Gemini call after this long (ms) instead of waiting forever (network blocked, no reply).
  REQUEST_TIMEOUT_MS: Number(process.env.GEMINI_TIMEOUT_MS) || 30000,
  VALID_LEVELS: ['beginner', 'intermediate', 'advanced'],
  VALID_MODES: ['text', 'voice'],
};
