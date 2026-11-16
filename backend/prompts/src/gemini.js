'use strict';
const config = require('./config');

const { TutorError } = require('./errors');

let client = null;
function getClient() {
  if (!client) {
    const { GoogleGenAI } = require('@google/genai');
    client = new GoogleGenAI({ apiKey: config.API_KEY });
  }
  return client;
}
const isTimeout = (e) => e && (e.name === 'AbortError' || e.name === 'TimeoutError' || /abort|time(d)? ?out|ETIMEDOUT/i.test(`${e.message} ${e.cause?.code || ''} ${e.cause?.message || ''}`));
// Google-side slowness: 504 DEADLINE_EXCEEDED / 503 UNAVAILABLE come back as a JSON string inside the message.
const isOverloaded = (e) => /DEADLINE_EXCEEDED|UNAVAILABLE|"code":\s*(500|503|504)/.test(String(e && e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mockGenerate({ systemInstruction, contents, mode }) {
  const last = contents[contents.length - 1].parts[0].text;
  const lang = (systemInstruction.match(/code "(\w+)"/) || [])[1];
  const level = (systemInstruction.match(/Skill level: (\w+)/) || [])[1];
  const app = (systemInstruction.match(/App being learned now: ([^\n(]+)/) || [])[1];
  return { text: `[MOCK ${mode}/${lang}/${level}/${(app || '').trim()}] You said: "${last.slice(0, 80)}" (prompt ${systemInstruction.length} chars, ${contents.length} turns)`, usage: null };
}

/**
 * Generation settings. "Thinking" tokens are counted against maxOutputTokens, so a tutor reply
 * (short, no deep reasoning needed) must not be allowed to spend its budget on thinking:
 *  - Gemini 2.5 Flash: thinkingBudget 0 switches thinking off.
 *  - Gemini 3.x (3.5 Flash is the default model): thinkingBudget is replaced by thinkingLevel, the default is
 *    "medium", and "minimal" is rejected by 3.8 Flash, so use "low" (the lowest level that works on every 3.x Flash).
 */
function buildGenConfig(systemInstruction, mode = 'text', model = config.MODEL) {
  const genConfig = {
    systemInstruction,
    temperature: config.TEMPERATURE,
    maxOutputTokens: config.MAX_OUTPUT_TOKENS[mode] || config.MAX_OUTPUT_TOKENS.text,
  };
  if (/gemini-2\.5-flash/.test(model)) genConfig.thinkingConfig = { thinkingBudget: 0 };
  else if (/gemini-3/.test(model)) genConfig.thinkingConfig = { thinkingLevel: 'low' };
  genConfig.httpOptions = { timeout: config.REQUEST_TIMEOUT_MS };
  return genConfig;
}

/**
 * Calls Gemini. Retries on rate limit / overload (the free tier is limited, so this matters).
 * @returns {Promise<{text:string, usage:object|null}>}
 */
async function generate({ systemInstruction, contents, mode = 'text' }) {
  if (config.MOCK) return mockGenerate({ systemInstruction, contents, mode });
  if (!config.API_KEY) throw new TutorError('NO_API_KEY', 'GEMINI_API_KEY is not set. Copy .env.example to .env and add your key (or set MOCK_LLM=1).');

  const genConfig = buildGenConfig(systemInstruction, mode);

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await getClient().models.generateContent({ model: config.MODEL, contents, config: genConfig });
      const text = (res.text || '').trim();
      if (!text) {
        const reason = res.candidates?.[0]?.finishReason || res.promptFeedback?.blockReason || 'unknown';
        throw new TutorError('EMPTY_RESPONSE', `Gemini returned no text (reason: ${reason})`);
      }
      // MAX_TOKENS = the reply was cut off. Still returned (better than nothing) but flagged for the developer.
      const truncated = res.candidates?.[0]?.finishReason === 'MAX_TOKENS';
      return { text, usage: res.usageMetadata || null, truncated };
    } catch (err) {
      if (err instanceof TutorError) throw err;
      lastErr = err;
      if (isTimeout(err)) break; // do not retry a call that already waited the full timeout
      const status = err.status || err.code || err?.error?.code;
      if ((isOverloaded(err) || [429, 500, 503, 504].includes(Number(status))) && attempt < 2) { await sleep(1000 * 2 ** attempt); continue; }
      break;
    }
  }
  const status = lastErr?.status || lastErr?.code;
  const code = isTimeout(lastErr) ? 'TIMEOUT' : isOverloaded(lastErr) ? 'GOOGLE_BUSY' : Number(status) === 429 ? 'RATE_LIMITED' : Number(status) === 404 ? 'MODEL_NOT_FOUND' : Number(status) === 400 || Number(status) === 403 ? 'BAD_REQUEST_OR_KEY' : 'GEMINI_ERROR';
  // "fetch failed" hides the real network reason in err.cause (for example ENOTFOUND, ETIMEDOUT, certificate errors)
  const cause = lastErr?.cause ? ` [cause: ${lastErr.cause.code || lastErr.cause.message || lastErr.cause}]` : '';
  throw new TutorError(code, `${lastErr?.message || lastErr}${cause}`);
}

module.exports = { generate, mockGenerate, buildGenConfig, TutorError };
