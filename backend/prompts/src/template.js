'use strict';
// Tiny {{variable}} filler. Throws on a missing variable so typos never reach Gemini.
function fill(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`Template variable "${key}" was not provided`);
    return String(vars[key]);
  });
}
module.exports = { fill };
