# For the backend teammate: how to use the AI layer

1. Put this `prompts/` folder inside the backend project and run `npm install` inside it.
2. Copy `.env.example` to `.env` and put the real Gemini key in `.env` (never commit it; the key must live on the server only).
3. Check the setup: `npm run check` (should print "everything works").
4. In your route, use only `src/tutor.js`:

```js
const tutor = require('./prompts/src/tutor');

app.post('/api/tutor/chat', async (req, res) => {
  const { conversationId, message, appSlug, mode } = req.body;      // appSlug: phonepe | flipkart | rapido | swiggy | null
  const user = db.getUser(req.userId);                              // users row: full_name, skill_level, age_group, preferred_language_id
  const history = db.getHistory(conversationId, 50);                // tutor_messages rows: { sender: 'user'|'tutor', message_text }
  const session = tutor.createSession({ user, appSlug, mode, history /*, lesson, progress */ });
  const out = await tutor.ask(session, message);
  for (const m of out.messagesToSave) db.saveMessage(conversationId, m.sender, m.text);
  res.json({ reply: out.reply, appSlug: out.appSlug, appSwitched: out.appSwitched, language: out.language, error: out.error });
});
```
Other calls: `tutor.greet(session)` (fixed welcome, no API call) and `tutor.explainAgain(session)` (the "explain again" button).

`ask()` returns: `reply`, `language` ({code, language_id, speech_locale}), `appSlug`, `appSwitched`, `redacted`, `messagesToSave`, `error` (only on failure; `reply` then holds a polite fallback message in the learner's language).

Notes
- `history` must be oldest first. Only the last 12 messages go to Gemini, so fetching 50 is plenty.
- **Explain again:** `explainAgain()` returns two items in `messagesToSave`: a learner message with text `[Explain again]` (and `kind: 'explain_again'`) and the tutor's reply. Save both. The marker is how the AI knows the learner needed a repeat (it gets simpler each time), so keep it in the DB history, but the frontend should hide it from the chat window.
- `ask()` also returns `truncated` (true if the reply hit the token cap; please log it) and `usage`.
- Call `tutor.greet(session)` when a chat opens and save its `messagesToSave` too, so the saved history matches what the learner saw.
- The tutor does not need any DB rows to work: pass `appSlug` (`phonepe`, `flipkart`, `rapido`, `swiggy`) directly. Only if you want it to pick the app from a lesson or category, make the DB slugs match `apps/registry.json`, or edit the slugs in that file.
- Only `npm run check` exists in this folder. The chat tester, tests and mock data stay with the prompt team.
- Reply language is always the learner's saved language (`users.preferred_language_id`). The frontend needs a language selector that updates the DB.
- Secrets (PIN/OTP/card/Aadhaar digits) are removed from messages before the AI call and before `messagesToSave`.
- Free Gemini keys have low limits and Google may use free-tier prompts to improve its products. Do not send real user data on a free key in production.
- More details: README.md (sections 3, 4, 6, 10).
