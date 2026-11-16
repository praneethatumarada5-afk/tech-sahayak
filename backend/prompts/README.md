# TechSahayak: AI tutor layer (prompts + Gemini), Phase 1

> **Backend team: start with `HANDOFF.md`.** This README is the full document of the prompt team. This handoff folder contains only the AI layer itself, so the developer tools it mentions are **not included**: `npm run chat`, `chat:mock`, `web`, `server`, `test`, `scenarios`, `src/mockData.js`, `chat.js`, `server.js`, `tests/`. Only `npm run check` works here. Everything else (sections 1, 7 and the tuning parts) is for the prompt team.


Apps covered: **PhonePe, Flipkart, Rapido, Swiggy**. Works in English, Hindi, Bengali, Tamil, Telugu and Marathi (same six languages as the `languages` table in the database). Text and voice modes.

## 1. Run it in 2 minutes

```bash
cd prompts
npm install
cp .env.example .env        # then paste your key from https://aistudio.google.com/apikey
npm run chat                # chatbot in the terminal
```

No key yet? `npm run chat:mock` runs everything except the real Gemini call. `npm test` runs offline checks.

Inside the chat, type `/help`. Useful ones: `/user 1-4` (Hindi beginner, Bengali beginner, Tamil intermediate, English advanced), `/app swiggy`, `/mode voice`, `/again` (the "Explain again" button), `/prompt` (shows exactly what is sent to Gemini), `/todo` (things still to verify on the real apps).

The learners in the chat are **temporary data** in `src/mockData.js`. It copies the column names of `techsahayak.sql`, so real DB rows can replace it.

### Reading replies properly (Indian scripts)
Terminals cannot draw Telugu, Hindi, Tamil or Bengali correctly (the letters must join), so replies can look broken even though the text is fine. Two fixes:
- **`npm run web`**, then open http://localhost:3001 : a chat page in the browser with learner/app/language/level/mode dropdowns, a mic button, a "Listen" button and "Explain again". This is the easiest way to test.
- **Terminal chat** also saves everything to `logs/chat.html` (open it once in your browser, it refreshes itself) and `logs/chat.txt`. `npm run scenarios` saves to `logs/scenarios.html`.

**Something not working?** Run `npm run check`. It makes one Gemini call and tells you in plain English whether the key, the model name or the internet connection is the problem.

## 2. Folder map

```
prompts/
├─ persona/system_persona.md       Who Sahayak is: tone, teaching method, scope, honesty
├─ rules/
│   ├─ safety_rules.md             Never ask for PIN/OTP, scam rules, "I already got scammed" steps
│   ├─ response_format_text.md     Length/format when typing
│   └─ response_format_voice.md    Speech-friendly replies (no markdown, short, numbers in words)
├─ levels/                         beginner / intermediate / advanced teaching rules + age_groups.json
├─ apps/                           phonepe.md flipkart.md rapido.md swiggy.md  + registry.json + no_app.md
├─ languages/languages.json        Mirrors DB `languages`, plus speech locale, greetings, error messages
├─ templates/                      user_context.md (filled from DB data), explain_again.md,
│                                  sensitive_data_notice.md, few_shot_examples.md
├─ src/
│   ├─ tutor.js                    ← THE FILE THE BACKEND USES (createSession, ask, explainAgain, greet)
│   ├─ promptBuilder.js            Assembles the system prompt from the files above
│   ├─ gemini.js                   Gemini call, retries, error codes
│   ├─ safety.js                   Removes PIN/OTP/card/Aadhaar digits before Gemini and before saving
│   ├─ history.js                  DB chat history → Gemini format
│   └─ mockData.js                 Temporary learners/lessons for testing
├─ chat.js                         Terminal chatbot (also writes logs/chat.html: open it in your browser to read Indian scripts properly)
├─ server.js                       Tiny demo HTTP API (shows the backend how to call this)
├─ tests/                          prompts.test.js (offline), scenarios.js (live Gemini, read the answers)
```

## 3. How a reply is produced

For every question the system prompt is assembled in this order:

1. persona → 2. safety rules → 3. text or voice format → 4. the learner's level → 5. example replies → 6. **learner facts from the DB** (name, skill level, age group, language, mode, lesson, completed lessons) → 7. **knowledge page of the app** being learned.

Then the last 12 chat messages plus the new question are sent to Gemini. Also built in:

- **Secrets are removed first.** A PIN, OTP, CVV, card number or Aadhaar number typed by the learner is replaced by `[REMOVED]` before Gemini sees it and before it is saved. Sahayak then gently tells them never to share it.
- **App switching.** If the learner names another app ("how do I pay Swiggy with PhonePe?"), the right knowledge page is added, and `appSwitched` tells the frontend to change tabs.
- **Explain again.** `explainAgain()` re-teaches the last answer with different words and fewer steps. The button press is saved as a hidden `[Explain again]` learner message, so repeated presses make the next explanation simpler, and the prompt tells Gemini how many presses happened. Asking the same thing again in new words is handled by an instruction in the persona (new comparison, fewer steps).
- **If Gemini fails** (rate limit, no network), the learner gets a kind fallback message in their language, and `error` explains the cause to the developer. Nothing wrong is saved to the DB.

## 4. Plugging into the Node.js backend

Copy the `prompts/` folder into the backend repo (or `npm link` it) and install its dependencies. The DB is SQLite with Python helper files, so the backend needs its own SQLite access (for example `better-sqlite3`). This layer is DB-agnostic: it takes plain objects shaped like the DB rows.

```js
const tutor = require('./prompts/src/tutor');

// POST /api/tutor/chat   body: { conversationId, message, appSlug, mode }
app.post('/api/tutor/chat', async (req, res) => {
  const { conversationId, message, appSlug, mode } = req.body;
  const user = db.getUser(req.userId);                       // row from `users` table
  const history = db.getHistory(conversationId, 50);         // rows from tutor_messages: {sender, message_text}
  const session = tutor.createSession({
    user,                                                    // uses skill_level, age_group, full_name, preferred_language_id
    appSlug,                                                 // 'phonepe' | 'flipkart' | 'rapido' | 'swiggy' | null (the tab)
    lesson: db.getLesson(req.body.lessonId),                 // optional {slug, title, description, difficulty, estimated_minutes}
    progress: { completed: ['…titles'], in_progress: ['…'] },// optional, from user_lesson_progress
    mode,                                                    // 'text' | 'voice'
    history,
  });
  const out = await tutor.ask(session, message);
  for (const m of out.messagesToSave) db.saveMessage(conversationId, m.sender, m.text);  // sender is 'user' or 'tutor', as in the DB
  res.json({ reply: out.reply, appSlug: out.appSlug, appSwitched: out.appSwitched, error: out.error });
});
```

What `ask()` returns: `reply`, `language` (`{code, language_id, speech_locale}`: use it to pick the speech voice and the language dropdown), `appSlug`, `appSwitched`, `redacted` (kinds of secrets removed), `messagesToSave`, `error` (only on failure), `usage`, `truncated` (true if the reply hit the token cap).

Other calls: `tutor.greet(session)` (fixed welcome in the learner's language, costs no API quota), `tutor.explainAgain(session)`.

Want to try the HTTP shape without writing anything? `npm run server`, then:

```bash
curl -X POST localhost:3001/api/tutor/chat -H 'Content-Type: application/json' \
  -d '{"userId":1,"appSlug":"phonepe","mode":"text","message":"दुकान पर पेमेंट कैसे करूँ?"}'
```

### Mapping to the database

| Prompt input | DB source |
|---|---|
| `user.full_name / skill_level / age_group` | `users` |
| language | `users.preferred_language_id` → `languages` (ids 1 to 6 match `languages.json`) |
| `history` | `tutor_messages` (`sender` 'user'/'tutor') via `tutor.get_history()` |
| `lesson` | `lessons` + `lesson_translations` |
| `progress` | `user_lesson_progress` joined to lesson titles |
| app | `apps/registry.json` links app slugs to `lessons.slug` and `categories.slug` |

## 5. Things the DB teammate may want

`suggested_db_seed.sql` (not in this handoff; ask the prompt team) adds the categories `shopping`, `travel`, `food-delivery` and the lessons `order-on-flipkart`, `book-rapido-ride`, `order-on-swiggy`, and renames the UPI lesson to PhonePe. It was tested against the real `techsahayak.sql` schema. If you use different slugs, only `apps/registry.json` needs editing.

## 6. Voice input and output

The AI layer already writes voice-friendly replies when `mode: 'voice'` (plain spoken sentences, no symbols, amounts in words).
The frontend does the speech part, with the browser's Web Speech API:

- Speech to text: `new SpeechRecognition().lang = language.speech_locale` (`hi-IN`, `bn-IN`, `ta-IN`, `te-IN`, `mr-IN`, `en-IN`), then send the transcript as `message` with `mode: 'voice'`.
- Text to speech: `speechSynthesis.speak(new SpeechSynthesisUtterance(reply))` with the same locale.
- `languages.json` has the locale for every language. Test on the phones you expect: availability of Indian-language voices varies by device and browser. Speech-to-text may mishear, so the voice prompt asks the learner to repeat when the question looks odd.

## 7. Tuning the prompts (your main job)

- Edit any `.md` file and ask again in `npm run chat`. Files are re-read on every message.
- `npm run scenarios` sends 16 tricky questions to Gemini (scams, secrets, off-topic, prompt injection, unknown facts, distress). **Read the answers** and fix the prompt where they are wrong. Add your own cases at the bottom of `tests/scenarios.js`.
- **App pages must be checked against the real apps.** They were written from public information and standard UPI/app behaviour. Exact button names change with versions, so uncertain spots are tagged `[CHECK]` (about 29). `/todo` in the chat lists them. Open each app, compare, correct the page, delete the tag. The tags and `<!-- -->` notes are stripped automatically and never reach Gemini.
- Tests (`npm test`) check that every language × level × app × mode builds a clean prompt, the secret remover works, history formatting is right and app switching works.

## 8. Gemini notes

- Default model is `gemini-3.5-flash` (tested working; `gemini-3.8-flash` gave 504 timeouts on the free key) (set `GEMINI_MODEL` in `.env`). Model names and free-tier limits change, so check the current list in Google AI Studio and change the name there if needed.
- The free tier limits requests per minute and per day. `gemini.js` retries rate-limit and overload errors up to 3 times. Greetings are fixed text so they use no quota.
- Free-tier data may be used by Google to improve its products, which is one more reason this layer strips secrets first. Do not put real user data in the prompts.
- **Slow or stuck replies:** every Gemini call now gives up after 30 s (change with `GEMINI_TIMEOUT_MS` in `.env`) and reports `TIMEOUT` instead of waiting forever. `npm run check` prints "Calling Gemini..." and then the time it took. Keys that start with `AQ.` are Google's new AI Studio key format and are normal; if one is rejected with 400/401, create a new key at https://aistudio.google.com/apikey.
- Thinking tokens count against the reply's token cap (`MAX_OUTPUT_TOKENS` in `src/config.js`). `gemini.js` therefore turns thinking off on 2.5 Flash (`thinkingBudget: 0`) and sets `thinkingLevel: 'low'` on Gemini 3.x (3.8 Flash defaults to "medium" and rejects "minimal"). If a reply ever looks cut off, `ask()` returns `truncated: true`.
- Whether a given model is on the **free** tier was not stated in Google's pricing pages when this was checked (they list paid pricing). If the free key gives a quota or 404 error on it, set `GEMINI_MODEL` in `.env` to a model that AI Studio shows as free.

## 9. Known limits (Phase 1)

- The AI never sees the learner's real screen. It only knows what they type or say, and what the app pages say.
- The secret remover catches common patterns (Luhn-valid card numbers, Verhoeff-valid Aadhaar, digits next to PIN/OTP/CVV words). It cannot catch everything, so the prompt also tells the model never to ask for secrets.
- Confusion detection (Phase 2) is not built. The "explain again" button and the learner's own words drive adaptation for now.

## 10. Reply language rule (for the frontend and backend teams)

Sahayak always replies in the learner's **saved** language (`users.preferred_language_id`), whatever language they type or speak. It switches only if the learner clearly asks ("reply in Hindi"), and only for the rest of that chat.
- **Backend:** pass the `users` row to `createSession`. Language is read from `preferred_language_id`, and you can override it with the `language` argument.
- **Frontend:** add a language selector. When it changes, call the DB's `users.set_language(user_id, language_id)` so the choice is saved, and use `out.language.speech_locale` for speech recognition and speech output.
- **Privacy:** the `logs/` and `transcripts/` folders contain real conversations. They are for development only, are git-ignored, and must never be deployed.
