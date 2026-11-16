'use strict';
/**
 * Removes secrets from learner messages BEFORE they are sent to Gemini or saved to the DB.
 * Covers: card numbers (Luhn-valid), Aadhaar numbers (Verhoeff-valid), and digits written
 * next to words like PIN / OTP / CVV / password (English + Hindi, Bengali, Tamil, Telugu).
 */

// Convert Devanagari, Bengali, Tamil, Telugu digits to 0-9 (Marathi uses Devanagari).
function toAsciiDigits(s) {
  return s.replace(/[०-९০-৯௦-௯౦-౯]/g, (ch) => {
    const c = ch.charCodeAt(0);
    for (const base of [0x0966, 0x09e6, 0x0be6, 0x0c66]) {
      if (c >= base && c < base + 10) return String(c - base);
    }
    return ch;
  });
}

function luhnValid(digits) {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

const VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
function verhoeffValid(digits) {
  let c = 0;
  const rev = digits.split('').reverse();
  for (let i = 0; i < rev.length; i++) c = VD[c][VP[i % 8][Number(rev[i])]];
  return c === 0;
}

const KEYWORDS = '(?:otp|pin|cvv|cvc|password|passcode|ओटीपी|पिन|सीवीवी|पासवर्ड|ওটিপি|পিন|ஓடிபி|பின்|ఓటీపీ|పిన్|ఓటిపి)';
// keyword ... digits   (but not "pin code 400001" / "pincode 400001")
const KEYWORD_THEN_DIGITS = new RegExp(`(${KEYWORDS})(?!\\s*(?:code|कोड))(\\D{0,20}?)(\\d{3,8})`, 'gi');
// digits ... keyword  ("1234 is my pin")
const DIGITS_THEN_KEYWORD = new RegExp(`(\\d{3,8})(\\D{0,14}?)(${KEYWORDS})(?!\\s*(?:code|कोड))`, 'gi');

function redactSensitive(message) {
  let text = toAsciiDigits(String(message ?? ''));
  const found = new Set();

  // 1. Card numbers: 13-19 digits (spaces/hyphens allowed), Luhn-valid
  text = text.replace(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g, (m) => {
    const d = m.replace(/\D/g, '');
    if (d.length >= 13 && d.length <= 19 && luhnValid(d)) { found.add('card number'); return '[CARD NUMBER REMOVED]'; }
    return m;
  });

  // 2. Aadhaar: 12 digits, first digit 2-9, Verhoeff-valid (avoids hiding 12-digit UPI reference numbers)
  text = text.replace(/(?<!\d)\d{4}[ -]?\d{4}[ -]?\d{4}(?!\d)/g, (m) => {
    const d = m.replace(/\D/g, '');
    if (/^[2-9]/.test(d) && verhoeffValid(d)) { found.add('Aadhaar number'); return '[AADHAAR REMOVED]'; }
    return m;
  });

  // 3. PIN / OTP / CVV / password digits
  text = text.replace(KEYWORD_THEN_DIGITS, (_, kw, gap) => { found.add('PIN/OTP/password'); return `${kw}${gap}[REMOVED]`; });
  text = text.replace(DIGITS_THEN_KEYWORD, (_, num, gap, kw) => { found.add('PIN/OTP/password'); return `[REMOVED]${gap}${kw}`; });

  return { text, found: [...found] };
}

module.exports = { redactSensitive, toAsciiDigits, luhnValid, verhoeffValid };
