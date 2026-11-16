'use strict';
/** One-call check of your Gemini setup. Run:  npm run check   (prints plain English only, safe for any terminal) */
const config = require('./src/config');
const { generate, modelName } = require('./src/llm');

(async () => {
  const key = config.API_KEY;
  console.log('Model            :', modelName());
  console.log('API key found    :', key ? `yes (${key.length} characters, starts with "${key.slice(0, 4)}")` : 'NO  -> add GEMINI_API_KEY to your .env file');
  console.log('Mock mode        :', config.MOCK ? 'ON  -> set MOCK_LLM=0 in .env' : 'off (good)');
  if (config.MOCK || !key) process.exit(1);
  try {
    console.log(`Calling Gemini (gives up after ${config.REQUEST_TIMEOUT_MS / 1000} s)...`);
    const t = Date.now();
    const out = await generate({ systemInstruction: 'Reply with exactly one word.', contents: [{ role: 'user', parts: [{ text: 'Say OK' }] }], mode: 'text' });
    console.log(`Gemini replied   : "${out.text}" in ${Date.now() - t} ms`);
    console.log('\nRESULT: everything works.');
  } catch (e) {
    console.log('Gemini call FAILED:', e.code, '-', e.message);
    const hint = {
      GOOGLE_BUSY: 'Your internet and key are fine: Google answered, but its servers were too busy or slow for this model (error 504/503). Run the check again in a minute. If it keeps happening, put a different model in .env, e.g. GEMINI_MODEL=gemini-2.5-flash or gemini-3.5-flash (see the list in AI Studio).',
      TIMEOUT: 'Gemini did not answer in time. Google is probably unreachable from this network (VPN, college/office Wi-Fi, firewall, proxy or antivirus). Try mobile hotspot, turn VPN off, and check https://aistudio.google.com opens in your browser. If it opens fine, check the key (see the note on AQ. keys in the README).',
      NO_API_KEY: 'The key is missing. Check the .env file is inside the prompts folder.',
      BAD_REQUEST_OR_KEY: 'The key looks wrong or was disabled. Create a new key at https://aistudio.google.com/apikey and paste it in .env without spaces.',
      MODEL_NOT_FOUND: 'The model name is not available. Check AI Studio for a current model and set GEMINI_MODEL in .env.',
      RATE_LIMITED: 'Free-tier limit reached. Wait a minute (or until tomorrow if the daily limit is used up).',
    }[e.code] || 'Look at the [cause: ...] above. ENOTFOUND or ETIMEDOUT = internet, VPN, firewall or proxy blocking Google. A certificate error = antivirus or company network inspecting traffic.';
    console.log('What to do       :', hint);
    process.exit(1);
  }
})();
